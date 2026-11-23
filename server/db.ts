import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { NormalizedOrderPayload } from './formatter.ts';

export type OrderNotificationStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface StoredOrderRecord {
  id: number;
  order_id: string;
  customer_name: string;
  customer_phone: string;
  delivery_address: string;
  items_json: string;
  subtotal: number;
  delivery_fee: number;
  total_amount: number;
  currency: string;
  customer_notes: string;
  payment_method: string;
  wallet_name: string;
  transfer_reference: string;
  payment_receipt_url: string;
  formatted_message: string;
  status: OrderNotificationStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: number | null;
  last_error: string | null;
  whatsapp_message_id: string | null;
  recipient_jid: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
}

export interface NotificationLogRecord {
  id: number;
  order_id: string;
  event_type: string;
  detail: string;
  created_at: number;
}

export interface AppConfig {
  senderNumber: string;
  recipientNumber: string;
  defaultCountryCode: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'relay.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    delivery_address TEXT NOT NULL,
    items_json TEXT NOT NULL,
    subtotal REAL NOT NULL,
    delivery_fee REAL NOT NULL DEFAULT 0,
    total_amount REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'ج.م',
    customer_notes TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL,
    wallet_name TEXT NOT NULL DEFAULT '',
    transfer_reference TEXT NOT NULL DEFAULT '',
    payment_receipt_url TEXT NOT NULL DEFAULT '',
    formatted_message TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'failed')) DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_retry_at INTEGER,
    last_error TEXT,
    whatsapp_message_id TEXT,
    recipient_jid TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sent_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_orders_status_retry ON orders(status, next_retry_at);
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);

  CREATE TABLE IF NOT EXISTS notification_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_logs_order_id ON notification_logs(order_id, created_at DESC);
