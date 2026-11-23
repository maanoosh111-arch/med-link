import type {
  AuthStatusResponse,
  ConfigResponse,
  OrderLogEntry,
  OrdersHistoryResponse,
  WhatsAppStatusResponse,
} from './types';

let inMemoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryToken;
}

const API_PREFIX =
  typeof window !== 'undefined' && window.location.pathname.startsWith('/med-link')
    ? '/med-link'
    : '';

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (inMemoryToken) {
    headers.set('Authorization', `Bearer ${inMemoryToken}`);
  }

  const res = await fetch(`${API_PREFIX}${url}`, {
    ...init,
    headers,
  });

  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string; message?: string };

  if (res.status === 401 && inMemoryToken) {
    inMemoryToken = null;
  }

  if (!res.ok) {
    throw new Error(data.error || data.message || `Request failed (${res.status})`);
  }

  return data;
}

export const api = {
  getAuthStatus: () => request<AuthStatusResponse>('/api/auth/status'),
  setupAdminPassword: (password: string) =>
    request<{ ok: boolean; token: string; expiresAt: number }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  login: (password: string) =>
    request<{ ok: boolean; token: string; expiresAt: number }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  verifySession: () => request<{ ok: boolean }>('/api/auth/verify'),

  getWhatsAppStatus: () => request<WhatsAppStatusResponse>('/api/whatsapp/status'),
  connectWhatsApp: () =>
    request<{ ok: boolean; message: string }>('/api/whatsapp/connect', { method: 'POST' }),
  reconnectWhatsApp: () =>
    request<{ ok: boolean; message: string }>('/api/whatsapp/reconnect', { method: 'POST' }),
  disconnectWhatsApp: () =>
    request<{ ok: boolean; message: string }>('/api/whatsapp/disconnect', { method: 'POST' }),
  logoutWhatsApp: () =>
    request<{ ok: boolean; message: string }>('/api/whatsapp/logout', { method: 'POST' }),

  getConfig: () => request<ConfigResponse>('/api/config'),
  updateConfig: (payload: {
    senderNumber: string;
    recipientNumber: string;
    defaultCountryCode: string;
  }) =>
    request<ConfigResponse>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  generateWebhookSecret: () =>
    request<{ ok: boolean; secret: string; message: string }>('/api/config/webhook-secret', {
      method: 'POST',
    }),

  getOrdersHistory: (status: string, search: string) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (search.trim()) params.set('search', search.trim());
    return request<OrdersHistoryResponse>(`/api/orders/history?${params.toString()}`);
  },
  getOrderLogs: (orderId: string) =>
    request<{ ok: boolean; logs: OrderLogEntry[] }>(`/api/orders/${encodeURIComponent(orderId)}/logs`),
  retryOrder: (orderId: string) =>
    request<{ ok: boolean; message: string }>(`/api/orders/${encodeURIComponent(orderId)}/retry`, {
      method: 'POST',
    }),

  sendTestMessage: (payload: { mode: 'sample_order' | 'text'; message?: string }) =>
    request<{ ok: boolean; messageId: string; recipientJid: string; message: string }>(
      '/api/test-message',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),
};
