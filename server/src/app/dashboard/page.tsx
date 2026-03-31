'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity,
  Copy,
  Trash2,
  RefreshCw,
  Key,
  Plus,
  CreditCard,
  CheckCircle2,
  AlertCircle,
  Download,
  X,
  ShieldCheck,
  Loader2,
  ToggleLeft,
  ToggleRight,
  Zap,
  Dna,
  Wrench,
  Sparkles,
  TrendingUp,
  Upload,
  Shield,
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Activity as ActivityType, ApiKeyData, ChartData, Invoice, PaymentMethod } from '@/types';
import { api } from '@/lib/api';
import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';
import { StripeCardModal } from '@/components/stripe-card-modal';
import { CreditPurchaseSlider } from '@/components/credit-purchase-slider';
import { TiltCard } from '@/components/evolution/tilt-card';
import { EvolutionGraph } from '@/components/evolution/evolution-graph';

type DashboardTab = 'overview' | 'api-keys' | 'billing' | 'evolution';

export default function DashboardPage() {
  const router = useRouter();
  const { isAuthenticated, isAuthLoading, activities, addToast, activeApiKey, setActiveApiKey } = useApp();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [loading, setLoading] = useState(true);

  // Data State
  const [chartData, setChartData] = useState<ChartData[]>([]);
  const [stats, setStats] = useState({ monthlyRequests: 0, cacheHitRate: 0, creditsRemaining: 0 });
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyData[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);

  // UI State for Forms
  const [showAddPayment, setShowAddPayment] = useState(false);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [showStripeCardModal, setShowStripeCardModal] = useState(false);

  // New API Key Modal State
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<ApiKeyData | null>(null);
  const [hasConfirmedCopy, setHasConfirmedCopy] = useState(false);

  // Redirect if not authenticated (wait for auth loading to complete)
  useEffect(() => {
    if (!isAuthLoading && !isAuthenticated) {
      router.push('/auth');
    }
  }, [isAuthenticated, isAuthLoading, router]);

  // Handle URL hash for tab navigation (e.g., /dashboard#api-keys)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.replace('#', '');
      if (hash === 'api-keys' || hash === 'billing' || hash === 'overview' || hash === 'evolution') {
        setActiveTab(hash as DashboardTab);
      }
    }
  }, []);

  // Initial Fetch
  useEffect(() => {
    if (!isAuthenticated) return;

    const fetchData = async () => {
      setLoading(true);
      try {
        const [statsData, keysData, invoiceData, pmData] = await Promise.all([
          api.getDashboardStats(),
          api.getApiKeys(),
          api.getInvoices(),
          api.getPaymentMethods(),
        ]);

        setChartData(statsData.chartData);
        setStats({
          monthlyRequests: statsData.monthlyRequests,
          cacheHitRate: statsData.cacheHitRate,
          creditsRemaining: statsData.creditsRemaining,
        });
        setApiKeys(keysData);
        setInvoices(invoiceData);
        setPaymentMethods(pmData);
      } catch (error) {
        console.error(error);
        addToast('Failed to load dashboard data', 'error');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [isAuthenticated, addToast]);

  // API Key Handlers
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    addToast('Copied to clipboard', 'success');
  };

  const createApiKey = async () => {
    try {
      const newKey = await api.createApiKey();
      setApiKeys((prev) => [newKey, ...prev]);
      // Show the new key modal instead of just a toast
      setNewlyCreatedKey(newKey);
      setHasConfirmedCopy(false);
    } catch (e) {
      addToast('Failed to create key', 'error');
    }
  };

  const closeNewKeyModal = () => {
    if (!hasConfirmedCopy) {
      // Warn user if they haven't confirmed copying
      if (!confirm("Are you sure? You won't be able to see this key again.")) {
        return;
      }
    }
    setNewlyCreatedKey(null);
    setHasConfirmedCopy(false);
    addToast('API Key created successfully', 'success');
  };

  const copyNewKey = () => {
    if (newlyCreatedKey) {
      navigator.clipboard.writeText(newlyCreatedKey.key);
      setHasConfirmedCopy(true);
      addToast('API Key copied to clipboard', 'success');
    }
  };

  const revokeKey = async (id: string) => {
    await api.revokeApiKey(id);
    setApiKeys((prev) => prev.map((k) => (k.id === id ? { ...k, status: 'REVOKED' } : k)));
    addToast('API Key revoked', 'info');
  };

  const deleteKey = async (id: string) => {
    if (confirm('Are you sure you want to delete this key?')) {
      await api.deleteApiKey(id);
      setApiKeys((prev) => prev.filter((k) => k.id !== id));
      addToast('API Key deleted', 'info');
    }
  };

  // Payment Handlers
  const handleAddStripe = () => {
    setShowAddPayment(false);
    setShowStripeCardModal(true);
  };

  const handleStripeCardSuccess = async (paymentMethodId: string) => {
    setShowStripeCardModal(false);
    setIsProcessingPayment(true);

    try {
      // Send the PaymentMethod ID to backend to attach to customer
      const newPm = await api.addCardPaymentMethod(paymentMethodId);

      // Refresh payment methods list
      const updatedPms = await api.getPaymentMethods();
      setPaymentMethods(updatedPms);

      addToast('Card added successfully!', 'success');
    } catch (e: any) {
      console.error('Failed to save card:', e);
      addToast(e.message || 'Failed to add card', 'error');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const removePaymentMethod = async (id: string) => {
    const pm = paymentMethods.find((p) => p.id === id);
    if (pm?.default) {
      addToast('Cannot remove default payment method', 'error');
      return;
    }
    await api.removePaymentMethod(id);
    setPaymentMethods((prev) => prev.filter((p) => p.id !== id));
    addToast('Payment method removed', 'info');
  };

  const setDefaultPaymentMethod = async (id: string) => {
    await api.setDefaultPaymentMethod(id);
    setPaymentMethods((prev) =>
      prev.map((p) => ({
        ...p,
        default: p.id === id,
      })),
    );
    addToast('Default payment method updated', 'success');
  };

  // Credit Purchase Handler
  const [isPurchasing, setIsPurchasing] = useState(false);

  const handleCreditPurchase = async (credits: number, priceCents: number) => {
    // Check if user has a payment method
    const defaultPm = paymentMethods.find((pm) => pm.default) || paymentMethods[0];
    if (!defaultPm) {
      addToast('Please add a payment method first', 'error');
      setShowStripeCardModal(true);
      return;
    }

    setIsPurchasing(true);
    try {
      const result = await api.purchaseCredits(credits, priceCents, defaultPm.id);

      if (result.requiresAction && result.clientSecret) {
        // Need 3D Secure verification - would need Stripe.js here
        addToast('Additional verification required. Please try again.', 'info');
        return;
      }

      if (result.status === 'succeeded') {
        addToast(`Successfully purchased ${credits.toLocaleString()} credits!`, 'success');
        // Refresh stats and invoices
        const [statsData, invoiceData] = await Promise.all([api.getDashboardStats(), api.getInvoices()]);
        setStats({
          monthlyRequests: statsData.monthlyRequests,
          cacheHitRate: statsData.cacheHitRate,
          creditsRemaining: statsData.creditsRemaining,
        });
        setInvoices(invoiceData);
      } else {
        addToast('Payment is processing. Credits will be added shortly.', 'info');
      }
    } catch (error: any) {
      console.error('Purchase failed:', error);
      addToast(error.message || 'Failed to purchase credits', 'error');
    } finally {
      setIsPurchasing(false);
    }
  };

  // Show loading while checking auth state
  if (isAuthLoading || !isAuthenticated) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-8 min-h-[calc(100vh-64px)] space-y-4 sm:space-y-6 lg:space-y-8">
      {/* Header & Tabs */}
      <div className="flex flex-col gap-4 sm:gap-6">
        <div className="flex items-start sm:items-center justify-between">
          <div>
            <h1
              className={`text-xl sm:text-2xl md:text-3xl font-bold mb-1 sm:mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}
            >
              Dashboard
            </h1>
            <div className={`flex items-center gap-2 text-xs sm:text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Systems Operational
            </div>
          </div>
        </div>

        <div
          className={`flex p-0.5 sm:p-1 rounded-lg overflow-x-auto scrollbar-none ${isDark ? 'bg-zinc-900 border border-white/5' : 'bg-zinc-100 border border-zinc-200'}`}
        >
          {(['overview', 'api-keys', 'billing', 'evolution'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium rounded-md transition-all capitalize whitespace-nowrap
                ${
                  activeTab === tab
                    ? isDark
                      ? 'bg-zinc-800 text-white shadow-sm'
                      : 'bg-white text-zinc-900 shadow-sm'
                    : isDark
                      ? 'text-zinc-500 hover:text-zinc-300'
                      : 'text-zinc-500 hover:text-zinc-900'
                }
              `}
            >
              {tab.replace('-', ' ')}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-4 sm:space-y-6 lg:space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {/* Stats Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 lg:gap-6">
            <div
              className={`p-4 sm:p-6 rounded-xl relative overflow-hidden group transition-colors ${isDark ? 'bg-zinc-900 border border-white/5 hover:border-violet-500/20' : 'bg-white border border-zinc-200 hover:border-violet-500/30 shadow-sm'}`}
            >
              <div className="absolute inset-0 bg-gradient-to-br from-violet-600/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
              <h3
                className={`text-xs sm:text-sm font-medium mb-1 flex items-center gap-2 ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}
              >
                API Requests{' '}
                <span
                  className={`text-[8px] sm:text-[10px] px-1 sm:px-1.5 py-0.5 rounded ${isDark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-500'}`}
                >
                  MONTHLY
                </span>
              </h3>
              <p className={`text-2xl sm:text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                {stats.monthlyRequests.toLocaleString()}
              </p>
              <div className="mt-1.5 sm:mt-2 text-[10px] sm:text-xs text-emerald-400 flex items-center gap-1 font-mono">
                <Activity className="w-2.5 h-2.5 sm:w-3 sm:h-3" /> +12.5% vs last month
              </div>
            </div>

            <div
              className={`p-4 sm:p-6 rounded-xl transition-colors ${isDark ? 'bg-zinc-900 border border-white/5 hover:border-cyan-500/20' : 'bg-white border border-zinc-200 hover:border-cyan-500/30 shadow-sm'}`}
            >
              <h3 className={`text-xs sm:text-sm font-medium mb-1 ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}>
                Global Cache Hit Rate
              </h3>
              <p className={`text-2xl sm:text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                {stats.cacheHitRate}%
              </p>
              <div
                className={`mt-1.5 sm:mt-2 w-full h-1 sm:h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}
              >
                <div
                  className="bg-gradient-to-r from-cyan-600 to-cyan-400 h-full shadow-[0_0_10px_rgba(6,182,212,0.5)]"
                  style={{ width: `${stats.cacheHitRate}%` }}
                ></div>
              </div>
            </div>

            <div
              className={`p-4 sm:p-6 rounded-xl transition-colors sm:col-span-2 lg:col-span-1 ${isDark ? 'bg-zinc-900 border border-white/5 hover:border-emerald-500/20' : 'bg-white border border-zinc-200 hover:border-emerald-500/30 shadow-sm'}`}
            >
              <h3 className={`text-xs sm:text-sm font-medium mb-1 ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}>
                Credits Remaining
              </h3>
              <p className={`text-2xl sm:text-3xl font-bold tracking-tight ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                {stats.creditsRemaining.toLocaleString()}
              </p>
              <button
                onClick={() => setActiveTab('billing')}
                className="mt-1.5 sm:mt-2 text-[10px] sm:text-xs text-violet-400 hover:text-violet-300 underline underline-offset-2"
              >
                Manage Subscription
              </button>
            </div>
          </div>

          {/* Chart Section */}
          <div
            className={`p-4 sm:p-6 rounded-xl shadow-xl ${isDark ? 'bg-zinc-900 border border-white/5' : 'bg-white border border-zinc-200'}`}
          >
            <div className="flex items-center justify-between mb-4 sm:mb-6 lg:mb-8">
              <h3 className={`text-base sm:text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                Request Volume
              </h3>
              <select
                className={`text-[10px] sm:text-xs rounded px-1.5 sm:px-2 py-1 ${isDark ? 'bg-zinc-950 border border-zinc-800 text-zinc-400' : 'bg-zinc-100 border border-zinc-300 text-zinc-600'}`}
              >
                <option>Last 7 Days</option>
                <option>Last 30 Days</option>
              </select>
            </div>
            <div className="h-[200px] sm:h-[250px] lg:h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <defs>
                    <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis
                    dataKey="name"
                    stroke="#52525b"
                    tick={{ fontSize: 12 }}
                    axisLine={false}
                    tickLine={false}
                    dy={10}
                  />
                  <YAxis stroke="#52525b" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} dx={-10} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#18181b',
                      borderColor: '#27272a',
                      borderRadius: '8px',
                      boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.5)',
                    }}
                    itemStyle={{ color: '#fff', fontSize: '12px', fontFamily: 'monospace' }}
                    cursor={{ stroke: '#52525b', strokeWidth: 1 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="requests"
                    stroke="#8b5cf6"
                    strokeWidth={2}
                    dot={{ r: 4, fill: '#18181b', strokeWidth: 2, stroke: '#8b5cf6' }}
                    activeDot={{ r: 6, fill: '#8b5cf6', stroke: '#fff' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Recent Activity Table */}
          <div
            className={`rounded-xl overflow-hidden shadow-xl ${isDark ? 'bg-zinc-900 border border-white/5' : 'bg-white border border-zinc-200'}`}
          >
            <div
              className={`px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between ${isDark ? 'border-b border-white/5' : 'border-b border-zinc-200'}`}
            >
              <h3 className={`text-base sm:text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                Recent Tasks
              </h3>
              <div className="flex gap-2">
                <span className={`text-[10px] sm:text-xs py-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  {activities.length} total
                </span>
                <button className="text-[10px] sm:text-xs text-violet-400 hover:text-violet-300 transition-colors">
                  View All
                </button>
              </div>
            </div>

            {/* Mobile Card View */}
            <div className={`sm:hidden ${isDark ? 'divide-y divide-white/5' : 'divide-y divide-zinc-200'}`}>
              {activities.map((item) => (
                <div key={item.id} className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <p
                      className={`font-mono text-xs truncate flex-1 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
                      title={item.url}
                    >
                      {item.url}
                    </p>
                    {item.status === 'Completed' ? (
                      <span className="text-emerald-400 text-[10px] flex items-center gap-1 font-medium shrink-0">
                        <CheckCircle2 className="w-3 h-3" /> Done
                      </span>
                    ) : (
                      <span className="text-red-400 text-[10px] flex items-center gap-1 font-medium shrink-0">
                        <AlertCircle className="w-3 h-3" /> Fail
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-zinc-500">
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-400">
                      {item.strategy}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono">${item.cost}</span>
                      <span>{item.time}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop Table View */}
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className={isDark ? 'bg-zinc-950/50 text-zinc-500' : 'bg-zinc-50 text-zinc-600'}>
                  <tr>
                    <th className="px-4 lg:px-6 py-3 font-medium text-[10px] lg:text-xs uppercase tracking-wider">
                      URL Source
                    </th>
                    <th className="px-4 lg:px-6 py-3 font-medium text-[10px] lg:text-xs uppercase tracking-wider">
                      Strategy
                    </th>
                    <th className="px-4 lg:px-6 py-3 font-medium text-[10px] lg:text-xs uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-4 lg:px-6 py-3 font-medium text-[10px] lg:text-xs uppercase tracking-wider">
                      Cost
                    </th>
                    <th className="px-4 lg:px-6 py-3 font-medium text-[10px] lg:text-xs uppercase tracking-wider text-right">
                      Time
                    </th>
                  </tr>
                </thead>
                <tbody className={isDark ? 'divide-y divide-white/5' : 'divide-y divide-zinc-200'}>
                  {activities.map((item) => (
                    <tr
                      key={item.id}
                      className={`transition-colors group ${isDark ? 'hover:bg-white/5' : 'hover:bg-zinc-50'}`}
                    >
                      <td
                        className={`px-4 lg:px-6 py-3 lg:py-4 font-mono text-xs lg:text-sm truncate max-w-[120px] lg:max-w-[200px] group-hover:text-violet-500 transition-colors ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
                        title={item.url}
                      >
                        {item.url}
                      </td>
                      <td className={`px-4 lg:px-6 py-3 lg:py-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                        <span
                          className={`inline-block px-1.5 lg:px-2 py-0.5 lg:py-1 rounded text-[10px] lg:text-xs ${isDark ? 'bg-zinc-800 border border-zinc-700 text-zinc-300' : 'bg-zinc-100 border border-zinc-300 text-zinc-700'}`}
                        >
                          {item.strategy}
                        </span>
                      </td>
                      <td className="px-4 lg:px-6 py-3 lg:py-4">
                        {item.status === 'Completed' ? (
                          <span className="text-emerald-400 text-[10px] lg:text-xs flex items-center gap-1 lg:gap-1.5 font-medium">
                            <CheckCircle2 className="w-3 h-3 lg:w-3.5 lg:h-3.5" />{' '}
                            <span className="hidden lg:inline">Completed</span>
                            <span className="lg:hidden">Done</span>
                          </span>
                        ) : (
                          <span className="text-red-400 text-[10px] lg:text-xs flex items-center gap-1 lg:gap-1.5 font-medium">
                            <AlertCircle className="w-3 h-3 lg:w-3.5 lg:h-3.5" /> Failed
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-4 lg:px-6 py-3 lg:py-4 font-mono text-[10px] lg:text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
                      >
                        ${item.cost}
                      </td>
                      <td
                        className={`px-4 lg:px-6 py-3 lg:py-4 text-right text-[10px] lg:text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                      >
                        {item.time}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'api-keys' && (
        <div id="api-keys" className="max-w-4xl mx-auto animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div
            className={`p-4 sm:p-6 lg:p-8 rounded-xl flex flex-col shadow-xl ${isDark ? 'bg-zinc-900 border border-white/5' : 'bg-white border border-zinc-200'}`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 sm:mb-8">
              <div>
                <h3
                  className={`text-lg sm:text-xl font-bold flex items-center gap-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}
                >
                  <Key className="w-4 h-4 sm:w-5 sm:h-5 text-violet-500" /> API Keys
                </h3>
                <p className={`text-xs sm:text-sm mt-1 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Manage your secret keys to access the Prismer API.
                </p>
              </div>
              <button
                onClick={createApiKey}
                className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition-all flex items-center gap-2 self-start sm:self-auto ${isDark ? 'bg-white text-zinc-950 hover:bg-zinc-200' : 'bg-violet-600 text-white hover:bg-violet-700'}`}
              >
                <Plus className="w-3 h-3 sm:w-4 sm:h-4" /> <span className="hidden sm:inline">Create New Key</span>
                <span className="sm:hidden">New Key</span>
              </button>
            </div>

            <div className="space-y-3 sm:space-y-4">
              {apiKeys.map((keyData) => {
                const isCurrentActive = activeApiKey?.id === keyData.id;
                return (
                  <div
                    key={keyData.id}
                    className={`p-4 sm:p-6 border rounded-xl transition-all ${
                      keyData.status === 'REVOKED'
                        ? `opacity-60 ${isDark ? 'bg-black/40 border-zinc-800' : 'bg-zinc-100 border-zinc-300'}`
                        : isCurrentActive
                          ? `border-violet-500/50 ring-1 ring-violet-500/20 shadow-[0_0_20px_rgba(124,58,237,0.1)] ${isDark ? 'bg-black/40' : 'bg-violet-50'}`
                          : `group ${isDark ? 'bg-black/40 border-zinc-800 hover:border-zinc-700' : 'bg-white border-zinc-200 hover:border-zinc-300'}`
                    }`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-0 mb-3 sm:mb-4">
                      <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                        <span
                          className={`text-xs sm:text-sm font-medium ${
                            keyData.status === 'REVOKED' ? 'text-zinc-500' : isDark ? 'text-white' : 'text-zinc-900'
                          }`}
                        >
                          {keyData.label}
                        </span>
                        {keyData.status === 'ACTIVE' ? (
                          <span className="text-[8px] sm:text-[10px] bg-emerald-500/10 text-emerald-500 px-1.5 sm:px-2 py-0.5 rounded border border-emerald-500/20 font-bold tracking-wide">
                            ACTIVE
                          </span>
                        ) : (
                          <span className="text-[8px] sm:text-[10px] bg-zinc-800 text-zinc-500 px-1.5 sm:px-2 py-0.5 rounded border border-zinc-700 font-bold tracking-wide">
                            REVOKED
                          </span>
                        )}
                        {isCurrentActive && (
                          <span className="text-[8px] sm:text-[10px] bg-violet-500/10 text-violet-400 px-1.5 sm:px-2 py-0.5 rounded border border-violet-500/20 font-bold tracking-wide flex items-center gap-1">
                            <Zap className="w-2 h-2 sm:w-2.5 sm:h-2.5" /> IN USE
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] sm:text-xs text-zinc-500">Created {keyData.created}</span>
                    </div>

                    {keyData.status === 'ACTIVE' ? (
                      <div className="flex items-center gap-2 sm:gap-3 mb-4 sm:mb-6">
                        <div
                          className={`flex-1 rounded-lg px-3 sm:px-4 py-2 sm:py-3 flex items-center justify-between group-hover:border-zinc-700 transition-colors overflow-hidden ${
                            isDark ? 'bg-zinc-950 border border-zinc-800' : 'bg-zinc-900 border border-zinc-700'
                          }`}
                        >
                          <code
                            className={`font-mono text-[10px] sm:text-sm truncate ${isDark ? 'text-zinc-300' : 'text-zinc-200'}`}
                          >
                            {keyData.key}
                          </code>
                          <Copy
                            onClick={() => copyToClipboard(keyData.key)}
                            className={`w-3 h-3 sm:w-4 sm:h-4 cursor-pointer transition-colors flex-shrink-0 ml-2 ${isDark ? 'text-zinc-500 hover:text-white' : 'text-zinc-400 hover:text-white'}`}
                          />
                        </div>
                      </div>
                    ) : (
                      <div
                        className={`h-8 sm:h-10 rounded-lg w-full mb-2 flex items-center px-3 sm:px-4 ${isDark ? 'bg-zinc-950/50 border border-zinc-800/50' : 'bg-zinc-200 border border-zinc-300'}`}
                      >
                        <span
                          className={`font-mono text-[10px] sm:text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-500'}`}
                        >
                          Key hidden
                        </span>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 sm:gap-3 justify-between">
                      {/* Use for Playground Toggle */}
                      {keyData.status === 'ACTIVE' && (
                        <button
                          onClick={() => {
                            if (isCurrentActive) {
                              setActiveApiKey(null);
                              addToast('API key deactivated from Playground', 'info');
                            } else {
                              setActiveApiKey(keyData);
                              addToast('API key activated for Playground', 'success');
                            }
                          }}
                          className={`flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[10px] sm:text-xs font-medium transition-all ${
                            isCurrentActive
                              ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30'
                              : isDark
                                ? 'bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600 hover:text-white'
                                : 'bg-zinc-100 text-zinc-600 border border-zinc-300 hover:border-zinc-400 hover:text-zinc-900'
                          }`}
                        >
                          {isCurrentActive ? (
                            <ToggleRight className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-violet-400" />
                          ) : (
                            <ToggleLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                          )}
                          <span className="hidden sm:inline">
                            {isCurrentActive ? 'Using in Playground' : 'Use in Playground'}
                          </span>
                          <span className="sm:hidden">{isCurrentActive ? 'Active' : 'Use'}</span>
                        </button>
                      )}

                      <div className="flex flex-wrap gap-2 sm:gap-3 ml-auto">
                        {keyData.status === 'ACTIVE' && (
                          <>
                            <button
                              className={`px-2 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-xs font-medium rounded transition-colors flex items-center gap-1 sm:gap-1.5 ${
                                isDark
                                  ? 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200'
                              }`}
                            >
                              <RefreshCw className="w-2.5 h-2.5 sm:w-3 sm:h-3" />{' '}
                              <span className="hidden sm:inline">Regenerate</span>
                              <span className="sm:hidden">Regen</span>
                            </button>
                            <button
                              onClick={() => {
                                if (isCurrentActive) {
                                  setActiveApiKey(null);
                                }
                                revokeKey(keyData.id);
                              }}
                              className="px-2 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors flex items-center gap-1 sm:gap-1.5"
                            >
                              <Trash2 className="w-2.5 h-2.5 sm:w-3 sm:h-3" /> Revoke
                            </button>
                          </>
                        )}
                        {keyData.status === 'REVOKED' && (
                          <button
                            onClick={() => deleteKey(keyData.id)}
                            className="px-2 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-xs font-medium text-zinc-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors flex items-center gap-1 sm:gap-1.5"
                          >
                            <Trash2 className="w-2.5 h-2.5 sm:w-3 sm:h-3" /> Delete
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'billing' && (
        <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
          {/* Credit Purchase Slider */}
          <CreditPurchaseSlider
            onPurchase={handleCreditPurchase}
            disabled={paymentMethods.length === 0}
            loading={isPurchasing}
          />

          {/* Current Balance */}
          <div
            className={`p-5 sm:p-6 rounded-2xl ${isDark ? 'bg-zinc-900/50 border border-zinc-800' : 'bg-white border border-zinc-200 shadow-sm'}`}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className={`text-base sm:text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                Your Balance
              </h3>
              <span
                className={`text-xs px-2 py-1 rounded-full ${isDark ? 'bg-violet-500/10 text-violet-400' : 'bg-violet-100 text-violet-700'}`}
              >
                Pay as you go
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className={`p-4 rounded-xl ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}`}>
                <p className={`text-xs mb-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>Credits Balance</p>
                <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                  {stats.creditsRemaining.toLocaleString()}
                </p>
                <p className={`text-xs mt-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>Never expires</p>
              </div>
              <div className={`p-4 rounded-xl ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}`}>
                <p className={`text-xs mb-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>This Month Used</p>
                <p className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                  {stats.monthlyRequests}
                </p>
                <p className={`text-xs mt-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>API requests</p>
              </div>
              <div className={`p-4 rounded-xl ${isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}`}>
                <p className={`text-xs mb-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>Cache Hit Rate</p>
                <p className={`text-2xl font-bold text-emerald-500`}>{stats.cacheHitRate}%</p>
                <p className={`text-xs mt-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>Saving you credits</p>
              </div>
            </div>
          </div>

          {/* Payment Methods - Redesigned */}
          <div
            className={`p-5 sm:p-6 rounded-2xl ${isDark ? 'bg-zinc-900/50 border border-zinc-800' : 'bg-white border border-zinc-200 shadow-sm'}`}
          >
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className={`text-base sm:text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                  Payment Methods
                </h3>
                <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  Manage your billing information
                </p>
              </div>
              {!showAddPayment && paymentMethods.length > 0 && (
                <button
                  onClick={handleAddStripe}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 rounded-lg transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Card
                </button>
              )}
            </div>

            {paymentMethods.length === 0 && !showAddPayment ? (
              /* Empty State */
              <div
                className={`text-center py-10 px-4 rounded-xl border-2 border-dashed ${isDark ? 'border-zinc-800' : 'border-zinc-200'}`}
              >
                <div
                  className={`w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center ${isDark ? 'bg-zinc-800' : 'bg-zinc-100'}`}
                >
                  <CreditCard className={`w-8 h-8 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
                </div>
                <h4 className={`text-sm font-medium mb-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                  No payment method
                </h4>
                <p className={`text-xs mb-4 max-w-xs mx-auto ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                  Add a payment method to upgrade your plan or enable auto-billing
                </p>
                <button
                  onClick={handleAddStripe}
                  disabled={isProcessingPayment}
                  className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white rounded-lg text-sm font-medium transition-all shadow-lg shadow-violet-500/20 disabled:opacity-50"
                >
                  {isProcessingPayment ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CreditCard className="w-4 h-4" />
                  )}
                  Add Credit Card
                </button>
                <div className="flex items-center justify-center gap-2 mt-4 text-xs text-zinc-500">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                  Secured by Stripe
                </div>
              </div>
            ) : (
              /* Payment Methods List */
              <div className="space-y-3">
                {paymentMethods
                  .filter((pm) => pm.type === 'card')
                  .map((pm) => (
                    <div
                      key={pm.id}
                      className={`flex items-center justify-between p-4 rounded-xl transition-all group ${
                        isDark
                          ? 'bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-700/50'
                          : 'bg-zinc-50 hover:bg-zinc-100 border border-zinc-200'
                      }`}
                    >
                      <div className="flex items-center gap-4">
                        <div
                          className={`w-12 h-8 rounded-lg flex items-center justify-center ${
                            pm.brand?.toLowerCase() === 'visa'
                              ? 'bg-[#1A1F71]'
                              : pm.brand?.toLowerCase() === 'mastercard'
                                ? 'bg-gradient-to-r from-[#EB001B] to-[#F79E1B]'
                                : pm.brand?.toLowerCase() === 'amex'
                                  ? 'bg-[#006FCF]'
                                  : isDark
                                    ? 'bg-zinc-700'
                                    : 'bg-zinc-600'
                          }`}
                        >
                          <CreditCard className="w-5 h-5 text-white" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className={`text-sm font-medium ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                              {pm.brand || 'Card'} •••• {pm.last4}
                            </p>
                            {pm.default && (
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                  isDark ? 'bg-violet-500/20 text-violet-400' : 'bg-violet-100 text-violet-700'
                                }`}
                              >
                                Default
                              </span>
                            )}
                          </div>
                          <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>Expires {pm.exp}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {!pm.default && (
                          <button
                            onClick={() => setDefaultPaymentMethod(pm.id)}
                            className={`text-xs px-2 py-1 rounded transition-colors ${
                              isDark
                                ? 'text-zinc-400 hover:text-white hover:bg-zinc-700'
                                : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200'
                            }`}
                          >
                            Set Default
                          </button>
                        )}
                        <button
                          onClick={() => removePaymentMethod(pm.id)}
                          className="p-1.5 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}

                {/* Add Card Button */}
                {paymentMethods.length > 0 && (
                  <button
                    onClick={handleAddStripe}
                    disabled={isProcessingPayment}
                    className={`w-full p-4 rounded-xl border-2 border-dashed flex items-center justify-center gap-2 text-sm font-medium transition-all ${
                      isDark
                        ? 'border-zinc-700 text-zinc-400 hover:border-violet-500/50 hover:text-violet-400 hover:bg-violet-500/5'
                        : 'border-zinc-200 text-zinc-500 hover:border-violet-400 hover:text-violet-600 hover:bg-violet-50'
                    } disabled:opacity-50`}
                  >
                    {isProcessingPayment ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                    Add Another Card
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Invoices */}
          <div
            className={`rounded-xl overflow-hidden ${isDark ? 'bg-zinc-900 border border-white/5' : 'bg-white border border-zinc-200'}`}
          >
            <div
              className={`px-4 sm:px-6 py-3 sm:py-4 ${isDark ? 'border-b border-white/5' : 'border-b border-zinc-200'}`}
            >
              <h3 className={`text-base sm:text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Invoices</h3>
            </div>

            {invoices.length === 0 ? (
              <div className={`p-8 text-center ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                <p className="text-sm">No invoices yet</p>
              </div>
            ) : (
              <>
                {/* Mobile Card View */}
                <div className={`sm:hidden ${isDark ? 'divide-y divide-white/5' : 'divide-y divide-zinc-200'}`}>
                  {invoices.map((inv) => (
                    <div key={inv.id} className="p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{inv.date}</span>
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] border ${
                              inv.status === 'Paid'
                                ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                                : isDark
                                  ? 'bg-zinc-800 text-zinc-400 border-zinc-700'
                                  : 'bg-zinc-100 text-zinc-600 border-zinc-300'
                            }`}
                          >
                            {inv.status}
                          </span>
                        </div>
                        <p className={`text-sm font-mono ${isDark ? 'text-white' : 'text-zinc-900'}`}>{inv.amount}</p>
                        {inv.credits && (
                          <p className={`text-xs mt-0.5 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                            {inv.credits.toLocaleString()} credits
                          </p>
                        )}
                      </div>
                      {inv.pdfUrl ? (
                        <a
                          href={inv.pdfUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`p-2 transition-colors ${isDark ? 'text-zinc-500 hover:text-white' : 'text-zinc-400 hover:text-zinc-900'}`}
                        >
                          <Download className="w-4 h-4" />
                        </a>
                      ) : (
                        <span className={`p-2 ${isDark ? 'text-zinc-700' : 'text-zinc-300'}`}>
                          <Download className="w-4 h-4" />
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {/* Desktop Table View */}
                <table className="hidden sm:table w-full text-left text-sm">
                  <thead className={isDark ? 'bg-zinc-950/50 text-zinc-500' : 'bg-zinc-50 text-zinc-600'}>
                    <tr>
                      <th className="px-4 lg:px-6 py-3 font-medium text-xs">Date</th>
                      <th className="px-4 lg:px-6 py-3 font-medium text-xs">Amount</th>
                      <th className="px-4 lg:px-6 py-3 font-medium text-xs">Credits</th>
                      <th className="px-4 lg:px-6 py-3 font-medium text-xs">Status</th>
                      <th className="px-4 lg:px-6 py-3 font-medium text-xs text-right">Invoice</th>
                    </tr>
                  </thead>
                  <tbody className={isDark ? 'divide-y divide-white/5' : 'divide-y divide-zinc-200'}>
                    {invoices.map((inv) => (
                      <tr key={inv.id} className={isDark ? 'hover:bg-white/5' : 'hover:bg-zinc-50'}>
                        <td
                          className={`px-4 lg:px-6 py-3 lg:py-4 text-xs lg:text-sm ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}
                        >
                          {inv.date}
                        </td>
                        <td
                          className={`px-4 lg:px-6 py-3 lg:py-4 text-xs lg:text-sm font-mono ${isDark ? 'text-white' : 'text-zinc-900'}`}
                        >
                          {inv.amount}
                        </td>
                        <td
                          className={`px-4 lg:px-6 py-3 lg:py-4 text-xs lg:text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
                        >
                          {inv.credits ? inv.credits.toLocaleString() : '-'}
                        </td>
                        <td className="px-4 lg:px-6 py-3 lg:py-4">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 lg:px-2 py-0.5 rounded-full text-[10px] lg:text-xs border ${
                              inv.status === 'Paid'
                                ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                                : isDark
                                  ? 'bg-zinc-800 text-zinc-400 border-zinc-700'
                                  : 'bg-zinc-100 text-zinc-600 border-zinc-300'
                            }`}
                          >
                            {inv.status}
                          </span>
                        </td>
                        <td className="px-4 lg:px-6 py-3 lg:py-4 text-right">
                          {inv.pdfUrl ? (
                            <a
                              href={inv.pdfUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`inline-flex transition-colors ${isDark ? 'text-violet-400 hover:text-violet-300' : 'text-violet-600 hover:text-violet-500'}`}
                            >
                              <Download className="w-3 h-3 lg:w-4 lg:h-4" />
                            </a>
                          ) : (
                            <span className={isDark ? 'text-zinc-700' : 'text-zinc-300'}>
                              <Download className="w-3 h-3 lg:w-4 lg:h-4 ml-auto" />
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}

      {activeTab === 'evolution' && <DashboardEvolutionTab isDark={isDark} />}

      {/* New API Key Modal */}
      {newlyCreatedKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            onClick={() => {
              if (hasConfirmedCopy) closeNewKeyModal();
            }}
          />

          {/* Modal */}
          <div className="relative w-full max-w-lg bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 fade-in duration-200">
            {/* Header */}
            <div className="p-6 border-b border-white/5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                  <Key className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">API Key Created</h3>
                  <p className="text-sm text-zinc-400">{newlyCreatedKey.label}</p>
                </div>
              </div>
            </div>

            {/* Warning Banner */}
            <div className="px-6 py-3 bg-amber-500/10 border-b border-amber-500/20">
              <div className="flex items-center gap-2 text-amber-400">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <p className="text-sm font-medium">This key will only be displayed once. Copy it now!</p>
              </div>
            </div>

            {/* Key Display */}
            <div className="p-6">
              <label className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Your API Key</label>
              <div className="mt-2 flex items-center gap-2">
                <div className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg px-4 py-3 overflow-hidden">
                  <code className="font-mono text-sm text-emerald-400 break-all select-all">{newlyCreatedKey.key}</code>
                </div>
                <button
                  onClick={copyNewKey}
                  className={`p-3 rounded-lg transition-all flex-shrink-0 ${
                    hasConfirmedCopy
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-violet-600 hover:bg-violet-500 text-white'
                  }`}
                >
                  {hasConfirmedCopy ? <CheckCircle2 className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
                </button>
              </div>

              {hasConfirmedCopy && (
                <p className="mt-2 text-sm text-emerald-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />
                  Copied to clipboard
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-zinc-950/50 border-t border-white/5 flex items-center justify-between">
              <p className="text-xs text-zinc-500">Store this key securely. You won&apos;t be able to see it again.</p>
              <button
                onClick={closeNewKeyModal}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  hasConfirmedCopy
                    ? 'bg-white text-zinc-900 hover:bg-zinc-200'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white'
                }`}
              >
                {hasConfirmedCopy ? 'Done' : 'Close Anyway'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stripe Card Modal */}
      <StripeCardModal
        isOpen={showStripeCardModal}
        onClose={() => setShowStripeCardModal(false)}
        onSuccess={handleStripeCardSuccess}
      />
    </div>
  );
}

// ============================================================================
// Dashboard Evolution Tab
// ============================================================================

interface EvolutionGene {
  id: string;
  category: string;
  title?: string;
  description?: string;
  visibility?: string;
  signals_match: string[];
  strategy: string[];
  success_count: number;
  failure_count: number;
  created_by: string;
}

function DashboardEvolutionTab({ isDark }: { isDark: boolean }) {
  const { addToast } = useApp();
  const [genes, setGenes] = useState<EvolutionGene[]>([]);
  const [capsuleCount, setCapsuleCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [distillStatus, setDistillStatus] = useState<{
    ready: boolean;
    success_capsules: number;
    min_required: number;
  } | null>(null);
  const [capsules, setCapsules] = useState<
    Array<{
      id: string;
      gene_id: string;
      gene_title?: string;
      outcome: string;
      score?: number;
      summary?: string;
      created_at: string;
    }>
  >([]);
  const [showGraph, setShowGraph] = useState(false);

  const getAuthHeaders = (): Record<string, string> => {
    try {
      const auth = JSON.parse(localStorage.getItem('prismer_auth') || '{}');
      if (auth.token) return { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
      const apiKey = JSON.parse(localStorage.getItem('prismer_active_api_key') || '{}');
      if (apiKey.key) return { Authorization: `Bearer ${apiKey.key}`, 'Content-Type': 'application/json' };
    } catch {}
    return { 'Content-Type': 'application/json' };
  };

  useEffect(() => {
    const headers = getAuthHeaders();
    Promise.all([
      fetch('/api/im/evolution/genes', { headers }).then((r) => r.json()),
      fetch('/api/im/evolution/distill?dry_run=true', { method: 'POST', headers }).then((r) => r.json()),
      fetch('/api/im/evolution/capsules?limit=10', { headers }).then((r) => r.json()),
    ])
      .then(([genesRes, distillRes, capsulesRes]) => {
        if (genesRes.ok) setGenes(genesRes.data || []);
        if (distillRes.ok) setDistillStatus(distillRes.data);
        if (capsulesRes.ok) {
          setCapsuleCount(capsulesRes.meta?.total || 0);
          setCapsules(capsulesRes.data || []);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handlePublish = async (geneId: string) => {
    const headers = getAuthHeaders();
    const res = await fetch(`/api/im/evolution/genes/${geneId}/publish`, { method: 'POST', headers });
    const data = await res.json();
    if (data.ok) {
      addToast('Gene published to market!', 'success');
      setGenes((prev) => prev.map((g) => (g.id === geneId ? { ...g, visibility: 'published' } : g)));
    } else {
      addToast(data.error || 'Failed to publish', 'error');
    }
  };

  const handleDelete = async (geneId: string) => {
    const headers = getAuthHeaders();
    const res = await fetch(`/api/im/evolution/genes/${geneId}`, { method: 'DELETE', headers });
    const data = await res.json();
    if (data.ok) {
      addToast('Gene deleted', 'info');
      setGenes((prev) => prev.filter((g) => g.id !== geneId));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
      </div>
    );
  }

  const totalUses = genes.reduce((sum, g) => sum + g.success_count + g.failure_count, 0);
  const totalSuccess = genes.reduce((sum, g) => sum + g.success_count, 0);
  const avgSuccessRate = totalUses > 0 ? Math.round((totalSuccess / totalUses) * 100) : 0;

  const catColors: Record<string, string> = {
    repair: 'text-orange-400',
    optimize: 'text-cyan-400',
    innovate: 'text-violet-400',
  };
  const catGlows: Record<string, string> = {
    repair: 'rgba(251,146,60,0.15)',
    optimize: 'rgba(34,211,238,0.15)',
    innovate: 'rgba(139,92,246,0.15)',
  };
  const catIcons: Record<string, typeof Wrench> = {
    repair: Wrench,
    optimize: Zap,
    innovate: Sparkles,
  };

  return (
    <div className="space-y-6 animate-spring-in">
      {/* KPIs - Glassmorphism */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 stagger-children">
        {[
          { label: 'My Genes', value: genes.length, icon: Dna },
          { label: 'Success Rate', value: `${avgSuccessRate}%`, icon: TrendingUp },
          { label: 'Total Capsules', value: capsuleCount, icon: Zap },
          { label: 'Published', value: genes.filter((g) => g.visibility === 'published').length, icon: Upload },
        ].map(({ label, value, icon: Icon }) => (
          <div
            key={label}
            className={`p-4 rounded-xl spring-hover ${
              isDark
                ? 'backdrop-blur-xl bg-white/[0.03] border border-white/10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]'
                : 'backdrop-blur-xl bg-white/70 border border-white/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.5)]'
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <Icon className={`w-4 h-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`} />
              <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</span>
            </div>
            <div className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
              {typeof value === 'number' ? value.toLocaleString() : value}
            </div>
          </div>
        ))}
      </div>

      {/* Distillation Card - Glassmorphism */}
      {distillStatus && (
        <div
          className={`p-4 rounded-xl flex items-center justify-between ${
            isDark
              ? 'backdrop-blur-xl bg-white/[0.03] border border-white/10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]'
              : 'backdrop-blur-xl bg-white/70 border border-white/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.5)]'
          }`}
        >
          <div>
            <h3 className={`font-bold mb-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Gene Distillation</h3>
            <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              {distillStatus.ready
                ? 'Your agent is ready to distill a new Gene from successful capsules.'
                : `Need ${distillStatus.min_required} successful capsules. Have ${distillStatus.success_capsules}.`}
            </p>
          </div>
          <div className={`flex items-center gap-3`}>
            {!distillStatus.ready && (
              <div className={`w-24 h-2 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
                <div
                  className="h-full rounded-full bg-gradient-to-r from-violet-500 to-violet-400 transition-all"
                  style={{
                    width: `${Math.min((distillStatus.success_capsules / distillStatus.min_required) * 100, 100)}%`,
                  }}
                />
              </div>
            )}
            <button
              disabled={!distillStatus.ready}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${
                distillStatus.ready
                  ? 'bg-violet-600 text-white hover:bg-violet-500'
                  : isDark
                    ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                    : 'bg-zinc-100 text-zinc-400 cursor-not-allowed'
              }`}
            >
              {distillStatus.ready ? 'Trigger Distillation' : 'Not Ready'}
            </button>
          </div>
        </div>
      )}

      {/* Gene List */}
      <div>
        <h3 className={`font-bold mb-3 ${isDark ? 'text-white' : 'text-zinc-900'}`}>My Genes ({genes.length})</h3>
        {genes.length === 0 ? (
          <div
            className={`text-center py-12 rounded-xl ${
              isDark
                ? 'backdrop-blur-xl bg-white/[0.02] border border-white/5'
                : 'backdrop-blur-xl bg-white/50 border border-white/20'
            }`}
          >
            <Dna className={`w-8 h-8 mx-auto mb-3 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`} />
            <p className={`text-sm mb-2 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>No genes yet</p>
            <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              Import genes from the{' '}
              <a href="/evolution" className="text-violet-400 hover:underline">
                Gene Market
              </a>{' '}
              or create them via the API.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 stagger-children">
            {genes.map((gene) => {
              const CatIcon = catIcons[gene.category] || Wrench;
              const totalG = gene.success_count + gene.failure_count;
              const successRate = totalG > 0 ? Math.round((gene.success_count / totalG) * 100) : 0;
              const isPublished = gene.visibility === 'published';
              const isSeed = gene.visibility === 'seed';

              return (
                <TiltCard
                  key={gene.id}
                  glowColor={catGlows[gene.category] || catGlows.repair}
                  maxTilt={4}
                  scale={1.01}
                  className="rounded-xl"
                >
                  <div
                    className={`rounded-xl p-4 h-full ${
                      isDark
                        ? 'backdrop-blur-xl bg-white/[0.03] border border-white/10 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]'
                        : 'backdrop-blur-xl bg-white/70 border border-white/30 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.5)]'
                    }`}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-1.5">
                        <CatIcon className={`w-4 h-4 ${catColors[gene.category] || 'text-zinc-400'}`} />
                        <span className={`text-xs font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          {gene.category}
                        </span>
                      </div>
                      {isPublished && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400">
                          Published
                        </span>
                      )}
                      {isSeed && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300">Seed</span>
                      )}
                    </div>
                    <h4 className={`font-bold text-sm mb-1 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                      {gene.title ||
                        (typeof gene.signals_match[0] === 'string'
                          ? gene.signals_match[0]
                          : ((gene.signals_match[0] as Record<string, unknown>)?.type as string)) ||
                        'Untitled'}
                    </h4>
                    <p className={`text-xs mb-2 line-clamp-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                      {gene.description || gene.strategy[0] || ''}
                    </p>
                    <div className="flex items-center gap-2 mb-3">
                      {totalG > 0 ? (
                        <>
                          <span className={`text-xs ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                            {successRate}%
                          </span>
                          <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>{totalG} uses</span>
                        </>
                      ) : (
                        <span className={`text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>No uses yet</span>
                      )}
                    </div>
                    <div
                      className={`flex items-center gap-2 pt-2 border-t ${isDark ? 'border-white/5' : 'border-zinc-100'}`}
                    >
                      {!isPublished && !isSeed && (
                        <div>
                          <button
                            onClick={() => handlePublish(gene.id)}
                            className="text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors"
                          >
                            Publish
                          </button>
                          <p className={`text-[9px] mt-0.5 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                            Earn up to 5,000 credits when others use your gene
                          </p>
                        </div>
                      )}
                      {!isSeed && (
                        <button
                          onClick={() => handleDelete(gene.id)}
                          className="text-xs text-red-400 hover:text-red-300 transition-colors ml-auto"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                </TiltCard>
              );
            })}
          </div>
        )}
      </div>

      {/* Capsule History */}
      {capsules.length > 0 && (
        <div>
          <h3 className={`font-bold mb-3 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Capsule History</h3>
          <div
            className={`rounded-xl p-4 ${
              isDark
                ? 'backdrop-blur-xl bg-white/[0.02] border border-white/10'
                : 'backdrop-blur-xl bg-white/50 border border-white/20'
            }`}
          >
            <div className="relative pl-6">
              {/* Timeline line */}
              <div className={`absolute left-2 top-1 bottom-1 w-px ${isDark ? 'bg-white/10' : 'bg-zinc-200'}`} />
              <div className="space-y-4">
                {capsules.map((capsule, i) => {
                  const isSuccess = capsule.outcome === 'success';
                  return (
                    <div key={capsule.id || i} className="relative">
                      {/* Timeline dot */}
                      <div
                        className={`absolute -left-[18px] top-1 w-2.5 h-2.5 rounded-full border-2 ${
                          isSuccess ? 'bg-emerald-500 border-emerald-400' : 'bg-red-500 border-red-400'
                        }`}
                      />
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className={`text-xs font-medium ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                              {capsule.gene_title || capsule.gene_id?.slice(0, 16) || 'Unknown Gene'}
                            </span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded ${
                                isSuccess ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
                              }`}
                            >
                              {isSuccess ? 'Success' : 'Failed'}
                            </span>
                            {capsule.score !== undefined && (
                              <span className={`text-[10px] font-mono ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                                score: {capsule.score}
                              </span>
                            )}
                          </div>
                          {capsule.summary && (
                            <p className={`text-xs line-clamp-1 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                              {capsule.summary}
                            </p>
                          )}
                        </div>
                        <span className={`text-[10px] shrink-0 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                          {new Date(capsule.created_at).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Memory Graph (Collapsible) */}
      {genes.length > 0 && (
        <div>
          <button
            onClick={() => setShowGraph((prev) => !prev)}
            className={`flex items-center gap-2 font-bold mb-3 transition-colors ${isDark ? 'text-white hover:text-zinc-300' : 'text-zinc-900 hover:text-zinc-700'}`}
          >
            Memory Graph
            <svg
              className={`w-4 h-4 transition-transform duration-300 ${showGraph ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <div
            className="overflow-hidden transition-all duration-300 ease-in-out"
            style={{
              display: 'grid',
              gridTemplateRows: showGraph ? '1fr' : '0fr',
            }}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                className={`rounded-xl p-4 ${
                  isDark
                    ? 'backdrop-blur-xl bg-white/[0.02] border border-white/10'
                    : 'backdrop-blur-xl bg-white/50 border border-white/20'
                }`}
              >
                <EvolutionGraph genes={genes} width={700} height={350} className="max-w-full mx-auto" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
