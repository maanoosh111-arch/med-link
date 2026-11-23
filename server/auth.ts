import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getSetting, setSetting, setSettingIfUnset } from './db.ts';

const EPHEMERAL_SESSION_SECRET = crypto.randomBytes(32);
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 12;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function getSessionSecretKey(): Buffer {
  const envSecret = (process.env.SESSION_SECRET || '').trim();
  if (envSecret) {
    return crypto.createHash('sha256').update(envSecret).digest();
  }
  return EPHEMERAL_SESSION_SECRET;
}

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyHashedPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, hexDigest] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hexDigest, 'hex');
  if (derived.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

export function isEnvDashboardPasswordConfigured(): boolean {
  return Boolean((process.env.DASHBOARD_PASSWORD || '').trim());
}

export function isDashboardClaimed(): boolean {
  if (isEnvDashboardPasswordConfigured()) {
    return true;
  }
  return Boolean(getSetting('admin_password_hash'));
}

export function claimInitialDashboardPassword(password: string): boolean {
  if (isEnvDashboardPasswordConfigured()) {
    return false;
  }
  const hash = hashPassword(password);
  return setSettingIfUnset('admin_password_hash', hash);
}

export function verifyDashboardPassword(password: string): boolean {
  const envPassword = (process.env.DASHBOARD_PASSWORD || '').trim();
  if (envPassword) {
    return timingSafeCompare(password, envPassword);
  }
  const storedHash = getSetting('admin_password_hash');
  if (!storedHash) {
    return false;
  }
  return verifyHashedPassword(password, storedHash);
}

export function issueDashboardToken(): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'operator',
      exp: expiresAt,
      nonce: crypto.randomBytes(8).toString('hex'),
    }),
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecretKey())
    .update(payload)
    .digest('base64url');
  return {
    token: `${payload}.${sig}`,
    expiresAt,
  };
}

export function verifyDashboardToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', getSessionSecretKey())
    .update(payload)
    .digest('base64url');

  if (!timingSafeCompare(sig, expectedSig)) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string;
      exp?: number;
    };
    if (parsed.sub !== 'operator' || typeof parsed.exp !== 'number') {
      return false;
    }
    return parsed.exp > Date.now();
  } catch {
    return false;
  }
}

export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.header('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return;
  }
  const token = match[1].trim();
  if (!verifyDashboardToken(token)) {
    res.status(401).json({ ok: false, error: 'Session expired or invalid' });
    return;
  }
  next();
}

export function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record || record.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return { allowed: true };
  }
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((record.resetAt - now) / 1000),
    };
  }
  record.count += 1;
  return { allowed: true };
}

export function clearLoginRateLimit(ip: string): void {
  loginAttempts.delete(ip);
}

// Webhook secret management
export function getWebhookSecretSource(): 'env' | 'stored' | 'none' {
  if ((process.env.WEBHOOK_SECRET || '').trim()) {
    return 'env';
  }
  if (getSetting('webhook_secret_hash')) {
    return 'stored';
  }
  return 'none';
}

export function generateAndStoreWebhookSecret(): string {
  const plainSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(plainSecret).digest('hex');
  setSetting('webhook_secret_hash', hash);
  return plainSecret;
}

export function verifyWebhookRequest(req: Request): { authorized: boolean; reason?: string } {
  const envSecret = (process.env.WEBHOOK_SECRET || '').trim();
  const storedHash = getSetting('webhook_secret_hash');

  if (!envSecret && !storedHash) {
    return {
      authorized: false,
      reason: 'Webhook secret is not configured on the server',
    };
  }

  let candidate = (req.header('x-webhook-secret') || '').trim();
  if (!candidate) {
    const authHeader = (req.header('authorization') || '').trim();
    const bearer = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearer) {
      candidate = bearer[1].trim();
    }
  }

  if (!candidate) {
    return {
      authorized: false,
      reason: 'Missing X-Webhook-Secret or Authorization Bearer header',
    };
  }

  if (envSecret) {
    return timingSafeCompare(candidate, envSecret)
      ? { authorized: true }
      : { authorized: false, reason: 'Invalid webhook secret' };
  }

  if (storedHash) {
    const candidateHash = crypto.createHash('sha256').update(candidate).digest('hex');
    return timingSafeCompare(candidateHash, storedHash)
      ? { authorized: true }
      : { authorized: false, reason: 'Invalid webhook secret' };
  }

  return { authorized: false, reason: 'Invalid webhook secret' };
}
