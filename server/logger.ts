type LogLevel = 'info' | 'warn' | 'error';

const SENSITIVE_KEYS = new Set([
  'customerPhone',
  'customer_phone',
  'deliveryAddress',
  'delivery_address',
  'transferReference',
  'transfer_reference',
  'walletName',
  'wallet_name',
  'password',
  'secret',
  'token',
  'webhookSecret',
  'authorization',
  'x-webhook-secret',
]);

function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (SENSITIVE_KEYS.has(key)) {
      cleaned[key] = '[REDACTED]';
    } else if (value instanceof Error) {
      cleaned[key] = { name: value.name, message: value.message };
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function emit(level: LogLevel, event: string, meta?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  const safeMeta = sanitizeMeta(meta);
  if (safeMeta && Object.keys(safeMeta).length > 0) {
    entry.meta = safeMeta;
  }
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info: (event: string, meta?: Record<string, unknown>) => emit('info', event, meta),
  warn: (event: string, meta?: Record<string, unknown>) => emit('warn', event, meta),
  error: (event: string, meta?: Record<string, unknown>) => emit('error', event, meta),
};
