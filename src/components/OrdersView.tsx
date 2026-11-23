import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  Image as ImageIcon,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { OrderLogEntry, OrderRecord, OrderStats } from '../types';

interface OrdersViewProps {
  stats: OrderStats;
  orders: OrderRecord[];
  statusFilter: string;
  searchQuery: string;
  loading: boolean;
  onStatusFilterChange: (next: string) => void;
  onSearchChange: (next: string) => void;
  onRefresh: () => Promise<void>;
}

export function OrdersView({
  stats,
  orders,
  statusFilter,
  searchQuery,
  loading,
  onStatusFilterChange,
  onSearchChange,
  onRefresh,
}: OrdersViewProps) {
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<OrderRecord | null>(null);
  const [selectedLogs, setSelectedLogs] = useState<OrderLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  async function handleRetry(orderId: string) {
    setRetryingId(orderId);
    setActionMsg(null);
    try {
      const res = await api.retryOrder(orderId);
      setActionMsg({ type: 'success', text: res.message });
      await onRefresh();
    } catch (err) {
      setActionMsg({
        type: 'error',
        text: err instanceof Error ? err.message : 'Retry failed',
      });
    } finally {
      setRetryingId(null);
    }
  }

  async function handleInspect(order: OrderRecord) {
    setSelectedOrder(order);
    setSelectedLogs([]);
    setLoadingLogs(true);
    try {
      const res = await api.getOrderLogs(order.orderId);
      setSelectedLogs(res.logs);
    } catch {
      setSelectedLogs([]);
    } finally {
      setLoadingLogs(false);
    }
  }

  const filterTabs = [
    { key: 'all', label: `All (${stats.total})` },
    { key: 'sent', label: `Sent (${stats.sent})` },
    { key: 'pending', label: `Pending (${stats.pending})` },
    { key: 'failed', label: `Failed (${stats.failed})` },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">
          Order Notification Queue & History
        </h2>
        <p className="text-sm text-slate-600 mt-1">
          Orders are persisted in SQLite and marked Sent only after WhatsApp confirms message delivery.
        </p>
      </div>

      {/* 4-column summary strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Total Received</div>
          <div className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-1">
            {stats.total}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Confirmed Sent</div>
          <div className="text-2xl font-semibold text-emerald-700 font-mono tabular-nums mt-1">
            {stats.sent}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Pending / Retrying</div>
          <div className="text-2xl font-semibold text-amber-700 font-mono tabular-nums mt-1">
            {stats.pending}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs text-slate-500">Failed</div>
          <div className="text-2xl font-semibold text-red-700 font-mono tabular-nums mt-1">
            {stats.failed}
          </div>
        </div>
      </div>

      {actionMsg && (
        <div
          className={`p-3.5 rounded-lg border text-sm ${
            actionMsg.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
        >
          {actionMsg.text}
        </div>
      )}

      {/* Filter & Search Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
            {filterTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => onStatusFilterChange(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 tabular-nums ${
                  statusFilter === tab.key
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="relative w-full md:w-72">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search order ID, customer, phone..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
          </div>
        </div>

        {/* High-Density Data Table */}
        {loading && orders.length === 0 ? (
          <div className="p-8 space-y-3">
            <div className="h-9 bg-slate-100 rounded animate-pulse" />
            <div className="h-9 bg-slate-100 rounded animate-pulse" />
            <div className="h-9 bg-slate-100 rounded animate-pulse" />
          </div>
        ) : orders.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-medium text-slate-900">No order notifications match this view</p>
            <p className="text-xs text-slate-500 mt-1">
              Incoming orders sent to POST /api/orders will appear here with real-time delivery status.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="py-2.5 px-4 whitespace-nowrap">Order ID</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Customer</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Payment</th>
                  <th className="py-2.5 px-4 whitespace-nowrap text-right">Total</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Status</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Last Error</th>
                  <th className="py-2.5 px-4 whitespace-nowrap text-right">Received</th>
                  <th className="py-2.5 px-4 whitespace-nowrap text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {orders.map((order) => (
                  <tr key={order.orderId} className="hover:bg-slate-50 transition-colors">
                    <td className="py-3 px-4 font-mono text-xs font-medium text-slate-900 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span>#{order.orderId}</span>
                        {order.paymentReceiptUrl && (
                          <span title="Includes payment receipt attachment">
                            <ImageIcon className="w-3.5 h-3.5 text-slate-400" />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="text-slate-900 font-medium text-xs">{order.customerName}</div>
                      <div className="text-slate-500 font-mono text-xs tabular-nums">
                        {order.customerPhone}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-700">
                      <div>{order.paymentMethod}</div>
                      {order.walletName && (
                        <div className="text-slate-500">{order.walletName}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs font-medium text-slate-900 tabular-nums whitespace-nowrap">
                      {order.totalAmount} {order.currency}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {order.status === 'sent' ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Sent
                        </span>
                      ) : order.status === 'failed' ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700">
                          <AlertCircle className="w-3.5 h-3.5" />
                          Failed ({order.attempts}/{order.maxAttempts})
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700">
                          <Clock className="w-3.5 h-3.5" />
                          {order.status === 'sending' ? 'Sending' : 'Pending'} ({order.attempts}/{order.maxAttempts})
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 max-w-xs">
                      {order.lastError ? (
                        <p className="text-xs text-red-700 truncate" title={order.lastError}>
                          {order.lastError}
                        </p>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                      {new Date(order.createdAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleInspect(order)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Inspect
                        </button>
                        {order.status !== 'sent' && (
                          <button
                            type="button"
                            onClick={() => handleRetry(order.orderId)}
                            disabled={retryingId === order.orderId}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-50 rounded-md cursor-pointer"
                          >
                            <RotateCcw
                              className={`w-3.5 h-3.5 ${retryingId === order.orderId ? 'animate-spin' : ''}`}
                            />
                            Retry
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Order Detail Modal */}
      {selectedOrder && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/50 flex items-center justify-center p-4"
          onClick={() => setSelectedOrder(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-xl max-w-2xl w-full max-h-[88vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900 font-mono">
                  Order #{selectedOrder.orderId}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Status: {selectedOrder.status} · Attempts: {selectedOrder.attempts}/{selectedOrder.maxAttempts}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="p-2 text-slate-500 hover:text-slate-900 rounded-lg cursor-pointer"
                aria-label="Close order details"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-5">
              {selectedOrder.lastError && (
                <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 font-mono break-words">
                  Last error: {selectedOrder.lastError}
                </div>
              )}

              <div>
                <div className="text-xs font-medium text-slate-600 mb-2">
                  Formatted Arabic WhatsApp Message
                </div>
                <div
                  dir="rtl"
                  className="p-4 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-800 whitespace-pre-wrap leading-relaxed"
                >
                  {selectedOrder.formattedMessage}
                </div>
              </div>

              {selectedOrder.paymentReceiptUrl && (
                <div>
                  <div className="text-xs font-medium text-slate-600 mb-1.5">
                    Payment Receipt Image Attachment
                  </div>
                  {selectedOrder.paymentReceiptUrl.startsWith('data:image/') ? (
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                      <img
                        src={selectedOrder.paymentReceiptUrl}
                        alt="Payment receipt attachment"
                        className="max-h-56 rounded-md border border-slate-200 object-contain"
                      />
                    </div>
                  ) : (
                    <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs font-mono text-slate-700 break-all">
                      {selectedOrder.paymentReceiptUrl}
                    </div>
                  )}
                </div>
              )}

              <div>
                <div className="text-xs font-medium text-slate-600 mb-2">Delivery Timeline</div>
                {loadingLogs ? (
                  <p className="text-xs text-slate-500">Loading logs...</p>
                ) : selectedLogs.length === 0 ? (
                  <p className="text-xs text-slate-500">No delivery log entries recorded.</p>
                ) : (
                  <div className="border border-slate-200 rounded-lg divide-y divide-slate-200">
                    {selectedLogs.map((entry) => (
                      <div key={entry.id} className="px-3.5 py-2.5 flex items-start justify-between gap-4 text-xs">
                        <div>
                          <span className="font-mono font-medium text-slate-800">{entry.event_type}</span>
                          <span className="text-slate-600 ml-2">{entry.detail}</span>
                        </div>
                        <span className="font-mono text-slate-400 tabular-nums shrink-0">
                          {new Date(entry.created_at).toLocaleTimeString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-3.5 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-3">
              {selectedOrder.status !== 'sent' && (
                <button
                  type="button"
                  onClick={async () => {
                    await handleRetry(selectedOrder.orderId);
                    setSelectedOrder(null);
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Retry Delivery Now
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
