'use client';

/**
 * ModelPicker — fetches the curated model list from /api/models and renders a
 * styled `<select>` dropdown for model selection.
 *
 * States:
 *   Loading → disabled "Loading models…" option
 *   Error   → disabled "Models unavailable" + fallback to hardcoded pair
 *   Empty   → disabled "No models available" + fallback
 *   OK      → normal select with curated model list
 *
 * 2026-05-30 — `proxyProvider` prop 加入 (proxyProvider × model 紧耦合):
 * 当 caller 传 `'newapi'` 或 `'deepseek'` 时, picker 把 `?provider=…` query
 * 透给 `/api/models`, server 端按对应漏斗返回 model list. prop 变化触发
 * 重新 fetch + 清缓存. 缺失时走 server-side env-driven fallback (老 CLI / 没接
 * 该 prop 的旧 caller 行为不变).
 */

import { useEffect, useRef, useState } from 'react';
import { getWorkspaceToken } from '../lib/im-api';
import type { ProxyProvider } from './proxy-provider-select';

export interface ModelOption {
  id: string;
  name: string;
}

interface ModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  /** When true, adds a "Custom…" option with a text input for free-form model IDs. */
  allowCustom?: boolean;
  className?: string;
  disabled?: boolean;
  /**
   * 2026-05-30 — proxyProvider × model 紧耦合. 传时把 `?provider=…` 透给
   * `/api/models`, 拉到的 list 就是该 provider 的漏斗. 不传走 server-side
   * fallback (CLI / legacy caller behaviour 保留).
   */
  proxyProvider?: ProxyProvider;
  /**
   * release202/12 C1 — the chain's `primaryDefaultModel` (from
   * `GET /api/provider-chains`). Used ONLY for the network-failure fallback
   * list: for a CUSTOM chain (one the built-in funnels don't recognise) we
   * surface this single entry instead of collapsing to the wrong newapi list.
   * Optional — built-in `newapi`/`deepseek` chains don't need it.
   */
  fallbackModel?: string;
}

// Used only when `/api/models` fetch itself fails (network / 500). The list
// returned by the cloud is the canonical source; in healthy operation the
// auto-correct effect below promotes the user to the cloud's first entry.
// This pair is a stable last-ditch UI affordance so the picker isn't empty
// — the actual values used by the upstream still come from the proxy.
//
// 2026-05-30 — fallbacks 按 provider 分两套, 跟 curated-models.ts 的漏斗对齐.
// `undefined` 走 NewAPI 漏斗 (跟 server 端 env-default 的最常见 case 一致).
const FALLBACK_BY_PROVIDER: Record<'newapi' | 'deepseek', ModelOption[]> = {
  newapi: [
    { id: 'us-kimi-k2.6', name: 'Kimi K2.6' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
  ],
  deepseek: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ],
};

function fallbackFor(provider: ProxyProvider | undefined, fallbackModel?: string): ModelOption[] {
  // release202/07 + release202/12 C1 — ProxyProvider is now any chain id.
  //   - `deepseek`              → the deepseek funnel
  //   - `newapi`/`default`/none → the newapi funnel
  //   - any CUSTOM chain id     → the chain's own `primaryDefaultModel` if the
  //     caller supplied it (never the wrong newapi kimi list); else empty so
  //     the picker shows "No models available" rather than lying about the
  //     funnel. In healthy operation `/api/models?provider=<chain>` returns the
  //     real list and this fallback never shows.
  if (provider === 'deepseek') return FALLBACK_BY_PROVIDER.deepseek;
  if (provider === undefined || provider === 'newapi' || provider === 'default') {
    return FALLBACK_BY_PROVIDER.newapi;
  }
  return fallbackModel ? [{ id: fallbackModel, name: fallbackModel }] : [];
}

