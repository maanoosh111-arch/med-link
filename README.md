# OrderRelay — Standalone WhatsApp Order Notification Tool

A standalone Node.js + Express + `whatsapp-web.js` service that receives restaurant orders over an authenticated HTTP webhook (`POST /api/orders`) and relays clean, structured Arabic WhatsApp notifications—including payment receipt image attachments—via a persistent SQLite queue.

This application runs completely independently from your restaurant website and database.

---

## Important Notice: Unofficial WhatsApp Web Limitations

Before deploying or connecting an account, please review these operational realities:

1. **Unofficial Integration**: `whatsapp-web.js` automates the WhatsApp Web interface inside a headless Chromium browser via Puppeteer. It is **not** an official Meta WhatsApp Business Platform API integration.
2. **Account Restriction Risk**: Automated messaging violates WhatsApp's standard Terms of Service. Meta may temporarily rate-limit, restrict, or permanently ban accounts exhibiting automated behavior. Use a **dedicated secondary sender number** rather than your primary personal or business WhatsApp number, and send transactional order alerts only (never marketing broadcasts).
3. **No Delivery SLA / Upstream Breakage**: WhatsApp Web updates can occasionally disrupt `whatsapp-web.js` until a library patch is released. Incoming orders are safely persisted in SQLite (`data/relay.db`) while disconnected, and require manual or automatic retry once reconnected.
4. **QR Authentication Required**: Entering a sender phone number in Configuration (`01204457813`) only records which account you intend to use. You must still scan the QR code in the dashboard using WhatsApp's **Linked Devices** screen on that phone.
5. **Persistent Host Required**: Because Chromium and `LocalAuth` session files (`.wwebjs_auth/`) live on disk and maintain an active browser process, deploy this service on a persistent Node.js host (VPS, VM, Docker container with persistent volume, or Railway/Render persistent disk)—not stateless serverless functions.

---

## Architecture Overview

- `server.ts` — Express server mounting webhook intake (`POST /api/orders`), authenticated dashboard APIs, and frontend UI.
- `server/whatsapp.ts` — `whatsapp-web.js` client wrapper with `LocalAuth` persistence, QR data-URL generation, safe logout/reconnect, and confirmed message delivery.
- `server/queue.ts` — SQLite-backed background queue worker with crash recovery, disconnect pausing, and exponential backoff retries (`10s`, `30s`, `90s`, `270s`, up to 5 attempts).
- `server/formatter.ts` — Arabic WhatsApp notification formatter omitting empty optional fields.
- `server/media.ts` — SSRF-safe payment receipt downloader enforcing `http:`/`https:`, private IP/DNS blocking, `5 MB` max size, MIME header check, and binary magic-byte verification (JPEG/PNG/WebP/GIF).
- `server/auth.ts` — Dashboard login (`DASHBOARD_PASSWORD` env or first-run scrypt password claim) and constant-time webhook secret verification.
- `server/db.ts` — `better-sqlite3` database (`data/relay.db` in WAL mode) for configuration, deduplicated orders (`UNIQUE order_id`), and audit logs.
- `src/` — React + TypeScript + Tailwind CSS operational dashboard.

---

## Installation & Local Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment variables**:
   Copy `.env.example` to `.env` and set strong secrets:
   ```bash
   cp .env.example .env
   ```
   Recommended variables:
   - `PORT=3000`
   - `DASHBOARD_PASSWORD` — Password required to log into the dashboard. (If omitted in dev, the dashboard prompts once on first visit to set an admin password.)
   - `WEBHOOK_SECRET` — Secret key your restaurant website must send in `X-Webhook-Secret` (or `Authorization: Bearer`). If omitted, you can generate a server-side secret from the Configuration view.
   - `SESSION_SECRET` — Secret key used to sign dashboard session Bearer tokens.
   - `RECEIPT_ALLOWED_HOSTS` — Optional comma-separated domain allowlist for `paymentReceiptUrl` downloads (e.g., `cdn.myrestaurant.com,xyz.supabase.co`).
   - `PUPPETEER_EXECUTABLE_PATH` — Optional path to system Chromium binary if not using Puppeteer's bundled Chrome.

3. **Run in development**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000`.

4. **Build and run in production**:
   ```bash
   npm run build
   NODE_ENV=production npm start
   ```

---

## Configuration Defaults

On first boot, the Configuration table seeds:
- **WhatsApp Sender Number**: `01204457813`
- **WhatsApp Recipient Number**: `010 15678913`
- **Default Country Calling Code**: `20` (Egypt; local `01...` numbers normalize to `201...`)

Update these anytime from the **Configuration** tab in the dashboard.

---

## Webhook API (`POST /api/orders`)

### Request Headers
```http
Content-Type: application/json
X-Webhook-Secret: <YOUR_WEBHOOK_SECRET>
```

### Request JSON Body
```json
{
  "orderId": "ORD-2026-1042",
  "customerName": "أحمد محمود",
  "customerPhone": "01012345678",
  "deliveryAddress": "15 شارع عباس العقاد، مدينة نصر، القاهرة",
  "items": [
    { "name": "برجر دبل تشيز", "quantity": 2, "price": 185 },
    { "name": "بطاطس بالجبنة", "quantity": 1, "price": 65, "notes": "بدون هالبينو" }
  ],
  "subtotal": 435,
  "deliveryFee": 25,
  "totalAmount": 460,
  "currency": "ج.م",
  "customerNotes": "يرجى الاتصال عند الوصول للبوابة",
  "paymentMethod": "تحويل محفظة إلكترونية",
  "walletName": "Vodafone Cash",
  "transferReference": "VFC-8834201",
  "paymentReceiptUrl": "https://your-cdn.example.com/receipts/ord-1042.jpg"
}
```

### Responses
- `202 Accepted` — Order validated, stored in SQLite, and queued for WhatsApp delivery.
- `400 Bad Request` — Validation error or unsafe/invalid `paymentReceiptUrl`.
- `401 Unauthorized` — Missing or invalid `X-Webhook-Secret`.
- `409 Conflict` — Duplicate `orderId` rejected to prevent double WhatsApp notifications.
- `503 Service Unavailable` — Webhook secret has not been configured yet.

---

## Linux VPS / Docker Deployment Notes

When deploying on Ubuntu/Debian VPS or Docker, ensure Chromium's shared system libraries are installed (e.g., `libnss3`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libcups2`, `libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxrandr2`, `libgbm1`, `libasound2`) and mount persistent volumes for:
- `/app/data` (SQLite database `relay.db`)
- `/app/.wwebjs_auth` (WhatsApp Web persistent session)

Keep this service behind HTTPS (Nginx / Caddy / Cloud Run / Reverse Proxy) before exposing `POST /api/orders` to your restaurant website backend.
