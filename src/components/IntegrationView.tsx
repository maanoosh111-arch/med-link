import { useState } from 'react';
import { Check, Copy, ShieldCheck } from 'lucide-react';

export function IntegrationView() {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const basePrefix = window.location.pathname.startsWith('/med-link') ? '/med-link' : '';
  const webhookUrl = `${window.location.origin}${basePrefix}/api/orders`;

  const samplePayload = JSON.stringify(
    {
      orderId: 'ORD-2026-1042',
      customerName: 'أحمد محمود',
      customerPhone: '01012345678',
      deliveryAddress: '15 شارع عباس العقاد، مدينة نصر، القاهرة',
      items: [
        { name: 'برجر دبل تشيز', quantity: 2, price: 185 },
        { name: 'بطاطس بالجبنة', quantity: 1, price: 65, notes: 'بدون هالبينو' },
      ],
      subtotal: 435,
      deliveryFee: 25,
      totalAmount: 460,
      currency: 'ج.م',
      customerNotes: 'يرجى الاتصال عند الوصول للبوابة',
      paymentMethod: 'تحويل محفظة إلكترونية',
      walletName: 'Vodafone Cash',
      transferReference: 'VFC-8834201',
      paymentReceiptUrl: 'https://your-cdn.example.com/receipts/ord-1042.jpg',
    },
    null,
    2,
  );

  const nodeSnippet = `// Call this from your restaurant website backend right after saving the order
export async function notifyWhatsAppRelay(order) {
  const response = await fetch('${webhookUrl}', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': process.env.WHATSAPP_RELAY_SECRET,
    },
    body: JSON.stringify({
      orderId: String(order.id),
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      deliveryAddress: order.deliveryAddress,
      items: order.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        price: item.unitPrice,
        notes: item.notes || '',
      })),
      subtotal: order.subtotal,
      deliveryFee: order.deliveryFee,
      totalAmount: order.totalAmount,
      currency: 'ج.م',
      customerNotes: order.notes || '',
      paymentMethod: order.paymentMethod,
      walletName: order.walletName || '',
      transferReference: order.transferReference || '',
      // Optional signed/public HTTPS URL to the uploaded payment receipt image
      paymentReceiptUrl: order.receiptImageUrl || '',
    }),
  });

  if (!response.ok && response.status !== 409) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || 'Failed to queue WhatsApp notification');
  }
  return response.json();
}`;

  const curlSnippet = `curl -X POST "${webhookUrl}" \\
  -H "Content-Type: application/json" \\
  -H "X-Webhook-Secret: YOUR_WEBHOOK_SECRET" \\
  -d '${samplePayload}'`;

  async function copyText(id: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">
          Website Webhook Integration Guide
        </h2>
        <p className="text-sm text-slate-600 mt-1">
          Connect your existing restaurant website to this standalone relay over HTTPS without sharing database credentials.
        </p>
      </div>

      {/* Endpoint Summary */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200">
          <div>
            <div className="text-xs font-medium text-slate-500">Webhook Endpoint</div>
            <div className="text-sm font-mono font-medium text-slate-900 mt-1 break-all">
              POST {webhookUrl}
            </div>
          </div>
          <button
            type="button"
            onClick={() => copyText('url', webhookUrl)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer shrink-0 whitespace-nowrap"
          >
            {copiedId === 'url' ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedId === 'url' ? 'Copied URL' : 'Copy URL'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-700">
          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="font-semibold text-slate-900">Authentication Header</div>
            <p className="font-mono text-slate-700">X-Webhook-Secret: &lt;YOUR_SECRET&gt;</p>
            <p className="text-slate-500">Or Authorization: Bearer &lt;YOUR_SECRET&gt;</p>
          </div>
          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1">
            <div className="font-semibold text-slate-900">Deduplication & Queue Behavior</div>
            <p className="text-slate-600">
              Returns <span className="font-mono">202 Accepted</span> when queued, or{' '}
              <span className="font-mono">409 Conflict</span> if <span className="font-mono">orderId</span> was already received.
            </p>
          </div>
        </div>
      </div>

      {/* Receipt Security Rules */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <ShieldCheck className="w-4 h-4 text-emerald-700" />
          Sending the Actual Payment Receipt Image (Not a Link)
        </div>
        <p className="text-xs text-slate-600 leading-relaxed">
          Pass either a hosted image URL or a direct <span className="font-mono text-slate-800">data:image/...;base64,...</span>{' '}
          image payload in <span className="font-mono text-slate-800">paymentReceiptUrl</span> (or{' '}
          <span className="font-mono text-slate-800">paymentReceiptBase64</span>). This relay downloads or decodes the actual image
          bytes server-side, verifies its binary signature, and sends the <strong>actual photo attachment directly in WhatsApp</strong>{' '}
          with the Arabic order summary as the caption (no image URL text is included in the message).
        </p>
        <ul className="text-xs text-slate-600 list-disc list-inside space-y-1">
          <li>Allowed formats: JPEG, PNG, WebP, GIF (verified by binary file signature).</li>
          <li>Maximum receipt image size: 5 MB.</li>
          <li>Private, loopback, and metadata IPs are blocked; set <span className="font-mono">RECEIPT_ALLOWED_HOSTS</span> in production to pin your storage domain when using URLs.</li>
          <li>Never call this webhook directly from browser JavaScript so your <span className="font-mono">WEBHOOK_SECRET</span> remains strictly server-side.</li>
        </ul>
      </div>

      {/* Node.js / Backend Code */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold text-slate-900">Backend Integration (Node.js / Next.js / Express)</h3>
          <button
            type="button"
            onClick={() => copyText('node', nodeSnippet)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md cursor-pointer"
          >
            {copiedId === 'node' ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedId === 'node' ? 'Copied' : 'Copy Code'}
          </button>
        </div>
        <pre className="p-5 bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto leading-relaxed">
          <code>{nodeSnippet}</code>
        </pre>
      </div>

      {/* cURL Test Example */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
          <h3 className="text-sm font-semibold text-slate-900">cURL Verification Command</h3>
          <button
            type="button"
            onClick={() => copyText('curl', curlSnippet)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md cursor-pointer"
          >
            {copiedId === 'curl' ? <Check className="w-3.5 h-3.5 text-emerald-700" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedId === 'curl' ? 'Copied' : 'Copy Command'}
          </button>
        </div>
        <pre className="p-5 bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto leading-relaxed">
          <code>{curlSnippet}</code>
        </pre>
      </div>
    </div>
  );
}
