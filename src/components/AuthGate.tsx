import { useState, type FormEvent } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { api, setAuthToken } from '../api';

interface AuthGateProps {
  claimed: boolean;
  envPasswordConfigured: boolean;
  onAuthenticated: () => void;
}

export function AuthGate({ claimed, envPasswordConfigured, onAuthenticated }: AuthGateProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSetupMode = !claimed && !envPasswordConfigured;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (isSetupMode) {
      if (password.length < 6) {
        setError('Password must be at least 6 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = isSetupMode
        ? await api.setupAdminPassword(password)
        : await api.login(password);
      setAuthToken(res.token);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-slate-900 text-white flex items-center justify-center shrink-0">
            {isSetupMode ? <ShieldCheck className="w-5 h-5" /> : <Lock className="w-5 h-5" />}
          </div>
          <div>
            <h1 className="text-xl font-semibold text-slate-900 tracking-tight">
              {isSetupMode ? 'Set Operator Password' : 'OrderRelay Console'}
            </h1>
            <p className="text-sm text-slate-600">
              {isSetupMode
                ? 'Claim admin access before configuring WhatsApp and webhooks.'
                : 'Sign in to manage WhatsApp connection and order notifications.'}
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="dashboard-password" className="block text-sm font-medium text-slate-700 mb-1.5">
              {isSetupMode ? 'New Admin Password' : 'Dashboard Password'}
            </label>
            <input
              id="dashboard-password"
              type="password"
              required
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isSetupMode ? 'Minimum 6 characters' : 'Enter dashboard password'}
              className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600"
            />
          </div>

          {isSetupMode && (
            <div>
              <label htmlFor="confirm-password" className="block text-sm font-medium text-slate-700 mb-1.5">
                Confirm Password
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
                className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:border-emerald-600"
              />
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 px-4 text-sm font-medium text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap"
          >
            {submitting
              ? 'Verifying...'
              : isSetupMode
                ? 'Save Password & Enter Console'
                : 'Sign In'}
          </button>
        </form>

        <p className="mt-6 pt-5 border-t border-slate-200 text-xs text-slate-500 leading-relaxed">
          {envPasswordConfigured
            ? 'Authentication is managed by the DASHBOARD_PASSWORD environment variable.'
            : 'For production deployments, set DASHBOARD_PASSWORD in your environment variables.'}
        </p>
      </div>
    </div>
  );
}
