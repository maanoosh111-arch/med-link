import dns from 'node:dns/promises';
import net from 'node:net';

export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024; // 5 MB strict limit
const DOWNLOAD_TIMEOUT_MS = 15_000;

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export interface DownloadedReceipt {
  mimeType: string;
  base64: string;
  filename: string;
  byteSize: number;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isBlockedIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (net.isIPv4(normalized)) {
    return isBlockedIpv4(normalized);
  }
  if (net.isIPv6(normalized)) {
    if (normalized === '::1' || normalized === '::') return true;
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
    if (normalized.startsWith('::ffff:')) {
      const v4Part = normalized.slice(7);
      if (net.isIPv4(v4Part)) return isBlockedIpv4(v4Part);
    }
    // Unique local fc00::/7 or link-local fe80::/10
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return true;
    }
    return false;
  }
  return true;
}

function detectImageMimeFromMagicBytes(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // GIF: GIF87a or GIF89a
  if (
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) &&
    buf[5] === 0x61
  ) {
    return 'image/gif';
  }
  // WebP: RIFF....WEBP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

export function isDataImageUrl(value: string): boolean {
  return /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(value.trim());
}

export function parseValidatedDataImage(rawDataUrl: string): DownloadedReceipt {
  const match = rawDataUrl.trim().match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) {
    throw new Error('Payment receipt image data URL must be a valid base64 JPEG, PNG, WebP, or GIF');
  }

  const cleanBase64 = match[2].replace(/\s+/g, '');
  const estimatedBytes = Math.floor((cleanBase64.length * 3) / 4);
  if (estimatedBytes > MAX_RECEIPT_BYTES) {
    throw new Error('Payment receipt image exceeds 5 MB size limit');
  }

  const buffer = Buffer.from(cleanBase64, 'base64');
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_RECEIPT_BYTES) {
    throw new Error('Payment receipt image size is invalid or exceeds 5 MB');
  }

  const detectedMime = detectImageMimeFromMagicBytes(buffer);
  if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
    throw new Error('Payment receipt image payload is not a valid JPEG, PNG, WebP, or GIF image');
  }

  return {
    mimeType: detectedMime,
    base64: buffer.toString('base64'),
    filename: `payment-receipt.${extensionForMime(detectedMime)}`,
    byteSize: buffer.byteLength,
  };
}

export async function validateReceiptUrlSafety(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid payment receipt URL format');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Payment receipt URL must use http or https protocol');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Payment receipt URL must not contain embedded credentials');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Payment receipt URL points to a blocked local hostname');
  }

  const allowedHostsEnv = (process.env.RECEIPT_ALLOWED_HOSTS || '').trim();
  if (allowedHostsEnv) {
    const allowlist = allowedHostsEnv
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
    const matches = allowlist.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
    if (!matches) {
      throw new Error(`Payment receipt host "${hostname}" is not in RECEIPT_ALLOWED_HOSTS`);
    }
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new Error('Payment receipt URL targets a private or reserved IP address');
    }
  } else {
    const records = await dns.lookup(hostname, { all: true });
    if (!records.length) {
      throw new Error('Could not resolve payment receipt hostname');
    }
    for (const rec of records) {
      if (isBlockedIp(rec.address)) {
        throw new Error('Payment receipt hostname resolves to a private or reserved IP address');
      }
    }
  }

  return parsed;
}

export async function validateReceiptInputSafety(rawInput: string): Promise<void> {
  if (isDataImageUrl(rawInput)) {
    parseValidatedDataImage(rawInput);
    return;
  }
  await validateReceiptUrlSafety(rawInput);
}

export async function fetchValidatedReceiptImage(rawInput: string): Promise<DownloadedReceipt> {
  if (isDataImageUrl(rawInput)) {
    return parseValidatedDataImage(rawInput);
  }

  const safeUrl = await validateReceiptUrlSafety(rawInput);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(safeUrl.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'image/jpeg,image/png,image/webp,image/gif',
      },
    });

    if (!response.ok) {
      throw new Error(`Receipt image download failed with HTTP ${response.status}`);
    }

    const contentTypeHeader = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentTypeHeader && !ALLOWED_MIME_TYPES.has(contentTypeHeader)) {
      throw new Error(`Unsupported receipt Content-Type "${contentTypeHeader}". Allowed: JPEG, PNG, WebP, GIF`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const declaredSize = Number(contentLengthHeader);
      if (!Number.isNaN(declaredSize) && declaredSize > MAX_RECEIPT_BYTES) {
        throw new Error(`Receipt image exceeds 5 MB size limit (${Math.round(declaredSize / 1024)} KB)`);
      }
    }

    if (!response.body) {
      throw new Error('Receipt image response had an empty body');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RECEIPT_BYTES) {
          await reader.cancel();
          throw new Error('Receipt image download aborted: exceeded 5 MB size limit');
        }
        chunks.push(value);
      }
    }

    const buffer = Buffer.concat(chunks, totalBytes);
    const detectedMime = detectImageMimeFromMagicBytes(buffer);
    if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
      throw new Error('Downloaded receipt file is not a valid JPEG, PNG, WebP, or GIF image');
    }

    return {
      mimeType: detectedMime,
      base64: buffer.toString('base64'),
      filename: `payment-receipt.${extensionForMime(detectedMime)}`,
      byteSize: buffer.byteLength,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Receipt image download timed out after 15 seconds');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