`);

const DEFAULT_SENDER = (process.env.DEFAULT_SENDER_NUMBER || '01204457813').trim();
const DEFAULT_RECIPIENT = (process.env.DEFAULT_RECIPIENT_NUMBER || '010 15678913').trim();
const DEFAULT_COUNTRY = (process.env.DEFAULT_COUNTRY_CODE || '20').trim();

const insertSettingIfMissingStmt = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
);

const nowSeed = Date.now();
insertSettingIfMissingStmt.run('sender_number', DEFAULT_SENDER, nowSeed);
insertSettingIfMissingStmt.run('recipient_number', DEFAULT_RECIPIENT, nowSeed);
insertSettingIfMissingStmt.run('default_country_code', DEFAULT_COUNTRY, nowSeed);

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const upsertSettingStmt = db.prepare(`
  INSERT INTO settings (key, value, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

export function getSetting(key: string): string | null {
  const row = getSettingStmt.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  upsertSettingStmt.run(key, value, Date.now());
}

export function setSettingIfUnset(key: string, value: string): boolean {
  const result = insertSettingIfMissingStmt.run(key, value, Date.now());
  return result.changes > 0;
}

export function getAppConfig(): AppConfig {
  return {
    senderNumber: getSetting('sender_number') || DEFAULT_SENDER,
    recipientNumber: getSetting('recipient_number') || DEFAULT_RECIPIENT,
    defaultCountryCode: getSetting('default_country_code') || DEFAULT_COUNTRY,
  };
}

export function updateAppConfig(config: AppConfig): AppConfig {
  const tx = db.transaction((next: AppConfig) => {
    setSetting('sender_number', next.senderNumber.trim());
    setSetting('recipient_number', next.recipientNumber.trim());
    setSetting('default_country_code', next.defaultCountryCode.trim());
  });
  tx(config);
  return getAppConfig();
}

const insertOrderStmt = db.prepare(`
  INSERT INTO orders (
    order_id, customer_name, customer_phone, delivery_address,
    items_json, subtotal, delivery_fee, total_amount, currency,
    customer_notes, payment_method, wallet_name, transfer_reference,
    payment_receipt_url, formatted_message, status, attempts, max_attempts,
    next_retry_at, last_error, created_at, updated_at
  ) VALUES (
    @order_id, @customer_name, @customer_phone, @delivery_address,
    @items_json, @subtotal, @delivery_fee, @total_amount, @currency,
    @customer_notes, @payment_method, @wallet_name, @transfer_reference,
    @payment_receipt_url, @formatted_message, 'pending', 0, 5,
    @next_retry_at, NULL, @now, @now
  )
`);

const getOrderByOrderIdStmt = db.prepare('SELECT * FROM orders WHERE order_id = ?');
const insertLogStmt = db.prepare(
  'INSERT INTO notification_logs (order_id, event_type, detail, created_at) VALUES (?, ?, ?, ?)',
);

export function getOrderByOrderId(orderId: string): StoredOrderRecord | undefined {
  return getOrderByOrderIdStmt.get(orderId) as StoredOrderRecord | undefined;
}

export function appendNotificationLog(orderId: string, eventType: string, detail: string): void {
  insertLogStmt.run(orderId, eventType, detail, Date.now());
}

export function createQueuedOrder(
  payload: NormalizedOrderPayload,
  formattedMessage: string,
): { created: boolean; order: StoredOrderRecord } {
  const existing = getOrderByOrderId(payload.orderId);
  if (existing) {
    return { created: false, order: existing };
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    insertOrderStmt.run({
      order_id: payload.orderId,
      customer_name: payload.customerName,
      customer_phone: payload.customerPhone,
      delivery_address: payload.deliveryAddress,
      items_json: JSON.stringify(payload.items),
      subtotal: payload.subtotal,
      delivery_fee: payload.deliveryFee,
      total_amount: payload.totalAmount,
      currency: payload.currency,
      customer_notes: payload.customerNotes,
      payment_method: payload.paymentMethod,
      wallet_name: payload.walletName,
      transfer_reference: payload.transferReference,
      payment_receipt_url: payload.paymentReceiptUrl,
      formatted_message: formattedMessage,
      next_retry_at: now,
      now,
    });
    insertLogStmt.run(payload.orderId, 'queued', 'Order received via webhook and added to queue', now);
  });

  try {
    tx();
    const inserted = getOrderByOrderId(payload.orderId);
    if (!inserted) {
      throw new Error('Failed to load newly inserted order');
    }
    return { created: true, order: inserted };
  } catch (err) {
    // Handle race condition on UNIQUE order_id
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
      const concurrent = getOrderByOrderId(payload.orderId);
      if (concurrent) {
        return { created: false, order: concurrent };
      }
    }
    throw err;
  }
}

const getNextDueOrderStmt = db.prepare(`
  SELECT * FROM orders
  WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
  ORDER BY created_at ASC
  LIMIT 1
`);

export function getNextDueOrder(now = Date.now()): StoredOrderRecord | undefined {
  return getNextDueOrderStmt.get(now) as StoredOrderRecord | undefined;
}

const claimOrderForSendingStmt = db.prepare(`
  UPDATE orders
  SET status = 'sending', attempts = attempts + 1, updated_at = ?
  WHERE order_id = ? AND status = 'pending'
`);

export function claimOrderForSending(orderId: string): boolean {
  const res = claimOrderForSendingStmt.run(Date.now(), orderId);
  return res.changes > 0;
}

const markOrderSentStmt = db.prepare(`
  UPDATE orders
  SET status = 'sent', whatsapp_message_id = ?, recipient_jid = ?, last_error = NULL,
      next_retry_at = NULL, sent_at = ?, updated_at = ?
  WHERE order_id = ?
`);

export function markOrderSent(orderId: string, whatsappMessageId: string, recipientJid: string): void {
  const now = Date.now();
  const tx = db.transaction(() => {
    markOrderSentStmt.run(whatsappMessageId, recipientJid, now, now, orderId);
    insertLogStmt.run(orderId, 'sent', `WhatsApp confirmed message delivery (${whatsappMessageId})`, now);
  });
  tx();
}

