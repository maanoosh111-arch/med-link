import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import type { Client as WhatsAppClientType } from 'whatsapp-web.js';
import { getSetting, setSetting } from './db.ts';
import { logger } from './logger.ts';
import { fetchValidatedReceiptImage } from './media.ts';
import { maskPhone } from './phone.ts';

type WhatsAppWebModule = typeof import('whatsapp-web.js');
let cachedWwjs: WhatsAppWebModule | null = null;

async function loadWwjs(): Promise<WhatsAppWebModule> {
  if (!cachedWwjs) {
    const mod = await import('whatsapp-web.js');
    cachedWwjs = ((mod as { default?: WhatsAppWebModule }).default ?? mod) as WhatsAppWebModule;
  }
  return cachedWwjs;
}

const SESSION_CLIENT_ID = 'restaurant-order-relay';

function getSessionDir(authDataPath: string): string {
  return path.join(authDataPath, `session-${SESSION_CLIENT_ID}`);
}

function clearBrowserServiceWorkerCache(sessionDir: string): void {
  const staleDirs = [
    path.join(sessionDir, 'Default', 'Service Worker'),
    path.join(sessionDir, 'Default', 'Cache'),
    path.join(sessionDir, 'Default', 'Code Cache'),
  ];
  for (const dir of staleDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore missing cache directories
    }
  }
}

function removeSessionDir(authDataPath: string): void {
  try {
    fs.rmSync(getSessionDir(authDataPath), { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function cleanStaleChromiumLock(authDataPath: string): Promise<void> {
  const sessionDir = getSessionDir(authDataPath);
  const lockPath = path.join(sessionDir, 'SingletonLock');
  try {
    const target = fs.readlinkSync(lockPath);
    const match = target.match(/-(\d+)$/);
    if (match) {
      const pid = Number(match[1]);
      if (pid > 0 && pid !== process.pid) {
        let isOurChrome = false;
        try {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          isOurChrome = cmdline.includes(`session-${SESSION_CLIENT_ID}`);
        } catch {
          isOurChrome = false;
        }

        if (isOurChrome) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch {
            // already exited
          }
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 100));
            try {
              process.kill(pid, 0);
            } catch {
              isOurChrome = false;
              break;
            }
          }
          if (isOurChrome) {
            try {
              process.kill(pid, 'SIGKILL');
              await new Promise((r) => setTimeout(r, 250));
            } catch {
              // ignore
            }
          }
        }
      }
    }
  } catch {
    // No SingletonLock symlink present
  }

  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(sessionDir, name), { force: true });
    } catch {
      // Ignore missing lock file
    }
  }
}

export type WhatsAppConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface WhatsAppPublicState {
  status: WhatsAppConnectionStatus;
  statusDetail: string;
  qrDataUrl: string | null;
  connectedPhone: string | null;
  connectedPushName: string | null;
  lastError: string | null;
  updatedAt: number;
}

class WhatsAppService extends EventEmitter {
  private client: WhatsAppClientType | null = null;
  private status: WhatsAppConnectionStatus = 'disconnected';
  private statusDetail = 'Not initialized';
  private qrDataUrl: string | null = null;
  private connectedPhone: string | null = null;
  private connectedPushName: string | null = null;
  private lastError: string | null = null;
  private updatedAt: number = Date.now();
  private initializing = false;
  private destroying = false;
  private manualDisconnecting = false;
  private connectionEpoch = 0;
  private syncWatchdog: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  getPublicState(): WhatsAppPublicState {
    return {
      status: this.status,
      statusDetail: this.statusDetail,
      qrDataUrl: this.qrDataUrl,
      connectedPhone: this.connectedPhone,
      connectedPushName: this.connectedPushName,
      lastError: this.lastError,
      updatedAt: this.updatedAt,
    };
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.client !== null;
  }

  private clearWatchdog(): void {
    if (this.syncWatchdog) {
      clearTimeout(this.syncWatchdog);
      this.syncWatchdog = null;
    }
  }

  private setState(patch: Partial<WhatsAppPublicState>): void {
    if (patch.status !== undefined) this.status = patch.status;
    if (patch.statusDetail !== undefined) this.statusDetail = patch.statusDetail;
    if (patch.qrDataUrl !== undefined) this.qrDataUrl = patch.qrDataUrl;
    if (patch.connectedPhone !== undefined) this.connectedPhone = patch.connectedPhone;
    if (patch.connectedPushName !== undefined) this.connectedPushName = patch.connectedPushName;
    if (patch.lastError !== undefined) this.lastError = patch.lastError;
    this.updatedAt = Date.now();
  }

