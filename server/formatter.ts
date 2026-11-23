export interface OrderItemInput {
  name: string;
  quantity: number;
  price: number;
  notes?: string;
}

export interface NormalizedOrderPayload {
  orderId: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  items: OrderItemInput[];
  subtotal: number;
  deliveryFee: number;
  totalAmount: number;
  currency: string;
  customerNotes: string;
  paymentMethod: string;
  walletName: string;
  transferReference: string;
  paymentReceiptUrl: string;
}

function formatMoney(amount: number, currency: string): string {
  const formatted = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${formatted} ${currency}`.trim();
}

export function formatArabicOrderMessage(order: NormalizedOrderPayload): string {
  const currency = order.currency || 'ج.م';

  const itemLines = order.items.map((item) => {
    const lineTotal = item.price * item.quantity;
    const base = `• ${item.quantity} × ${item.name} — ${formatMoney(lineTotal, currency)}`;
    const noteSuffix = item.notes?.trim() ? ` (${item.notes.trim()})` : '';
    return `${base}${noteSuffix}`;
  });

  if (order.subtotal > 0) {
    itemLines.push(`المجموع الفرعي: ${formatMoney(order.subtotal, currency)}`);
  }
  if (order.deliveryFee > 0) {
    itemLines.push(`رسوم التوصيل: ${formatMoney(order.deliveryFee, currency)}`);
  }

  const paymentLines: string[] = [
    `طريقة الدفع: ${order.paymentMethod}`,
  ];

  if (order.walletName.trim()) {
    paymentLines.push(`المحفظة: ${order.walletName.trim()}`);
  }

  if (order.transferReference.trim()) {
    paymentLines.push(`رقم التحويل: ${order.transferReference.trim()}`);
  }

  const sections: string[] = [
    'طلب جديد 🔔',
    '',
    `رقم الطلب: #${order.orderId}`,
    '',
    '👤 بيانات العميل:',
    `الاسم: ${order.customerName}`,
    `رقم الهاتف: ${order.customerPhone}`,
    `العنوان: ${order.deliveryAddress}`,
    '',
    '🛒 تفاصيل الطلب:',
    ...itemLines,
    '',
    '💰 تفاصيل الدفع:',
    ...paymentLines,
    '',
    `الإجمالي: ${formatMoney(order.totalAmount, currency)}`,
  ];

  if (order.customerNotes.trim()) {
    sections.push('', '📝 ملاحظات العميل:', order.customerNotes.trim());
  }

  return sections.join('\n');
}
