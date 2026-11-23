import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  checkLoginRateLimit,
  claimInitialDashboardPassword,
  clearLoginRateLimit,
  generateAndStoreWebhookSecret,
  getWebhookSecretSource,
  isDashboardClaimed,
  isEnvDashboardPasswordConfigured,
  issueDashboardToken,
  requireDashboardAuth,
  verifyDashboardPassword,
  verifyWebhookRequest,
} from './server/auth.ts';
import {
  createQueuedOrder,
  getAppConfig,
  getOrderByOrderId,
  getOrderLogs,
  getOrderStats,
  listOrders,
  queueManualRetry,
  updateAppConfig,
} from './server/db.ts';
import { formatArabicOrderMessage } from './server/formatter.ts';
import { logger } from './server/logger.ts';
import { validateReceiptInputSafety } from './server/media.ts';
import { normalizeWhatsAppDigits, toWhatsAppJid } from './server/phone.ts';
import { queueWorker } from './server/queue.ts';
import {
  authPasswordSchema,
  configUpdateSchema,
  incomingOrderSchema,
  testMessageSchema,
} from './server/validation.ts';
import { whatsappService } from './server/whatsapp.ts';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer(): Promise<void> {
  const app = express();
  app.set('trust proxy', 1);

  // Baseline security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // Support hosting under /med-link subpath as well as root /
  app.use((req, _res, next) => {
    if (req.url === '/med-link') {
      req.url = '/';
    } else if (req.url.startsWith('/med-link/')) {
      req.url = req.url.slice('/med-link'.length);
    }
    next();
  });

  const ordersJsonParser = express.json({ limit: '8mb' });
  const defaultJsonParser = express.json({ limit: '512kb' });
  app.use((req, res, next) => {
    if (req.path === '/api/orders' && req.method === 'POST') {
      ordersJsonParser(req, res, next);
      return;
    }
    defaultJsonParser(req, res, next);
  });

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  // Health probe
  app.get('/api/health', (_req, res) => {
    const state = whatsappService.getPublicState();
    res.json({
      ok: true,
      whatsappStatus: state.status,
      qrReady: Boolean(state.qrDataUrl),
      statusDetail: state.statusDetail,
    });
  });

  // ---------------------------------------------------------------------------
  // Dashboard Authentication Routes
  // ---------------------------------------------------------------------------
  app.get('/api/auth/status', (_req, res) => {
    res.json({
      ok: true,
      claimed: isDashboardClaimed(),
      envPasswordConfigured: isEnvDashboardPasswordConfigured(),
    });
  });

  app.post('/api/auth/setup', (req, res) => {
    if (isDashboardClaimed()) {
      res.status(409).json({
        ok: false,
        error: 'Dashboard password is already configured',
      });
      return;
    }

    const parsed = authPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: parsed.error.issues[0]?.message || 'Invalid password',
      });
      return;
    }

    const claimed = claimInitialDashboardPassword(parsed.data.password);
    if (!claimed) {
      res.status(409).json({
        ok: false,
        error: 'Dashboard password was already claimed',
      });
      return;
    }

    const session = issueDashboardToken();
    logger.info('dashboard_admin_claimed');
    res.status(201).json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const rate = checkLoginRateLimit(clientIp);
    if (!rate.allowed) {
      res.status(429).json({
        ok: false,
        error: `Too many login attempts. Try again in ${rate.retryAfterSec}s.`,
      });
      return;
    }

    if (!isDashboardClaimed()) {
      res.status(400).json({
        ok: false,
        error: 'Dashboard password has not been claimed yet',
      });
      return;
    }

    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!password || !verifyDashboardPassword(password)) {
      logger.warn('dashboard_login_failed', { ip: clientIp });
      res.status(401).json({
        ok: false,
        error: 'Invalid password',
      });
      return;
    }

    clearLoginRateLimit(clientIp);
    const session = issueDashboardToken();
    logger.info('dashboard_login_success');
    res.json({
      ok: true,
      token: session.token,
      expiresAt: session.expiresAt,
    });
  });

  app.get('/api/auth/verify', requireDashboardAuth, (_req, res) => {
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // External Restaurant Website Webhook: POST /api/orders
  // ---------------------------------------------------------------------------
  app.post('/api/orders', async (req, res) => {
    const secretSource = getWebhookSecretSource();
    if (secretSource === 'none') {
      res.status(503).json({
        ok: false,
        error: 'WEBHOOK_NOT_CONFIGURED',
        message: 'Webhook secret is not configured. Set WEBHOOK_SECRET or generate one in Configuration.',
      });
      return;
    }

    const authCheck = verifyWebhookRequest(req);
    if (!authCheck.authorized) {
      logger.warn('webhook_unauthorized', { reason: authCheck.reason });
      res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED',
        message: authCheck.reason || 'Unauthorized webhook request',
      });
      return;
    }

    const parsed = incomingOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: 'VALIDATION_ERROR',
        message: 'Invalid order payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const orderPayload = parsed.data;

    if (orderPayload.paymentReceiptUrl) {
      try {
        await validateReceiptInputSafety(orderPayload.paymentReceiptUrl);
      } catch (err) {
        res.status(400).json({
          ok: false,
          error: 'INVALID_RECEIPT_IMAGE',
          message: err instanceof Error ? err.message : 'Invalid receipt image',
        });
        return;
      }
    }

    const formattedMessage = formatArabicOrderMessage(orderPayload);
    const { created, order } = createQueuedOrder(orderPayload, formattedMessage);

    if (!created) {
      logger.info('webhook_duplicate_order_rejected', {
        orderId: order.order_id,
        existingStatus: order.status,
      });
      res.status(409).json({
        ok: false,
        duplicate: true,
        error: 'DUPLICATE_ORDER',
        message: `Order #${order.order_id} was already received`,
        orderId: order.order_id,
        notificationStatus: order.status,
      });
      return;
    }

    logger.info('webhook_order_queued', {
      orderId: order.order_id,
      hasReceiptImage: Boolean(orderPayload.paymentReceiptUrl),
      itemCount: orderPayload.items.length,
    });

    // Wake queue immediately without blocking HTTP response
    void queueWorker.trigger();

    res.status(202).json({
      ok: true,
      orderId: order.order_id,
      notificationStatus: order.status,
      whatsappStatus: whatsappService.getPublicState().status,
      message: 'Order accepted and queued for WhatsApp delivery',
    });
  });

  // ---------------------------------------------------------------------------
  // Protected Dashboard Routes
  // ---------------------------------------------------------------------------
  app.get('/api/whatsapp/status', requireDashboardAuth, (_req, res) => {
    const waState = whatsappService.getPublicState();
    const config = getAppConfig();
    const expectedSenderDigits = normalizeWhatsAppDigits(
      config.senderNumber,
      config.defaultCountryCode,
    );
    const senderMismatch =
      waState.status === 'connected' &&
      Boolean(waState.connectedPhone) &&
      Boolean(expectedSenderDigits) &&
      waState.connectedPhone !== expectedSenderDigits;

    res.json({
      ok: true,
      ...waState,
      expectedSenderDigits,
      senderMismatch,
    });
  });

  app.post('/api/whatsapp/connect', requireDashboardAuth, (_req, res) => {
    void whatsappService.connectFresh(true);
    res.json({
      ok: true,
      message: 'Starting fresh WhatsApp Web session and generating QR code',
    });
  });

  app.post('/api/whatsapp/reconnect', requireDashboardAuth, (_req, res) => {
    void whatsappService.connectFresh(true);
    res.json({
      ok: true,
      message: 'Resetting session and generating a new QR code',
    });
  });

  app.post('/api/whatsapp/disconnect', requireDashboardAuth, async (_req, res) => {
    await whatsappService.disconnectAndClearSession();
    res.json({
      ok: true,
      message: 'WhatsApp Web disconnected cleanly. Click Connect / Generate QR Code to link a device.',
    });
  });

  app.post('/api/whatsapp/logout', requireDashboardAuth, async (_req, res) => {
    await whatsappService.disconnectAndClearSession();
    res.json({
      ok: true,
      message: 'WhatsApp Web session disconnected and cleared safely',
    });
  });

  app.get('/api/config', requireDashboardAuth, (_req, res) => {
    const config = getAppConfig();
    let senderJidPreview = '';
    let recipientJidPreview = '';
    try {
      senderJidPreview = toWhatsAppJid(config.senderNumber, config.defaultCountryCode);
    } catch {
      senderJidPreview = '';
    }
    try {
      recipientJidPreview = toWhatsAppJid(config.recipientNumber, config.defaultCountryCode);
    } catch {
      recipientJidPreview = '';
    }

    res.json({
      ok: true,
      senderNumber: config.senderNumber,
      recipientNumber: config.recipientNumber,
      defaultCountryCode: config.defaultCountryCode,
      senderJidPreview,
      recipientJidPreview,
      webhookSecretSource: getWebhookSecretSource(),
      receiptAllowedHosts: (process.env.RECEIPT_ALLOWED_HOSTS || '').trim() || null,
    });
  });

  app.put('/api/config', requireDashboardAuth, (req, res) => {
    const parsed = configUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: parsed.error.issues[0]?.message || 'Invalid configuration input',
      });
      return;
    }

    const updated = updateAppConfig({
      senderNumber: parsed.data.senderNumber,
      recipientNumber: parsed.data.recipientNumber,
      defaultCountryCode: parsed.data.defaultCountryCode,
    });

    logger.info('config_updated');
    res.json({
      ok: true,
      senderNumber: updated.senderNumber,
      recipientNumber: updated.recipientNumber,
      defaultCountryCode: updated.defaultCountryCode,
      senderJidPreview: toWhatsAppJid(updated.senderNumber, updated.defaultCountryCode),
      recipientJidPreview: toWhatsAppJid(updated.recipientNumber, updated.defaultCountryCode),
      webhookSecretSource: getWebhookSecretSource(),
      receiptAllowedHosts: (process.env.RECEIPT_ALLOWED_HOSTS || '').trim() || null,
    });
  });

  app.post('/api/config/webhook-secret', requireDashboardAuth, (_req, res) => {
    if ((process.env.WEBHOOK_SECRET || '').trim()) {
      res.status(409).json({
        ok: false,
        error: 'WEBHOOK_SECRET is managed via environment variables and cannot be rotated from the UI.',
      });
      return;
    }

    const generatedSecret = generateAndStoreWebhookSecret();
    logger.info('webhook_secret_rotated');
    res.json({
      ok: true,
      secret: generatedSecret,
      message: 'Copy this secret now. For security, it will not be displayed again.',
    });
  });

  app.get('/api/orders/history', requireDashboardAuth, (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    const search = typeof req.query.search === 'string' ? req.query.search : '';
    const stats = getOrderStats();
    const rows = listOrders(status, search, 100);

    const orders = rows.map((row) => {
      let parsedItems: unknown[] = [];
      try {
        parsedItems = JSON.parse(row.items_json) as unknown[];
      } catch {
        parsedItems = [];
      }
      return {
        id: row.id,
        orderId: row.order_id,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        deliveryAddress: row.delivery_address,
        items: parsedItems,
        subtotal: row.subtotal,
        deliveryFee: row.delivery_fee,
        totalAmount: row.total_amount,
        currency: row.currency,
        customerNotes: row.customer_notes,
        paymentMethod: row.payment_method,
        walletName: row.wallet_name,
        transferReference: row.transfer_reference,
        paymentReceiptUrl: row.payment_receipt_url,
        formattedMessage: row.formatted_message,
        status: row.status,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        nextRetryAt: row.next_retry_at,
        lastError: row.last_error,
        whatsappMessageId: row.whatsapp_message_id,
        recipientJid: row.recipient_jid,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        sentAt: row.sent_at,
      };
    });

    res.json({
      ok: true,
      stats,
      orders,
    });
  });

  app.get('/api/orders/:orderId/logs', requireDashboardAuth, (req, res) => {
    const orderId = String(req.params.orderId || '').trim();
    const order = getOrderByOrderId(orderId);
    if (!order) {
      res.status(404).json({ ok: false, error: 'Order not found' });
      return;
    }
    const logs = getOrderLogs(orderId);
    res.json({ ok: true, logs });
  });

  app.post('/api/orders/:orderId/retry', requireDashboardAuth, (req, res) => {
    const orderId = String(req.params.orderId || '').trim();
    const order = getOrderByOrderId(orderId);
    if (!order) {
      res.status(404).json({ ok: false, error: 'Order not found' });
      return;
    }
    if (order.status === 'sent') {
      res.status(409).json({
        ok: false,
        error: 'Order notification was already confirmed sent',
      });
      return;
    }

    const updated = queueManualRetry(orderId);
    if (!updated) {
      res.status(409).json({
        ok: false,
        error: 'Order is currently being dispatched; please wait a moment',
      });
      return;
    }

    void queueWorker.trigger();
    res.json({
      ok: true,
      message: `Order #${orderId} re-queued for immediate delivery`,
    });
  });

  app.post('/api/test-message', requireDashboardAuth, async (req, res) => {
    if (!whatsappService.isConnected()) {
      res.status(409).json({
        ok: false,
        error: 'WhatsApp is not connected yet. Scan the QR code first.',
      });
      return;
    }

    const parsed = testMessageSchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: parsed.error.issues[0]?.message || 'Invalid test message request',
      });
      return;
    }

    try {
      const config = getAppConfig();
      const recipientJid = toWhatsAppJid(config.recipientNumber, config.defaultCountryCode);

      const textToSend =
        parsed.data.mode === 'text' && parsed.data.message
          ? parsed.data.message
          : formatArabicOrderMessage({
              orderId: `TEST-${Math.floor(1000 + Math.random() * 9000)}`,
              customerName: 'عميل تجريبي',
              customerPhone: '01000000000',
              deliveryAddress: 'شارع التحرير، وسط البلد، القاهرة',
              items: [
                { name: 'وجبة مشويات مشكلة', quantity: 2, price: 240 },
                { name: 'سلطة طحينة', quantity: 1, price: 35 },
              ],
              subtotal: 515,
              deliveryFee: 30,
              totalAmount: 545,
              currency: 'ج.م',
              customerNotes: 'رسالة اختبار من لوحة تحكم إشعارات الطلبات',
              paymentMethod: 'تحويل محفظة إلكترونية',
              walletName: 'Vodafone Cash',
              transferReference: 'TEST-REF-9021',
              paymentReceiptUrl: '',
            });

      const result = await whatsappService.sendOrderMessage(recipientJid, textToSend);
      logger.info('test_message_sent', { whatsappMessageId: result.messageId });
      res.json({
        ok: true,
        messageId: result.messageId,
        recipientJid: result.resolvedJid,
        message: 'Test notification sent and confirmed by WhatsApp',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send test message';
      logger.error('test_message_failed', { error: message });
      res.status(502).json({
        ok: false,
        error: message,
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Frontend Serving (Vite Dev Middleware or Static Production Dist)
  // ---------------------------------------------------------------------------
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('server_listening', { port: PORT, mode: IS_PROD ? 'production' : 'development' });
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });

  // Start background queue & defer heavy Chromium launch briefly so port 3000 responds immediately
  queueWorker.start();
  const initTimer = setTimeout(() => {
    void whatsappService.initializeIfNotDisconnected();
  }, 2500);

  const shutdown = async () => {
    clearTimeout(initTimer);
    logger.info('server_shutting_down');
    queueWorker.stop();
    await whatsappService.shutdown();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function isRecoverableBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Target closed') ||
    msg.includes('Session closed') ||
    msg.includes('Execution context was destroyed') ||
    msg.includes('Protocol error') ||
    msg.includes('Attempted to use detached Frame') ||
    msg.includes('Navigation failed because browser has disconnected') ||
    msg.includes('auth timeout') ||
    msg.includes('ENOENT')
  );
}

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (isRecoverableBrowserError(reason)) {
    whatsappService.handleUnexpectedBrowserCrash(message);
    return;
  }
  logger.error('unhandled_rejection', { error: message });
});

process.on('uncaughtException', (err) => {
  if (isRecoverableBrowserError(err)) {
    whatsappService.handleUnexpectedBrowserCrash(err.message);
    return;
  }
  logger.error('uncaught_exception', { error: err.message });
});

startServer().catch((err) => {
  logger.error('server_fatal_error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