  async initializeIfNotDisconnected(): Promise<void> {
    if (getSetting('whatsapp_manual_disconnect') === '1') {
      this.setState({
        status: 'disconnected',
        statusDetail: 'Disconnected. Click Connect / Generate QR Code to link a WhatsApp device.',
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: null,
      });
      return;
    }
    await this.initialize();
  }

  async initialize(options: { resetSession?: boolean } = {}): Promise<void> {
    if (this.initializing || this.destroying) {
      return;
    }
    if (this.client && (this.status === 'connecting' || this.status === 'connected')) {
      return;
    }

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const epoch = ++this.connectionEpoch;
    this.initializing = true;
    this.manualDisconnecting = false;
    setSetting('whatsapp_manual_disconnect', '0');

    this.setState({
      status: 'connecting',
      statusDetail: 'Starting headless browser and loading WhatsApp Web session',
      qrDataUrl: null,
      connectedPhone: null,
      connectedPushName: null,
      lastError: null,
    });

    try {
      const { Client, LocalAuth } = await loadWwjs();
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) return;

      const authDataPath = path.resolve(process.cwd(), '.wwebjs_auth');
      await cleanStaleChromiumLock(authDataPath);
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) return;

      if (options.resetSession || getSetting('whatsapp_authenticated') !== '1') {
        setSetting('whatsapp_authenticated', '0');
        removeSessionDir(authDataPath);
      } else {
        // Keep auth IndexedDB/LocalStorage intact while clearing Service Worker cache so pinned webVersion loads cleanly
        clearBrowserServiceWorkerCache(getSessionDir(authDataPath));
      }

