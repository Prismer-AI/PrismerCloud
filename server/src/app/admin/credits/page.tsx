'use client';

/**
 * /admin/credits — manual credit management (release202/12).
 *
 * Beta-era lever paired with the P1 balance gate: look a user up by numeric id
 * (pc_users.id — shown in /admin/analytics top-users), see balance + recent
 * transactions, and add/subtract credits with an audited reason. There is no
 * daily-refresh cron yet, so this is the interim top-up path.
 */

import { useCallback, useState } from 'react';
import { RefreshCw, Plus, Minus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Identity {
  userId: number;
  email: string | null;
  username: string | null;
  displayName: string | null;
}
interface Credits {
  user_id: number;
  balance: number;
  total_earned: number;
  total_spent: number;
  plan: string;
}
interface Transaction {
  id: string;
  type: string;
  amount: number;
  balance_after: number;
  description?: string;
  created_at: string;
}

function getAuthToken(): string | null {
  try {
    const stored = localStorage.getItem('prismer_auth');
    if (!stored) return null;
    const auth = JSON.parse(stored);
    if (auth.token && auth.expiresAt > Date.now()) return auth.token;
  } catch {
    /* ignore */
  }
  return null;
}

export default function AdminCreditsPage() {
  const [search, setSearch] = useState('');
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const authHeaders = useCallback((): Record<string, string> | null => {
    const token = getAuthToken();
    if (!token) {
      window.location.href = '/auth';
      return null;
    }
    return { Authorization: `Bearer ${token}` };
  }, []);

  const lookup = useCallback(
    async (queryOverride?: string) => {
      const q = (queryOverride ?? search).trim();
      if (!q) {
        setError('Enter an email, username, or user id');
        return;
      }
      const headers = authHeaders();
      if (!headers) return;
      setLoading(true);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch(`/api/admin/credits?q=${encodeURIComponent(q)}`, { headers });
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.error?.message ?? `Lookup failed (${res.status})`);
          setIdentity(null);
          setCredits(null);
          setTransactions([]);
          return;
        }
        setIdentity(json.data.identity ?? null);
        setCredits(json.data.credits);
        setTransactions(json.data.transactions ?? []);
      } catch {
        setError('Network error during lookup');
      } finally {
        setLoading(false);
      }
    },
    [search, authHeaders],
  );

  const adjust = useCallback(
    async (sign: 1 | -1) => {
      const id = identity?.userId;
      const amt = Number(amount);
      if (!id || !Number.isInteger(id) || id <= 0) {
        setError('Look up a user first');
        return;
      }
      if (!Number.isFinite(amt) || amt <= 0) {
        setError('Enter a positive amount; use the +/− buttons to choose direction');
        return;
      }
      const headers = authHeaders();
      if (!headers) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch('/api/admin/credits', {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: id, amount: sign * amt, reason }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json.error?.message ?? `Adjustment failed (${res.status})`);
          return;
        }
        setNotice(`${sign > 0 ? 'Added' : 'Subtracted'} ${amt} → new balance ${json.data.balance}`);
        setAmount('');
        setReason('');
        await lookup(String(id));
      } catch {
        setError('Network error during adjustment');
      } finally {
        setBusy(false);
      }
    },
    [identity, amount, reason, authHeaders, lookup],
  );

  return (
    <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Credit Management</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Look up a user by <strong>email, username, or id</strong> and manually add / subtract credits. Every change is
          recorded as a transaction stamped with your admin email. There is no daily-refresh cron — this is the interim
          top-up lever.
        </p>
      </header>

      {/* Lookup */}
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Email / username / user id</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookup()}
            placeholder="e.g. alice@acme.com · alice · 1024"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <Button onClick={() => lookup()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Look up
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          {notice}
        </div>
      )}

      {credits && (
        <>
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">
                  {identity?.displayName || identity?.username || identity?.email || `User ${credits.user_id}`}
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">
                  id {credits.user_id}
                  {identity?.email ? ` · ${identity.email}` : ''}
                  {identity?.username && identity.username !== identity.email ? ` · @${identity.username}` : ''}
                </div>
                <div className="mt-2 text-3xl font-semibold tabular-nums">{credits.balance}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400">credits</div>
              </div>
              <div className="text-right text-xs text-zinc-500 dark:text-zinc-400 space-y-1">
                <div>
                  <Badge variant="secondary">{credits.plan}</Badge>
                </div>
                <div>earned {credits.total_earned}</div>
                <div>spent {credits.total_spent}</div>
              </div>
            </div>

            {/* Adjust */}
            <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
              <div className="flex items-end gap-2">
                <label className="w-32">
                  <span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Amount</span>
                  <input
                    type="number"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="100"
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>
                <label className="flex-1">
                  <span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Reason (audited)</span>
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. beta top-up / support refund"
                    className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </label>
              </div>
              <div className="mt-2 flex gap-2">
                <Button onClick={() => adjust(1)} disabled={busy}>
                  <Plus className="h-4 w-4" />
                  Add
                </Button>
                <Button variant="outline" onClick={() => adjust(-1)} disabled={busy}>
                  <Minus className="h-4 w-4" />
                  Subtract
                </Button>
              </div>
            </div>
          </div>

          {/* Recent transactions */}
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="text-sm font-semibold mb-2">Recent transactions</h2>
            {transactions.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">No transactions.</p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 text-sm">
                {transactions.map((t) => (
                  <li key={t.id} className="flex items-center justify-between py-2">
                    <div className="min-w-0">
                      <span className="mr-2 inline-block">
                        <Badge variant="secondary">{t.type}</Badge>
                      </span>
                      <span className="text-zinc-500 dark:text-zinc-400 truncate">{t.description ?? ''}</span>
                    </div>
                    <div className="flex items-center gap-3 tabular-nums">
                      <span className={t.amount >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                        {t.amount >= 0 ? '+' : ''}
                        {t.amount}
                      </span>
                      <span className="text-zinc-400 w-16 text-right">{t.balance_after}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
