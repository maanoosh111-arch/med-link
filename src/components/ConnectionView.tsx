import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  LogOut,
  QrCode,
  Send,
  Smartphone,
  WifiOff,
} from 'lucide-react';
import { api } from '../api';
import type { ConfigResponse, WhatsAppStatusResponse } from '../types';

interface ConnectionViewProps {
  waStatus: WhatsAppStatusResponse | null;
  config: ConfigResponse | null;
  onRefreshStatus: () => Promise<void>;
}

export function ConnectionView({ waStatus, config, onRefreshStatus }: ConnectionViewProps) {
  const [busyAction, setBusyAction] = useState<'generate_qr' | 'disconnect' | 'test' | null>(null);
  const [testMode, setTestMode] = useState<'sample_order' | 'text'>('sample_order');
  const [customTestText, setCustomTestText] = useState(
    'رسالة اختبار: اتصال إشعارات الطلبات يعمل بنجاح ✅',
  );
  const [actionFeedback, setActionFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const fastPollTimerRef = useRef<number | null>(null);

  const status = waStatus?.status ?? 'disconnected';

  useEffect(() => {
    if (waStatus?.qrDataUrl || status === 'connected') {
      if (fastPollTimerRef.current !== null) {
        window.clearInterval(fastPollTimerRef.current);
        fastPollTimerRef.current = null;
      }
    }
  }, [waStatus?.qrDataUrl, status]);

  useEffect(() => {
    return () => {
      if (fastPollTimerRef.current !== null) {
        window.clearInterval(fastPollTimerRef.current);
      }
    };
  }, []);

  function startFastQrPolling() {
    if (fastPollTimerRef.current !== null) {
      window.clearInterval(fastPollTimerRef.current);
    }
    let ticks = 0;
    fastPollTimerRef.current = window.setInterval(() => {
      ticks += 1;
      void onRefreshStatus();
      if (ticks >= 25 && fastPollTimerRef.current !== null) {
        window.clearInterval(fastPollTimerRef.current);
        fastPollTimerRef.current = null;
      }
    }, 650);
  }

  async function handleGenerateNewQr() {
    setBusyAction('generate_qr');
    setActionFeedback(null);
    try {
      const res = await api.reconnectWhatsApp();
      setActionFeedback({ type: 'success', text: res.message });
      await onRefreshStatus();
      startFastQrPolling();
    } catch (err) {
      setActionFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to generate new QR code',
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDisconnect() {
    if (fastPollTimerRef.current !== null) {
      window.clearInterval(fastPollTimerRef.current);
      fastPollTimerRef.current = null;
    }
    setBusyAction('disconnect');
    setActionFeedback(null);
    try {
      const res = await api.disconnectWhatsApp();
      setActionFeedback({ type: 'success', text: res.message });
      await onRefreshStatus();
    } catch (err) {
      setActionFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to disconnect',
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSendTest() {
    setBusyAction('test');
    setActionFeedback(null);
    try {
      const res = await api.sendTestMessage({
        mode: testMode,
        message: testMode === 'text' ? customTestText : undefined,
      });
      setActionFeedback({
        type: 'success',
        text: `${res.message} (ID: ${res.messageId})`,
      });
    } catch (err) {
      setActionFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to send test message',
      });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">
            WhatsApp Web Connection
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Link the sender WhatsApp account via QR scan and verify delivery to the restaurant recipient.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleGenerateNewQr}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <QrCode className="w-4 h-4" />
            {busyAction === 'generate_qr' ? 'Generating QR...' : 'Generate New QR Code'}
          </button>

          {status !== 'disconnected' && (
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={busyAction !== null}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-700 bg-white border border-red-200 hover:bg-red-50 disabled:opacity-40 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <LogOut className="w-4 h-4" />
              {busyAction === 'disconnect' ? 'Disconnecting...' : 'Disconnect'}
            </button>
          )}
        </div>
      </div>

      {actionFeedback && (
        <div
          className={`p-3.5 rounded-lg border text-sm ${
            actionFeedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
          role="status"
        >
          {actionFeedback.text}
        </div>
      )}

      {waStatus?.senderMismatch && (
        <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Authenticated phone differs from configured Sender Number</p>
            <p className="text-amber-800 mt-1">
              Connected session is <span className="font-mono">+{waStatus.connectedPhone}</span>, while
              configured sender is <span className="font-mono">+{waStatus.expectedSenderDigits}</span>.
              Use Disconnect and scan the QR code with the intended sender phone if this was unintentional.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left: Live Connection & QR Code */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-4 pb-5 border-b border-slate-200">
              <div className="flex items-center gap-3">
                {status === 'connected' ? (
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                ) : status === 'connecting' ? (
                  <QrCode className="w-5 h-5 text-amber-600 shrink-0" />
                ) : (
                  <WifiOff className="w-5 h-5 text-red-600 shrink-0" />
                )}
                <div>
                  <div className="text-xs font-medium text-slate-500">Session State</div>
                  <div className="text-lg font-semibold text-slate-900 flex items-center gap-2">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${
                        status === 'connected'
                          ? 'bg-emerald-600'
                          : status === 'connecting'
                            ? 'bg-amber-500'
                            : 'bg-red-600'
                      }`}
                      aria-hidden="true"
                    />
                    <span>
                      {status === 'connected'
                        ? 'Connected'
                        : status === 'connecting'
                          ? 'Connecting'
                          : 'Disconnected'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="text-right text-xs text-slate-500 tabular-nums">
                <div>Last update</div>
                <div className="font-mono text-slate-700 mt-0.5">
                  {waStatus?.updatedAt ? new Date(waStatus.updatedAt).toLocaleTimeString() : '—'}
                </div>
              </div>
            </div>

            <div className="py-5 space-y-4">
              <p className="text-sm text-slate-700">{waStatus?.statusDetail || 'Checking session status...'}</p>

              {waStatus?.lastError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-mono text-red-800 break-words">
                  Last error: {waStatus.lastError}
                </div>
              )}

              {status === 'connected' && (
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                    <dt className="text-xs text-slate-500">Authenticated Account</dt>
                    <dd className="text-sm font-mono font-medium text-slate-900 mt-1 tabular-nums">
                      {waStatus?.connectedPhone ? `+${waStatus.connectedPhone}` : 'Active Session'}
                    </dd>
                    {waStatus?.connectedPushName && (
                      <dd className="text-xs text-slate-500 mt-0.5">{waStatus.connectedPushName}</dd>
                    )}
                  </div>
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200">
                    <dt className="text-xs text-slate-500">Target Restaurant Recipient</dt>
                    <dd className="text-sm font-mono font-medium text-slate-900 mt-1 tabular-nums">
                      {config?.recipientNumber || '010 15678913'}
                    </dd>
                    <dd className="text-xs font-mono text-slate-500 mt-0.5">
                      {config?.recipientJidPreview || '201015678913@c.us'}
                    </dd>
                  </div>
                </dl>
              )}

              {waStatus?.qrDataUrl && status !== 'connected' && (
                <div className="flex flex-col sm:flex-row items-center gap-6 p-5 bg-slate-50 border border-slate-200 rounded-xl">
                  <div className="bg-white p-3 border border-slate-200 rounded-lg shrink-0">
                    <img
                      src={waStatus.qrDataUrl}
                      alt="WhatsApp Web QR Code"
                      className="w-52 h-52 block"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                  <div className="space-y-2.5 text-sm text-slate-700">
                    <div className="font-semibold text-slate-900 flex items-center gap-2">
                      <Smartphone className="w-4 h-4 text-emerald-700" />
                      Scan with Sender WhatsApp
                    </div>
                    <ol className="list-decimal list-inside space-y-1.5 text-slate-600 text-xs leading-relaxed">
                      <li>Open WhatsApp on the sender phone ({config?.senderNumber || '01204457813'}).</li>
                      <li>Go to Settings or Menu → Linked Devices → Link a Device.</li>
                      <li>Point the camera at this QR code to keep the session persistent across restarts.</li>
                    </ol>
                  </div>
                </div>
              )}

              {!waStatus?.qrDataUrl && status === 'connecting' && (
                <div className="p-6 rounded-lg bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-sm text-slate-600">
                  <span>Initializing headless Chromium and waiting for WhatsApp Web QR handshake...</span>
                  <button
                    type="button"
                    onClick={handleGenerateNewQr}
                    disabled={busyAction !== null}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <QrCode className="w-4 h-4" />
                    {busyAction === 'generate_qr' ? 'Generating...' : 'Generate New QR Code'}
                  </button>
                </div>
              )}

              {!waStatus?.qrDataUrl && status === 'disconnected' && (
                <div className="p-6 rounded-lg bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="text-sm text-slate-700">
                    No active QR code or linked session. Click to generate a fresh WhatsApp Web QR code immediately.
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerateNewQr}
                    disabled={busyAction !== null}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <QrCode className="w-4 h-4" />
                    {busyAction === 'generate_qr' ? 'Generating...' : 'Generate New QR Code'}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 text-xs text-slate-500 flex flex-wrap items-center gap-2">
            <span>Session persistence: LocalAuth server storage</span>
            <span aria-hidden="true">·</span>
            <span>Credentials never leave the backend</span>
          </div>
        </div>

        {/* Right: Send Test Message */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="pb-4 border-b border-slate-200">
              <h3 className="text-base font-semibold text-slate-900">Send Test Notification</h3>
              <p className="text-xs text-slate-500 mt-1">
                Dispatch a live verification message to{' '}
                <span className="font-mono text-slate-700">{config?.recipientNumber || '010 15678913'}</span>.
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setTestMode('sample_order')}
                className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  testMode === 'sample_order'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sample Arabic Order
              </button>
              <button
                type="button"
                onClick={() => setTestMode('text')}
                className={`flex-1 py-1.5 px-3 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  testMode === 'text'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Custom Text
              </button>
            </div>

            {testMode === 'sample_order' ? (
              <div
                dir="rtl"
                className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 whitespace-pre-wrap leading-relaxed font-sans"
              >
                {'طلب جديد 🔔\n\nرقم الطلب: #TEST-4821\n\n👤 بيانات العميل:\nالاسم: عميل تجريبي\nرقم الهاتف: 01000000000\nالعنوان: شارع التحرير، وسط البلد، القاهرة\n\n🛒 تفاصيل الطلب:\n• 2 × وجبة مشويات مشكلة — 480 ج.م\n• 1 × سلطة طحينة — 35 ج.م\nالمجموع الفرعي: 515 ج.م\nرسوم التوصيل: 30 ج.م\n\n💰 تفاصيل الدفع:\nطريقة الدفع: تحويل محفظة إلكترونية\nالمحفظة: Vodafone Cash\nرقم التحويل: TEST-REF-9021\n\nالإجمالي: 545 ج.م'}
              </div>
            ) : (
              <div>
                <label htmlFor="custom-test-msg" className="block text-xs font-medium text-slate-700 mb-1.5">
                  Message Text
                </label>
                <textarea
                  id="custom-test-msg"
                  dir="rtl"
                  rows={5}
                  value={customTestText}
                  onChange={(e) => setCustomTestText(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleSendTest}
            disabled={busyAction !== null || status !== 'connected'}
            className="mt-5 w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 text-sm font-medium text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-45 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
          >
            <Send className="w-4 h-4" />
            {busyAction === 'test'
              ? 'Sending...'
              : status === 'connected'
                ? 'Send Test Message'
                : 'Connect WhatsApp First'}
          </button>
        </div>
      </div>
    </div>
  );
}
