import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, Info, KeyRound, Save } from 'lucide-react';
import { api } from '../api';
import type { ConfigResponse } from '../types';

interface ConfigViewProps {
  config: ConfigResponse | null;
  onConfigUpdated: (next: ConfigResponse) => void;
}

export function ConfigView({ config, onConfigUpdated }: ConfigViewProps) {
  const [senderNumber, setSenderNumber] = useState(config?.senderNumber || '01204457813');
  const [recipientNumber, setRecipientNumber] = useState(config?.recipientNumber || '010 15678913');
  const [defaultCountryCode, setDefaultCountryCode] = useState(config?.defaultCountryCode || '20');
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [generatingSecret, setGeneratingSecret] = useState(false);
  const [newSecretOnce, setNewSecretOnce] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  useEffect(() => {
    if (config && !isDirty) {
      setSenderNumber(config.senderNumber);
      setRecipientNumber(config.recipientNumber);
      setDefaultCountryCode(config.defaultCountryCode);
    }
  }, [config?.senderNumber, config?.recipientNumber, config?.defaultCountryCode, isDirty]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const updated = await api.updateConfig({
        senderNumber,
        recipientNumber,
        defaultCountryCode,
      });
      setSenderNumber(updated.senderNumber);
      setRecipientNumber(updated.recipientNumber);
      setDefaultCountryCode(updated.defaultCountryCode);
      setIsDirty(false);
      onConfigUpdated(updated);
      setFeedback({ type: 'success', text: 'WhatsApp number configuration saved.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update configuration',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleGenerateSecret() {
    setGeneratingSecret(true);
    setFeedback(null);
    setNewSecretOnce(null);
    try {
      const res = await api.generateWebhookSecret();
      setNewSecretOnce(res.secret);
      const refreshed = await api.getConfig();
      onConfigUpdated(refreshed);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to generate webhook secret',
      });
    } finally {
      setGeneratingSecret(false);
    }
  }

  async function handleCopySecret() {
    if (!newSecretOnce) return;
    await navigator.clipboard.writeText(newSecretOnce);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 2000);
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900 tracking-tight">
          WhatsApp & Webhook Configuration
        </h2>
        <p className="text-sm text-slate-600 mt-1">
          Configure sender and restaurant recipient phone numbers and manage webhook authentication.
        </p>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-lg border text-sm ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-red-50 border-red-200 text-red-800'
          }`}
          role="status"
        >
          {feedback.text}
        </div>
      )}

      <form onSubmit={handleSave} className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
        <div className="pb-4 border-b border-slate-200">
          <h3 className="text-base font-semibold text-slate-900">WhatsApp Phone Numbers</h3>
          <p className="text-xs text-slate-500 mt-1">
            Local numbers beginning with 0 are normalized with the Default Country Calling Code.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label htmlFor="sender-number" className="block text-sm font-medium text-slate-800 mb-1.5">
              WhatsApp Sender Number
            </label>
            <input
              id="sender-number"
              type="text"
              required
              value={senderNumber}
              onChange={(e) => {
                setSenderNumber(e.target.value);
                setIsDirty(true);
              }}
              placeholder="01204457813"
              className="w-full px-3.5 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
            <p className="mt-1.5 text-xs text-slate-500">
              Resolved ID: <span className="font-mono text-slate-700">{config?.senderJidPreview || '—'}</span>
            </p>
          </div>

          <div>
            <label htmlFor="recipient-number" className="block text-sm font-medium text-slate-800 mb-1.5">
              WhatsApp Recipient Number
            </label>
            <input
              id="recipient-number"
              type="text"
              required
              value={recipientNumber}
              onChange={(e) => {
                setRecipientNumber(e.target.value);
                setIsDirty(true);
              }}
              placeholder="010 15678913"
              className="w-full px-3.5 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
            />
            <p className="mt-1.5 text-xs text-slate-500">
              Resolved ID: <span className="font-mono text-slate-700">{config?.recipientJidPreview || '—'}</span>
            </p>
          </div>
        </div>

        <div className="max-w-xs">
          <label htmlFor="country-code" className="block text-sm font-medium text-slate-800 mb-1.5">
            Default Country Calling Code
          </label>
          <input
            id="country-code"
            type="text"
            required
            value={defaultCountryCode}
            onChange={(e) => {
              setDefaultCountryCode(e.target.value);
              setIsDirty(true);
            }}
            placeholder="20"
            className="w-full px-3.5 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600"
          />
          <p className="mt-1.5 text-xs text-slate-500">
            Example: <span className="font-mono">20</span> for Egypt (+20).
          </p>
        </div>

        <div className="p-4 rounded-lg bg-slate-50 border border-slate-200 flex items-start gap-3 text-xs text-slate-700">
          <Info className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
          <p className="leading-relaxed">
            <strong>Important:</strong> The sender number represents the WhatsApp account that will be
            authenticated via the QR code on the Connection tab. Entering or changing a sender phone number
            here does <strong>not</strong> authenticate that account—you must scan the QR code from that
            device.
          </p>
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </form>

      {/* Webhook Secret Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200">
          <div>
            <h3 className="text-base font-semibold text-slate-900 flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-slate-700" />
              Webhook Secret Authentication
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Protects <span className="font-mono">POST /api/orders</span> so only your restaurant website can submit orders.
            </p>
          </div>

          <div className="text-xs font-medium text-slate-700">
            Status:{' '}
            {config?.webhookSecretSource === 'env' ? (
              <span className="text-emerald-700">Configured via WEBHOOK_SECRET env</span>
            ) : config?.webhookSecretSource === 'stored' ? (
              <span className="text-emerald-700">Active (hashed on server)</span>
            ) : (
              <span className="text-red-700">Not configured</span>
            )}
          </div>
        </div>

        <p className="text-xs text-slate-600 leading-relaxed">
          For security, existing webhook secrets are never sent back to the browser.
          {config?.webhookSecretSource === 'env'
            ? ' Your WEBHOOK_SECRET environment variable is active and takes precedence.'
            : ' Click below to generate a fresh secret and copy it into your website backend environment.'}
        </p>

        {newSecretOnce && (
          <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 space-y-2">
            <div className="text-xs font-semibold text-emerald-900">
              New Webhook Secret (shown once — copy now):
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-white border border-emerald-200 rounded-md font-mono text-xs text-slate-900 break-all">
                {newSecretOnce}
              </code>
              <button
                type="button"
                onClick={handleCopySecret}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-emerald-900 bg-white border border-emerald-300 hover:bg-emerald-100 rounded-md cursor-pointer shrink-0"
              >
                {copiedSecret ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedSecret ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {config?.webhookSecretSource !== 'env' && (
          <div>
            <button
              type="button"
              onClick={handleGenerateSecret}
              disabled={generatingSecret}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded-lg cursor-pointer whitespace-nowrap"
            >
              <KeyRound className="w-4 h-4" />
              {generatingSecret
                ? 'Generating...'
                : config?.webhookSecretSource === 'stored'
                  ? 'Rotate Webhook Secret'
                  : 'Generate Webhook Secret'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
