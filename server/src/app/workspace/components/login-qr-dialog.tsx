'use client';

/**
 * LoginQrDialog — F2 "scan to log a new device into your account".
 *
 * Hangs off the global navbar profile dropdown. The web (already-authenticated)
 * user opens this, a QR is minted via `POST /api/auth/login-qr/create`, and the
 * mobile app scans `qrPayload` (`prismer://login-qr?offer=<48hex>`). The dialog
 * polls `GET /api/auth/login-qr/result/:offerId` ~every 1.5s.
 *
 * The MANDATORY second-confirmation gate: when a device scans, `result` flips to
 * `pending_confirm` and hands back the scanning device's label. We surface that
 * label prominently with explicit [确认登录] / [拒绝] affordances — this is the
 * human-in-the-loop defence against shoulder-surf / drive-by scans. Only after
 * the user clicks 确认登录 do we call `POST /api/auth/login-qr/confirm`, which
 * unlocks the token mint for mobile.
 *
 * Surface = workspace glass (surface.modal + radius.card); QR rendered via the
 * `qrcode` lib (same pattern as people-directory). All copy honours dark/light.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Loader2, RefreshCw, ShieldAlert, Smartphone, CheckCircle2, QrCode } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { radius, surface } from '../lib/design';

// Mirrors src/components/navbar.tsx getNotificationAuthHeaders — session JWT,
// falling back to an active API key. `create`/`confirm` are session-scoped.
function getAuthHeaders(): Record<string, string> {
  try {
    const authStored = localStorage.getItem('prismer_auth');
    if (authStored) {
      const authData = JSON.parse(authStored);
      if (authData.token && authData.expiresAt > Date.now()) return { Authorization: `Bearer ${authData.token}` };
    }
    const apiKeyStored = localStorage.getItem('prismer_active_api_key');
    if (apiKeyStored) {
      const keyData = JSON.parse(apiKeyStored);
      if (keyData.key && keyData.status === 'ACTIVE') return { Authorization: `Bearer ${keyData.key}` };
    }
  } catch {}
  return {};
}

type CreateResponse = { offerId: string; qrPayload: string; expiresAt: string | number };
type ResultResponse =
  | { status: 'pending' }
  | { status: 'pending_confirm'; consumerDevice?: string }
  // [SYNC-6] device binding — the web poll (no consumerToken) gets 'denied'
  // once approved (it never redeems the session); 'superseded' if a later scan
  // replaced this offer's pending device. The dialog reaches 'approved' via the
  // confirm response, so it just keeps polling on these (no UI action needed).
  | { status: 'denied' }
  | { status: 'superseded' }
  | { status: 'approved' }
  | { error?: { code: number; msg: string } };

type Phase =
  | 'loading' // minting the offer
  | 'waiting' // QR shown, nobody has scanned yet
  | 'confirm' // a device scanned — second-confirmation gate
  | 'confirming' // confirm request in flight
  | 'approved' // confirmed; new device logged in
  | 'expired' // offer timed out / 410
  | 'error'; // create failed

const POLL_MS = 1500;
const QR_TTL_MS = 120_000;

export interface LoginQrDialogProps {
  open: boolean;
  isDark: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional toast bridge (matches navbar's addToast signature). */
  notify?: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export function LoginQrDialog({ open, isDark, onOpenChange, notify }: LoginQrDialogProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [consumerDevice, setConsumerDevice] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(120);

  const offerIdRef = useRef<string | null>(null);
  const expiresAtRef = useRef<number>(0);

  // Mint a fresh offer + render its QR.
  const createOffer = useCallback(async () => {
    setPhase('loading');
    setQrDataUrl(null);
    setConsumerDevice('');
    setErrorMsg(null);
    offerIdRef.current = null;
    try {
      const res = await fetch('/api/auth/login-qr/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ResultResponse;
        setErrorMsg(('error' in body && body.error?.msg) || `创建二维码失败 (${res.status})`);
        setPhase('error');
        return;
      }
      const offer = (await res.json()) as CreateResponse;
      offerIdRef.current = offer.offerId;
      const expiresMs = typeof offer.expiresAt === 'number' ? offer.expiresAt : Date.parse(String(offer.expiresAt));
      expiresAtRef.current = Number.isFinite(expiresMs) && expiresMs > Date.now() ? expiresMs : Date.now() + QR_TTL_MS;
      const dataUrl = await QRCode.toDataURL(offer.qrPayload, {
        margin: 1,
        width: 224,
        color: { dark: '#111827', light: '#ffffff' },
      });
      setQrDataUrl(dataUrl);
      setPhase('waiting');
    } catch {
      setErrorMsg('网络错误，无法创建二维码');
      setPhase('error');
    }
  }, []);

  // On open → mint. On close → reset so the next open is clean.
  useEffect(() => {
    if (open) {
      void createOffer();
    } else {
      offerIdRef.current = null;
      setPhase('loading');
      setQrDataUrl(null);
      setConsumerDevice('');
      setErrorMsg(null);
    }
  }, [open, createOffer]);

  // Countdown — derived purely from expiresAt so it stays honest across tab
  // suspends. Flips to `expired` once it hits zero (only while still waiting).
  useEffect(() => {
    if (!open || (phase !== 'waiting' && phase !== 'confirm')) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((expiresAtRef.current - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0 && phase === 'waiting') setPhase('expired');
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [open, phase]);

  // Poll result while the QR is live or awaiting confirm.
  useEffect(() => {
    if (!open || (phase !== 'waiting' && phase !== 'confirm')) return;
    let cancelled = false;
    const poll = async () => {
      const offerId = offerIdRef.current;
      if (!offerId) return;
      try {
        const res = await fetch(`/api/auth/login-qr/result/${offerId}`);
        if (cancelled) return;
        if (res.status === 410) {
          setPhase('expired');
          return;
        }
        if (!res.ok) return;
        const body = (await res.json()) as ResultResponse;
        if (cancelled || !('status' in body)) return;
        if (body.status === 'pending_confirm') {
          setConsumerDevice(body.consumerDevice || '未知设备');
          // Don't clobber the confirm-in-flight / approved states.
          setPhase((prev) => (prev === 'waiting' || prev === 'confirm' ? 'confirm' : prev));
        } else if (body.status === 'approved') {
          // Approved out-of-band (e.g. confirmed elsewhere) —收尾.
          setPhase((prev) => (prev === 'confirming' || prev === 'approved' ? prev : 'approved'));
        }
      } catch {
        /* transient — keep polling */
      }
    };
    const id = window.setInterval(poll, POLL_MS);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open, phase]);

  async function handleConfirm() {
    const offerId = offerIdRef.current;
    if (!offerId) return;
    setPhase('confirming');
    try {
      const res = await fetch('/api/auth/login-qr/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ offerId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ResultResponse;
        const msg = ('error' in body && body.error?.msg) || `确认失败 (${res.status})`;
        notify?.(msg, 'error');
        // 410 → offer gone; otherwise let the user retry from the confirm gate.
        setPhase(res.status === 410 ? 'expired' : 'confirm');
        return;
      }
      setPhase('approved');
      notify?.('新设备已登录', 'success');
    } catch {
      notify?.('确认失败，请重试', 'error');
      setPhase('confirm');
    }
  }

  // Reject = do NOT confirm; the offer expires on its own. Just close.
  function handleReject() {
    notify?.('已拒绝该设备登录', 'info');
    onOpenChange(false);
  }

  const subtle = isDark ? 'text-zinc-400' : 'text-zinc-600';
  const muted = isDark ? 'text-zinc-500' : 'text-zinc-500';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="login-qr-dialog"
        className={`max-w-md border ${surface.modal[isDark ? 'dark' : 'light']} ${radius.card}`}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="h-5 w-5 opacity-80" />
            用二维码登录新设备
          </DialogTitle>
        </DialogHeader>

        {/* ── Confirm gate (highest priority — a device is waiting) ── */}
        {phase === 'confirm' || phase === 'confirming' ? (
          <div data-testid="login-qr-confirm" className="grid gap-4 pt-1">
            <div
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
                isDark
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-100'
                  : 'border-amber-300 bg-amber-50 text-amber-800'
              }`}
            >
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">有设备正在请求登录你的账号</p>
                <p className={`mt-0.5 text-xs ${isDark ? 'text-amber-200/80' : 'text-amber-700'}`}>
                  确认前请核对设备名称。不是你本人操作请立即拒绝。
                </p>
              </div>
            </div>

            <div
              className={`flex items-center gap-3 rounded-xl border px-4 py-4 ${
                isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'
              }`}
            >
              <span
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                  isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-600'
                }`}
              >
                <Smartphone className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className={`text-xs ${muted}`}>请求登录的设备</p>
                <p
                  data-testid="login-qr-device-name"
                  className={`truncate text-base font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}
                  title={consumerDevice}
                >
                  {consumerDevice || '未知设备'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-1">
              <Button
                variant="outline"
                onClick={handleReject}
                disabled={phase === 'confirming'}
                data-testid="login-qr-reject"
              >
                拒绝
              </Button>
              <Button onClick={handleConfirm} disabled={phase === 'confirming'} data-testid="login-qr-approve">
                {phase === 'confirming' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                确认登录
              </Button>
            </div>
          </div>
        ) : phase === 'approved' ? (
          /* ── Success ── */
          <div data-testid="login-qr-approved" className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle2 className="h-12 w-12 text-emerald-500" />
            <p className={`text-base font-semibold ${isDark ? 'text-white' : 'text-zinc-900'}`}>新设备已登录</p>
            <p className={`text-sm ${subtle}`}>
              {consumerDevice ? `「${consumerDevice}」已获授权访问你的账号。` : '新设备已获授权访问你的账号。'}
            </p>
            <Button className="mt-2" onClick={() => onOpenChange(false)} data-testid="login-qr-done">
              完成
            </Button>
          </div>
        ) : phase === 'expired' ? (
          /* ── Expired / consumed ── */
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className={`flex h-12 w-12 items-center justify-center rounded-full ${isDark ? 'bg-white/5' : 'bg-zinc-100'}`}>
              <RefreshCw className={`h-6 w-6 ${muted}`} />
            </div>
            <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>二维码已过期</p>
            <p className={`text-xs ${muted}`}>为了安全，二维码 120 秒后失效。</p>
            <Button variant="outline" className="mt-2" onClick={createOffer} data-testid="login-qr-refresh">
              <RefreshCw className="mr-1.5 h-4 w-4" />
              重新生成
            </Button>
          </div>
        ) : phase === 'error' ? (
          /* ── Create failed ── */
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <ShieldAlert className="h-10 w-10 text-red-500" />
            <p className={`text-sm font-medium ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>
              {errorMsg || '生成二维码失败'}
            </p>
            <Button variant="outline" className="mt-1" onClick={createOffer}>
              <RefreshCw className="mr-1.5 h-4 w-4" />
              重试
            </Button>
          </div>
        ) : (
          /* ── Waiting for scan (default) ── */
          <div className="flex flex-col items-center gap-4 pt-1">
            <p className={`text-sm ${subtle}`}>用新设备上的 Prismer App 扫描此二维码</p>
            <div
              className={`flex h-[240px] w-[240px] items-center justify-center rounded-2xl border bg-white p-2 shadow-sm ${
                isDark ? 'border-white/10' : 'border-zinc-200'
              }`}
            >
              {phase === 'loading' || !qrDataUrl ? (
                <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrDataUrl} alt="登录二维码" width={224} height={224} className="rounded-lg" />
              )}
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              {phase === 'waiting' ? (
                <>
                  <span className={`inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500`} />
                  <span className={muted}>
                    等待扫描 · <span className="tabular-nums">{secondsLeft}s</span> 后失效
                  </span>
                </>
              ) : (
                <span className={muted}>正在生成…</span>
              )}
            </div>
            <p className={`max-w-[280px] text-center text-[11px] ${muted}`}>
              扫描后，你需要在此处<strong className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>二次确认</strong>
              设备名称，才会真正授权登录。
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
