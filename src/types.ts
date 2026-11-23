export type WhatsAppConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface AuthStatusResponse {
  ok: boolean;
  claimed: boolean;
  envPasswordConfigured: boolean;
}

export interface WhatsAppStatusResponse {
  ok: boolean;
  status: WhatsAppConnectionStatus;
  statusDetail: string;
  qrDataUrl: string | null;
  connectedPhone: string | null;
  connectedPushName: string | null;
  lastError: string | null;
  updatedAt: number;
  expectedSenderDigits: string;
  senderMismatch: boolean;
}

export interface ConfigResponse {
  ok: boolean;
  senderNumber: string;
  recipientNumber: string;
  defaultCountryCode: string;
  senderJidPreview: string;
  recipientJidPreview: string;
  webhookSecretSource: 'env' | 'stored' | 'none';
  receiptAllowedHosts: string | null;
}

export interface OrderItem {
  name: string;
  quantity: number;
  price: number;
  notes?: string;
}

export type OrderNotificationStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface OrderRecord {
  id: number;
  orderId: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: string;
  items: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  totalAmount: number;
  currency: string;
  customerNotes: string;
  paymentMethod: string;
  walletName: string;
  transferReference: string;
  paymentReceiptUrl: string;
  formattedMessage: string;
  status: OrderNotificationStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number | null;
  lastError: string | null;
  whatsappMessageId: string | null;
  recipientJid: string | null;
  createdAt: number;
  updatedAt: number;
  sentAt: number | null;
}

export interface OrderStats {
  total: number;
  sent: number;
  pending: number;
  failed: number;
}

export interface OrdersHistoryResponse {
  ok: boolean;
  stats: OrderStats;
  orders: OrderRecord[];
}

export interface OrderLogEntry {
  id: number;
  order_id: string;
  event_type: string;
  detail: string;
  created_at: number;
}