      const executablePath = (process.env.PUPPETEER_EXECUTABLE_PATH || '').trim() || undefined;
      const webVersion = (process.env.WHATSAPP_WEB_VERSION || '2.3000.1048260127-alpha').trim();

      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: SESSION_CLIENT_ID,
          dataPath: authDataPath,
        }),
        qrMaxRetries: 0,
        authTimeoutMs: 45_000,
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        webVersion,
        webVersionCache: {
          type: 'remote',
          remotePath:
            'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
        },
        puppeteer: {
          headless: true,
          ...(executablePath ? { executablePath } : {}),
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
          ],
        },
      });

      this.attachEventHandlers(client, authDataPath, epoch);
      this.client = client;

      // Safety watchdog: if session hangs >50s without QR or ready, cleanly reset to disconnected
      this.clearWatchdog();
      this.syncWatchdog = setTimeout(() => {
        if (epoch === this.connectionEpoch && this.status === 'connecting' && !this.qrDataUrl) {
          logger.warn('whatsapp_init_watchdog_timeout');
          void this.handleSessionInvalidated(
            authDataPath,
            'Session timed out waiting for WhatsApp Web. Click Connect / Generate QR Code to link again.',
            null,
          );
        }
      }, 50_000);

      logger.info('whatsapp_initializing');
      await client.initialize();
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) {
        await client.destroy().catch(() => {});
      }
    } catch (err) {
      if (epoch !== this.connectionEpoch || this.manualDisconnecting) {
        return;
      }
      this.clearWatchdog();
      const message = err instanceof Error ? err.message : 'Failed to initialize WhatsApp Web client';
      logger.error('whatsapp_init_error', { error: message });
      setSetting('whatsapp_authenticated', '0');
      this.setState({
        status: 'disconnected',
        statusDetail: 'Disconnected. Click Connect / Generate QR Code to try again.',
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: message,
      });
      await this.safeDestroyClient();
    } finally {
      if (epoch === this.connectionEpoch) {
        this.initializing = false;
      }
    }
  }

  private async handleSessionInvalidated(
    authDataPath: string,
    detail: string,
    errorMsg: string | null,
  ): Promise<void> {
    if (this.destroying) return;
    this.destroying = true;
    this.connectionEpoch++;
    this.clearWatchdog();
    try {
      setSetting('whatsapp_authenticated', '0');
      setSetting('whatsapp_manual_disconnect', '1');
      this.setState({
        status: 'disconnected',
        statusDetail: detail,
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: errorMsg,
      });
      await this.safeDestroyClient();
      await cleanStaleChromiumLock(authDataPath);
      removeSessionDir(authDataPath);
    } finally {
      this.destroying = false;
    }
  }

  private attachEventHandlers(
    client: WhatsAppClientType,
    authDataPath: string,
    epoch: number,
  ): void {
    client.on('qr', async (qrString: string) => {
      if (
        epoch !== this.connectionEpoch ||
        this.manualDisconnecting ||
        this.destroying ||
        this.client !== client
      ) {
        return;
      }
      this.clearWatchdog();
      setSetting('whatsapp_authenticated', '0');
      try {
        const dataUrl = await QRCode.toDataURL(qrString, {
          width: 280,
          margin: 2,
          color: {
            dark: '#0F172A',
            light: '#FFFFFF',
          },
        });
        if (epoch !== this.connectionEpoch || this.manualDisconnecting || this.client !== client) {
          return;
        }
        this.setState({
          status: 'connecting',
          statusDetail: 'Waiting for QR code scan from sender WhatsApp phone',
          qrDataUrl: dataUrl,
          connectedPhone: null,
          connectedPushName: null,
          lastError: null,
        });
        logger.info('whatsapp_qr_generated');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'QR encoding failed';
        this.setState({ lastError: message });
      }
    });

    client.on('authenticated', () => {
      if (epoch !== this.connectionEpoch || this.manualDisconnecting || this.client !== client) {
        return;
      }
      setSetting('whatsapp_authenticated', '1');
      this.setState({
        status: 'connecting',
        statusDetail: 'Authenticated; syncing WhatsApp Web chats',
        qrDataUrl: null,
        lastError: null,
      });
      logger.info('whatsapp_authenticated');
    });

    client.on('auth_failure', (msg: string) => {
      if (epoch !== this.connectionEpoch || this.client !== client) return;
      logger.error('whatsapp_auth_failure', { error: msg });
      if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
      this.cleanupTimer = setTimeout(() => {
        if (epoch !== this.connectionEpoch) return;
        void this.handleSessionInvalidated(
          authDataPath,
          'Authentication failed. Click Connect / Generate QR Code to scan a fresh QR.',
          msg || 'Authentication failure',
        );
      }, 400);
    });

    client.on('ready', () => {
      if (epoch !== this.connectionEpoch || this.manualDisconnecting || this.client !== client) {
        return;
      }
      this.clearWatchdog();
      setSetting('whatsapp_authenticated', '1');
      const info = client.info;
      const phone = info?.wid?.user || null;
      const pushName = info?.pushname || null;

      this.setState({
        status: 'connected',
        statusDetail: 'WhatsApp Web session ready to relay order notifications',
        qrDataUrl: null,
        connectedPhone: phone,
        connectedPushName: pushName,
        lastError: null,
      });
      logger.info('whatsapp_ready', {
        connectedPhone: phone ? maskPhone(phone) : null,
      });
      this.emit('ready');
    });

    client.on('disconnected', (reason: string) => {
      if (epoch !== this.connectionEpoch || this.client !== client) return;
      logger.warn('whatsapp_disconnected', { reason });
      this.clearWatchdog();
      setSetting('whatsapp_authenticated', '0');
      setSetting('whatsapp_manual_disconnect', '1');

      this.setState({
        status: 'disconnected',
        statusDetail: `Disconnected (${reason || 'device unlinked'}). Click Connect / Generate QR Code to link a device.`,
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: null,
      });

      // Defer browser destruction slightly so whatsapp-web.js framenavigated/logout handlers finish cleanly without unhandled rejections
      if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
      this.cleanupTimer = setTimeout(() => {
        void this.handleSessionInvalidated(
          authDataPath,
          `Disconnected (${reason || 'device unlinked'}). Click Connect / Generate QR Code to link a device.`,
          null,
        );
      }, 700);
    });
  }

  private async safeDestroyClient(maxWaitMs = 4000): Promise<void> {
    this.clearWatchdog();
    if (!this.client) return;
    const target = this.client;
    this.client = null;
    try {
      await Promise.race([
        target.destroy(),
        new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs)),
      ]);
    } catch {
      // Ignore cleanup errors on already-closed Chromium process
    }
  }

  async shutdown(): Promise<void> {
    this.connectionEpoch++;
    this.clearWatchdog();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    await this.safeDestroyClient();
  }

  handleUnexpectedBrowserCrash(errorMessage: string): void {
    logger.warn('whatsapp_recovered_from_browser_error', { error: errorMessage });
    this.clearWatchdog();
    if (this.status === 'connected' || this.status === 'connecting') {
      this.connectionEpoch++;
      setSetting('whatsapp_authenticated', '0');
      setSetting('whatsapp_manual_disconnect', '1');
      this.setState({
        status: 'disconnected',
        statusDetail: 'WhatsApp browser session closed. Click Generate New QR Code to link a device.',
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: null,
      });
      const authDataPath = path.resolve(process.cwd(), '.wwebjs_auth');
      void this.safeDestroyClient().then(() => removeSessionDir(authDataPath));
    }
  }

  private async waitForInitSettle(maxMs = 2500): Promise<void> {
    const start = Date.now();
    while (this.initializing && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.initializing = false;
  }

  async connectFresh(resetSession = true): Promise<void> {
    if (this.destroying) return;
    this.destroying = true;
    this.connectionEpoch++;
    try {
      await this.safeDestroyClient(600);
      await this.waitForInitSettle(400);
      const authDataPath = path.resolve(process.cwd(), '.wwebjs_auth');
      await cleanStaleChromiumLock(authDataPath);
      if (resetSession) {
        setSetting('whatsapp_authenticated', '0');
        removeSessionDir(authDataPath);
      }
      setSetting('whatsapp_manual_disconnect', '0');
      this.setState({
        status: 'connecting',
        statusDetail: 'Generating fresh WhatsApp Web QR code now...',
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: null,
      });
    } finally {
      this.destroying = false;
    }
    await this.initialize({ resetSession });
  }

  async disconnectAndClearSession(): Promise<void> {
    if (this.destroying) return;
    this.destroying = true;
    this.manualDisconnecting = true;
    this.connectionEpoch++;
    this.clearWatchdog();
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    try {
      setSetting('whatsapp_authenticated', '0');
      setSetting('whatsapp_manual_disconnect', '1');

      if (this.client) {
        try {
          await Promise.race([
            this.client.logout(),
            new Promise<void>((resolve) => setTimeout(resolve, 3500)),
          ]);
        } catch (err) {
          logger.warn('whatsapp_logout_cleanup_warning', {
            error: err instanceof Error ? err.message : 'Logout warning',
          });
        }
        await this.safeDestroyClient();
      }

      await this.waitForInitSettle();
      const authDataPath = path.resolve(process.cwd(), '.wwebjs_auth');
      await cleanStaleChromiumLock(authDataPath);
      removeSessionDir(authDataPath);

      this.setState({
        status: 'disconnected',
        statusDetail: 'Disconnected cleanly. Click Connect / Generate QR Code to link a new or existing device.',
        qrDataUrl: null,
        connectedPhone: null,
        connectedPushName: null,
        lastError: null,
      });
      logger.info('whatsapp_disconnected_manually');
    } finally {
      this.manualDisconnecting = false;
      this.destroying = false;
    }
  }

  async sendText(recipientJid: string, text: string): Promise<{ messageId: string }> {
    if (!this.client || this.status !== 'connected') {
      throw new Error('WhatsApp client is not connected');
    }

    const numberId = await this.client.getNumberId(recipientJid.replace('@c.us', ''));
    const targetJid = numberId?._serialized || recipientJid;

    const sent = await this.client.sendMessage(targetJid, text);
    const messageId = sent?.id?._serialized;
    if (!messageId) {
      throw new Error('WhatsApp did not return a message confirmation ID');
    }
    return { messageId };
  }

  async sendOrderMessage(
    recipientJid: string,
    formattedMessage: string,
    paymentReceiptUrl?: string,
  ): Promise<{ messageId: string; resolvedJid: string }> {
    if (!this.client || this.status !== 'connected') {
      throw new Error('WhatsApp client is not connected');
    }

    const digits = recipientJid.replace('@c.us', '');
    const numberId = await this.client.getNumberId(digits);
    if (!numberId) {
      throw new Error(`Recipient number (${digits}) is not registered on WhatsApp`);
    }
    const targetJid = numberId._serialized;

    if (paymentReceiptUrl && paymentReceiptUrl.trim()) {
      const { MessageMedia } = await loadWwjs();
      const receipt = await fetchValidatedReceiptImage(paymentReceiptUrl.trim());
      const media = new MessageMedia(receipt.mimeType, receipt.base64, receipt.filename);
      const sent = await this.client.sendMessage(targetJid, media, {
        caption: formattedMessage,
      });
      const messageId = sent?.id?._serialized;
      if (!messageId) {
        throw new Error('WhatsApp did not confirm image attachment delivery');
      }
      return { messageId, resolvedJid: targetJid };
    }

    const sent = await this.client.sendMessage(targetJid, formattedMessage);
    const messageId = sent?.id?._serialized;
    if (!messageId) {
      throw new Error('WhatsApp did not confirm text message delivery');
    }
    return { messageId, resolvedJid: targetJid };
  }
}

export const whatsappService = new WhatsAppService();
