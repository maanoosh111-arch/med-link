import { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  ListOrdered,
  LogOut,
  MessageSquare,
  SlidersHorizontal,
} from 'lucide-react';
import { api, getAuthToken, setAuthToken } from './api';
import { AuthGate } from './components/AuthGate';
import { ConfigView } from './components/ConfigView';
import { ConnectionView } from './components/ConnectionView';
import { IntegrationView } from './components/IntegrationView';
import { OrdersView } from './components/OrdersView';
import type {
  AuthStatusResponse,
  ConfigResponse,
  OrderRecord,
  OrderStats,
  WhatsAppStatusResponse,
} from './types';

type ActiveTab = 'connection' | 'orders' | 'config' | 'integration';

const EMPTY_STATS: OrderStats = { total: 0, sent: 0, pending: 0, failed: 0 };

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<ActiveTab>('connection');
  const [waStatus, setWaStatus] = useState<WhatsAppStatusResponse | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [stats, setStats] = useState<OrderStats>(EMPTY_STATS);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingOrders, setLoadingOrders] = useState(false);

  useEffect(() => {
    let mounted = true;
    api
      .getAuthStatus()
      .then((res) => {
        if (mounted) setAuthStatus(res);
      })
      .catch((err) => {
        if (mounted) setBootError(err instanceof Error ? err.message : 'Unable to reach server');
      });
    return () => {
      mounted = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      const wa = await api.getWhatsAppStatus();
      setWaStatus(wa);
    } catch {
      if (!getAuthToken()) {
        setAuthenticated(false);
      }
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    if (!getAuthToken()) return;
    try {
      const cfg = await api.getConfig();
      setConfig(cfg);
    } catch {
      if (!getAuthToken()) {
        setAuthenticated(false);
      }
    }
  }, []);

  const refreshOrders = useCallback(async () => {
    if (!getAuthToken()) return;
    setLoadingOrders(true);
    try {
      const res = await api.getOrdersHistory(statusFilter, searchQuery);
      setStats(res.stats);
      setOrders(res.orders);
    } catch {
      if (!getAuthToken()) {
        setAuthenticated(false);
      }
    } finally {
      setLoadingOrders(false);
    }
  }, [statusFilter, searchQuery]);

  useEffect(() => {
    if (!authenticated) return;
    void refreshConfig();
    void refreshStatus();
    void refreshOrders();

    const interval = setInterval(() => {
      void refreshStatus();
      void refreshOrders();
    }, 3500);

    return () => clearInterval(interval);
  }, [authenticated, refreshConfig, refreshStatus, refreshOrders]);

  function handleSignOut() {
    setAuthToken(null);
    setAuthenticated(false);
  }

  if (bootError) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-6 text-sm text-red-800">
          {bootError}
        </div>
      </div>
    );
  }

  if (!authStatus) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-sm text-slate-500">Loading console...</div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <AuthGate
        claimed={authStatus.claimed}
        envPasswordConfigured={authStatus.envPasswordConfigured}
        onAuthenticated={() => {
          setAuthenticated(true);
          setAuthStatus((prev) => (prev ? { ...prev, claimed: true } : prev));
        }}
      />
    );
  }

  const navItems: { id: ActiveTab; label: string; icon: typeof MessageSquare }[] = [
    { id: 'connection', label: 'Connection & QR', icon: MessageSquare },
    { id: 'orders', label: 'Order Queue', icon: ListOrdered },
    { id: 'config', label: 'Configuration', icon: SlidersHorizontal },
    { id: 'integration', label: 'Integration Guide', icon: BookOpen },
  ];

  const waState = waStatus?.status ?? 'disconnected';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* 3-Zone Top Bar Contract */}
      <header className="bg-white border-b border-slate-200 px-6 py-3.5 flex items-center justify-between gap-8">
        <a
          href="#connection"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('connection');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          OrderRelay
        </a>

        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer pb-0.5 ${
                activeTab === item.id
                  ? 'text-slate-900 border-b-2 border-emerald-700'
                  : 'hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </header>

      {/* Main Workspace with Desktop Sidebar */}
      <div className="flex-1 flex flex-col lg:flex-row max-w-[1440px] w-full mx-auto">
        <aside className="lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 bg-white lg:bg-transparent px-4 py-4 lg:py-6">
          <nav className="flex lg:flex-col gap-1 overflow-x-auto">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-700 hover:bg-slate-200/60 hover:text-slate-900'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Live Telemetry Summary in Sidebar */}
          <div className="hidden lg:block mt-8 pt-6 border-t border-slate-200 space-y-3 px-2 text-xs">
            <div>
              <div className="text-slate-500">WhatsApp Web</div>
              <div className="mt-1 font-medium flex items-center gap-2 text-slate-900">
                <span
                  className={`w-2 h-2 rounded-full ${
                    waState === 'connected'
                      ? 'bg-emerald-600'
                      : waState === 'connecting'
                        ? 'bg-amber-500'
                        : 'bg-red-600'
                  }`}
                  aria-hidden="true"
                />
                <span>
                  {waState === 'connected'
                    ? 'Connected'
                    : waState === 'connecting'
                      ? 'Connecting'
                      : 'Disconnected'}
                </span>
              </div>
            </div>

            <div>
              <div className="text-slate-500">Sender</div>
              <div className="font-mono text-slate-800 mt-0.5 tabular-nums">
                {config?.senderNumber || '01204457813'}
              </div>
            </div>

            <div>
              <div className="text-slate-500">Recipient</div>
              <div className="font-mono text-slate-800 mt-0.5 tabular-nums">
                {config?.recipientNumber || '010 15678913'}
              </div>
            </div>

            <div className="pt-2 border-t border-slate-200 flex items-center justify-between text-slate-600 tabular-nums font-mono">
              <span>Sent: {stats.sent}</span>
              <span>Pending: {stats.pending}</span>
              <span>Failed: {stats.failed}</span>
            </div>
          </div>
        </aside>

        <main className="flex-1 p-5 sm:p-8 min-w-0">
          {activeTab === 'connection' && (
            <ConnectionView
              waStatus={waStatus}
              config={config}
              onRefreshStatus={refreshStatus}
            />
          )}
          {activeTab === 'orders' && (
            <OrdersView
              stats={stats}
              orders={orders}
              statusFilter={statusFilter}
              searchQuery={searchQuery}
              loading={loadingOrders}
              onStatusFilterChange={setStatusFilter}
              onSearchChange={setSearchQuery}
              onRefresh={refreshOrders}
            />
          )}
          {activeTab === 'config' && (
            <ConfigView
              config={config}
              onConfigUpdated={(next) => setConfig(next)}
            />
          )}
          {activeTab === 'integration' && <IntegrationView />}
        </main>
      </div>
    </div>
  );
}