const markOrderRetryOrFailStmt = db.prepare(`
  UPDATE orders
  SET status = ?, next_retry_at = ?, last_error = ?, updated_at = ?
  WHERE order_id = ?
`);

export function markOrderRetryOrFail(
  orderId: string,
  nextStatus: 'pending' | 'failed',
  nextRetryAt: number | null,
  errorMessage: string,
): void {
  const now = Date.now();
  const tx = db.transaction(() => {
    markOrderRetryOrFailStmt.run(nextStatus, nextRetryAt, errorMessage, now, orderId);
    insertLogStmt.run(
      orderId,
      nextStatus === 'pending' ? 'retry_scheduled' : 'failed',
      errorMessage,
      now,
    );
  });
  tx();
}

const releaseOrderBackToPendingStmt = db.prepare(`
  UPDATE orders
  SET status = 'pending', attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
      next_retry_at = ?, last_error = ?, updated_at = ?
  WHERE order_id = ? AND status = 'sending'
`);

export function releaseOrderWithoutAttemptPenalty(orderId: string, reason: string): void {
  const now = Date.now();
  releaseOrderBackToPendingStmt.run(now + 3000, reason, now, orderId);
}

const manualRetryStmt = db.prepare(`
  UPDATE orders
  SET status = 'pending', next_retry_at = ?, max_attempts = CASE WHEN attempts >= max_attempts THEN attempts + 3 ELSE max_attempts END,
      updated_at = ?
  WHERE order_id = ? AND status IN ('failed', 'pending')
`);

export function queueManualRetry(orderId: string): boolean {
  const now = Date.now();
  const tx = db.transaction(() => {
    const res = manualRetryStmt.run(now, now, orderId);
    if (res.changes > 0) {
      insertLogStmt.run(orderId, 'manual_retry', 'Operator triggered manual retry from dashboard', now);
      return true;
    }
    return false;
  });
  return tx();
}

const recoverInterruptedStmt = db.prepare(`
  UPDATE orders
  SET status = 'failed',
      last_error = 'Process stopped before WhatsApp delivery confirmation; verify before retrying',
      updated_at = ?
  WHERE status = 'sending'
`);

export function recoverInterruptedSendingOrders(): number {
  const res = recoverInterruptedStmt.run(Date.now());
  return res.changes;
}

export interface OrderStats {
  total: number;
  sent: number;
  pending: number;
  failed: number;
}

const statsStmt = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
    SUM(CASE WHEN status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
  FROM orders
`);

export function getOrderStats(): OrderStats {
  const row = statsStmt.get() as {
    total: number;
    sent: number | null;
    pending: number | null;
    failed: number | null;
  };
  return {
    total: row.total || 0,
    sent: row.sent || 0,
    pending: row.pending || 0,
    failed: row.failed || 0,
  };
}

export function listOrders(statusFilter?: string, search?: string, limit = 100): StoredOrderRecord[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (statusFilter && statusFilter !== 'all') {
    if (statusFilter === 'pending') {
      conditions.push("status IN ('pending', 'sending')");
    } else {
      conditions.push('status = ?');
      params.push(statusFilter);
    }
  }

  if (search && search.trim()) {
    const like = `%${search.trim()}%`;
    conditions.push('(order_id LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
    params.push(like, like, like);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM orders ${whereClause} ORDER BY created_at DESC LIMIT ?`;
  params.push(Math.min(Math.max(limit, 1), 250));

  return db.prepare(sql).all(...params) as StoredOrderRecord[];
}

const getOrderLogsStmt = db.prepare(
  'SELECT * FROM notification_logs WHERE order_id = ? ORDER BY created_at DESC LIMIT 30',
);

export function getOrderLogs(orderId: string): NotificationLogRecord[] {
  return getOrderLogsStmt.all(orderId) as NotificationLogRecord[];
}