export function ModelPicker({
  value,
  onChange,
  allowCustom = false,
  className = '',
  disabled = false,
  proxyProvider,
  fallbackModel,
}: ModelPickerProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customValue, setCustomValue] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  // 2026-05-30 — proxyProvider 变化时重新 fetch + 清缓存. 把 fallback 也按
  // provider 漏斗对齐, 避免短暂 network 抖动时露出旧 list.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const token = getWorkspaceToken();
    const query = proxyProvider ? `?provider=${encodeURIComponent(proxyProvider)}` : '';
    fetch(`/api/models${query}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(String(res.status))))
      .then((body) => {
        if (cancelled) return;
        const items: ModelOption[] = (body.data ?? [])
          .filter((m: { id: unknown; owned_by?: unknown }) => m.id && typeof m.id === 'string')
          .map((m: { id: string }) => ({ id: m.id, name: m.id }));
        setModels(items.length > 0 ? items : fallbackFor(proxyProvider, fallbackModel));
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
        setModels(fallbackFor(proxyProvider, fallbackModel));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [proxyProvider, fallbackModel]);

  // When custom is active sync the text input value upward.
  useEffect(() => {
    if (showCustomInput && customValue) onChange(customValue);
  }, [customValue, showCustomInput, onChange]);

  // 2026-05-29 — auto-correct stale defaults. The parent likely seeded
  // `value` from a hardcoded fallback (e.g. UnifiedCreationModal seeds
  // DEFAULT_MODEL='us-kimi-k2.6' synchronously). Once the live curated
  // list arrives, if the seeded value isn't actually offered we silently
  // promote the user to the first listed model. This is what makes the
  // simple-create flow follow the env-driven model source (e.g. DeepSeek
  // bypass surfaces deepseek-v4-flash instead of stale kimi).
  //
  // 2026-05-30 — when the parent passes `proxyProvider` and explicitly resets
  // `value` via getDefaultModelForProvider() on provider change, that path
  // already lands the picker on a valid entry, so the auto-correct here is
  // a defensive backstop for stale drafts (e.g. wizard re-mounts mid-edit).
  //
  // Skipped when `allowCustom` AND the parent has flagged custom input —
  // a deliberate non-listed value should not be overwritten.
  //
  // Guarded against echo loops: if the parent doesn't change `value` after we
  // call `onChange` (e.g. the props are decoupled from the state we just
  // emitted), `lastCorrectedRef` blocks the second fire.
  const lastCorrectedRef = useRef<string | null>(null);
  useEffect(() => {
    if (loading) return;
    if (models.length === 0) return;
    if (showCustomInput) return;
    if (value && models.some((m) => m.id === value)) {
      lastCorrectedRef.current = null;
      return;
    }
    if (lastCorrectedRef.current === models[0].id) return;
    lastCorrectedRef.current = models[0].id;
    onChange(models[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, models, showCustomInput, value]);

  const isCustomSelected = showCustomInput || (value && !models.some((m) => m.id === value));

  function handleSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    const selected = e.target.value;
    if (selected === '__custom__') {
      setShowCustomInput(true);
      if (customValue) onChange(customValue);
    } else {
      setShowCustomInput(false);
      onChange(selected);
    }
  }

  const resolvedValue = showCustomInput ? '__custom__' : value;

  return (
    <div className={`grid gap-1 ${className}`}>
      {allowCustom && isCustomSelected && !showCustomInput ? (
        // Existing value is a custom (non-listed) model — show input directly
        <input
          className={`h-10 rounded-2xl border px-3 text-sm outline-none disabled:opacity-50 ${
            disabled ? 'cursor-not-allowed' : ''
          }`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter model ID…"
          disabled={disabled}
        />
      ) : showCustomInput ? (
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <select
              value="__custom__"
              onChange={handleSelect}
              disabled={disabled || loading}
              className={`h-10 flex-1 rounded-2xl border px-3 text-sm outline-none disabled:opacity-50 ${
                disabled ? 'cursor-not-allowed' : ''
              }`}
            >
              <option value="__custom__">Custom model…</option>
            </select>
          </div>
          <input
            className={`h-10 rounded-2xl border px-3 text-sm outline-none disabled:opacity-50 ${
              disabled ? 'cursor-not-allowed' : ''
            }`}
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            placeholder="Enter model ID…"
            disabled={disabled}
          />
        </div>
      ) : loading ? (
        <select
          disabled
          className={`h-10 rounded-2xl border px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        >
          <option>Loading models…</option>
        </select>
      ) : error && models.length === 0 ? (
        <select
          disabled
          className={`h-10 rounded-2xl border px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        >
          <option>Models unavailable</option>
        </select>
      ) : (
        <select
          value={resolvedValue}
          onChange={handleSelect}
          disabled={disabled}
          className={`h-10 rounded-2xl border px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        >
          {models.length === 0 ? (
            <option value="" disabled>
              No models available
            </option>
          ) : (
            models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))
          )}
          {allowCustom ? <option value="__custom__">Custom model…</option> : null}
        </select>
      )}
    </div>
  );
}
