'use client';

/**
 * doc 06 (release202) — Pro mode Executor (CLI) sub-panel.
 *
 * Adapted from ProTileAgent. Where ProTileAgent registers a long-running
 * ORCHESTRATOR (hermes/openclaw, role-template driven), this panel registers
 * an EXECUTOR/tool agent for the CLI adapters (codex / claude-code) — a
 * bounded coding executor with NO role template (doc 05 orchestrator/tool
 *二分).
 *
 * Reuse, don't reinvent (per task constraints):
 *   - ModelPicker (curated model dropdown)
 *   - AdvancedProxyAccordion (proxyProvider selector)
 *   - useDaemonTargets / DaemonTarget / daemonTargetKey + the runtime-host
 *     radio picker — executors run on local daemon OR k8s device, same as
 *     orchestrators.
 *   - createLongRunningAgent (the generalized register→profile→[k8s install]
 *     →conversation pipeline; we pass agentType:'tool').
 *   - buildProfileConfig (the codex/claude-code config builder, doc 06 U1).
 *
 * Adds (codex-specific): a Sandbox select (read-only / workspace-write /
 * danger-full-access, default workspace-write).
 *
 * Daemon-polling lifecycle mirrors ProTileAgent: useDaemonTargets mounts only
 * while this panel is rendered and tears down on Back.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Terminal, SquareTerminal } from 'lucide-react';

import { radius, s } from '../../../lib/design';
import { isValidAgentUsername, suggestUsername } from '../../../lib/mutations';
import { getDefaultModelForProvider } from '../../../lib/model-defaults';
import { ModelPicker } from '../../model-picker';
import type { ProxyProvider } from '../../proxy-provider-select';
import type { UnifiedCreationEvent } from '../context';
import { DaemonStatusBadge } from './AgentSubBlocks';
import { daemonTargetKey, type DaemonTarget } from './daemon-target';
import { createLongRunningAgent } from './create-long-running-agent';
import { buildProfileConfig, type CodexSandbox } from './profile-config';
import { inputClass as makeInput, labelClass as makeLabel, PanelFooter, PanelHeader } from './parts';
import { useDaemonTargets } from './use-daemon-health';
import { AdvancedProxyAccordion } from './AdvancedProxyAccordion';

/** The two CLI executor adapters. */
type ExecutorAdapter = 'codex' | 'claude-code';

const SANDBOX_OPTIONS: readonly CodexSandbox[] = ['read-only', 'workspace-write', 'danger-full-access'];

const ADAPTER_DEFAULTS: Record<ExecutorAdapter, { displayName: string; username: string }> = {
  codex: { displayName: 'Codex Executor', username: 'codex-executor' },
  'claude-code': { displayName: 'Claude Code Executor', username: 'claude-code-executor' },
};

export interface ProTileExecutorProps {
  isDark: boolean;
  workspaceId: string;
  onSuccess: (event: UnifiedCreationEvent) => void;
  onBack: () => void;
}

export function ProTileExecutor({ isDark, workspaceId, onSuccess, onBack }: ProTileExecutorProps) {
  const theme = isDark ? 'dark' : 'light';

  const [adapter, setAdapter] = useState<ExecutorAdapter>('codex');
  const [displayName, setDisplayName] = useState(ADAPTER_DEFAULTS.codex.displayName);
  const [username, setUsername] = useState(ADAPTER_DEFAULTS.codex.username);
  const [usernameDirty, setUsernameDirty] = useState(false);
  const [model, setModel] = useState(getDefaultModelForProvider('newapi'));
  const [proxyProvider, setProxyProvider] = useState<ProxyProvider>('newapi');
  const [sandbox, setSandbox] = useState<CodexSandbox>('workspace-write');

  // 切 adapter 时, 若用户没手改过 identity, 同步默认 display name / username.
  function selectAdapter(next: ExecutorAdapter) {
    setAdapter(next);
    if (!usernameDirty) {
      setDisplayName(ADAPTER_DEFAULTS[next].displayName);
      setUsername(ADAPTER_DEFAULTS[next].username);
    }
  }

  // proxyProvider × model 紧耦合: 切 provider 时 model reset 到该漏斗的 default.
  const prevProxyProviderRef = useRef<ProxyProvider | null>(null);
  useEffect(() => {
    if (prevProxyProviderRef.current === null) {
      prevProxyProviderRef.current = proxyProvider;
      return;
    }
    if (prevProxyProviderRef.current === proxyProvider) return;
    prevProxyProviderRef.current = proxyProvider;
    // Intentional model-reset on provider change (mirrors ProTileAgent).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModel(getDefaultModelForProvider(proxyProvider));
  }, [proxyProvider]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Multi-source host target polling — host daemon + K8S workspace devices.
  const { targets, loading: targetsLoading, error: targetsError } = useDaemonTargets(workspaceId);
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);

  const selectedTarget: DaemonTarget | null = useMemo(() => {
    if (targets.length === 0) return null;
    if (selectedTargetKey) {
      const found = targets.find((t) => daemonTargetKey(t) === selectedTargetKey);
      if (found) return found;
    }
    return targets.find((t) => t.bindable) ?? targets[0];
  }, [targets, selectedTargetKey]);

  const ids = {
    displayName: useId(),
    username: useId(),
    model: useId(),
    sandbox: useId(),
  };

  const usernameValid = !username || isValidAgentUsername(username);
  const canSubmit =
    !submitting && !!displayName.trim() && !!username.trim() && usernameValid && !!workspaceId && !!selectedTarget?.bindable;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    if (!selectedTarget?.bindable) {
      setError(selectedTarget?.mismatchReason ?? 'Pick a runtime host before creating the executor.');
      setSubmitting(false);
      return;
    }
    const config = buildProfileConfig(adapter, {
      hermesPort: '',
      hermesApiKey: '',
      openclawBaseUrl: '',
      systemPrompt: '',
      model,
      proxyProvider,
      sandbox,
    });
    const result = await createLongRunningAgent({
      workspaceId,
      displayName: displayName.trim(),
      username: username.trim(),
      agentType: 'tool',
      adapter,
      target: selectedTarget,
      config,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSuccess({ kind: 'agent', ids: [result.imUserId] });
  }

  const inputClass = makeInput(isDark);
  const labelClass = makeLabel(isDark);

  return (
    <div data-testid="pro-tile-executor" className="grid gap-3">
      <PanelHeader
        isDark={isDark}
        title="New CLI executor"
        subtitle="Register a codex / claude-code executor, configure its profile, and open a direct conversation."
      />

      <section className={`grid gap-2.5 border p-3 ${radius.card} ${s(theme, 'card')}`}>
        <ExecutorAdapterTabs isDark={isDark} value={adapter} onChange={selectAdapter} />

        {adapter === 'claude-code' ? (
          <p
            className={`text-[11px] ${isDark ? 'text-amber-300' : 'text-amber-700'}`}
            data-testid="pro-tile-executor-cc-note"
          >
            claude-code: provider override deferred (in production) — creation still allowed.
          </p>
        ) : null}

        <label className="grid gap-1" htmlFor={ids.displayName}>
          <span className={labelClass}>Display name</span>
          <input
            id={ids.displayName}
            data-testid="pro-tile-executor-display-name"
            className={inputClass}
            value={displayName}
            onChange={(e) => {
              const v = e.target.value;
              setDisplayName(v);
              if (!usernameDirty) setUsername(suggestUsername(v));
            }}
            maxLength={64}
          />
        </label>

        <label className="grid gap-1" htmlFor={ids.username}>
          <span className={labelClass}>Username</span>
          <input
            id={ids.username}
            data-testid="pro-tile-executor-username"
            className={inputClass}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameDirty(true);
            }}
            maxLength={32}
          />
          <span className={`text-[10px] ${usernameValid ? 'text-zinc-500' : 'text-red-500'}`}>
            3-32 chars, letters/digits/underscore/hyphen.
          </span>
        </label>

        <label className="grid gap-1" htmlFor={ids.model}>
          <span className={labelClass}>Model</span>
          <ModelPicker value={model} onChange={setModel} proxyProvider={proxyProvider} />
        </label>

        {adapter === 'codex' ? (
          <label className="grid gap-1" htmlFor={ids.sandbox}>
            <span className={labelClass}>Sandbox</span>
            <select
              id={ids.sandbox}
              data-testid="pro-tile-executor-sandbox"
              className={inputClass}
              value={sandbox}
              onChange={(e) => setSandbox(e.target.value as CodexSandbox)}
            >
              {SANDBOX_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <AdvancedProxyAccordion
          isDark={isDark}
          proxyProvider={proxyProvider}
          onProxyProviderChange={setProxyProvider}
          testIdPrefix="pro-tile-executor"
        />

        <DaemonTargetPicker
          isDark={isDark}
          targets={targets}
          selectedKey={selectedTarget ? daemonTargetKey(selectedTarget) : null}
          loading={targetsLoading}
          error={targetsError}
          onSelect={setSelectedTargetKey}
          labelClass={labelClass}
        />

        <DaemonStatusBadge isDark={isDark} target={selectedTarget} />

        {error ? (
          <p className={`text-xs ${isDark ? 'text-red-300' : 'text-red-600'}`} role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <PanelFooter
        isDark={isDark}
        submitting={submitting}
        canSubmit={canSubmit}
        onBack={onBack}
        onSubmit={() => void handleSubmit()}
        submitLabel="Create executor"
        testIdBack="pro-tile-executor-back"
        testIdSubmit="pro-tile-executor-submit"
      />
    </div>
  );
}

// ───────────────────────── Adapter tabs ─────────────────────────

/** Mirrors AgentSubBlocks.AdapterTabs styling, swapped for the CLI adapters. */
function ExecutorAdapterTabs({
  isDark,
  value,
  onChange,
}: {
  isDark: boolean;
  value: ExecutorAdapter;
  onChange: (next: ExecutorAdapter) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(['codex', 'claude-code'] as const).map((a) => {
        const active = value === a;
        const Icon = a === 'codex' ? Terminal : SquareTerminal;
        return (
          <button
            key={a}
            type="button"
            data-testid={`pro-tile-executor-adapter-${a}`}
            onClick={() => onChange(a)}
            className={`inline-flex items-center gap-2 border px-3 py-1.5 text-xs font-semibold transition-colors ${radius.button} ${
              active
                ? isDark
                  ? 'border-violet-400/40 bg-violet-400/10 text-violet-200'
                  : 'border-violet-300 bg-violet-50 text-violet-800'
                : isDark
                  ? 'border-white/10 text-zinc-300 hover:bg-white/[0.04]'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {a}
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────── Runtime host picker ─────────────────────────

/**
 * Inline radio-group picker for the runtime host. Mirrors ProTileAgent's
 * (non-exported) DaemonTargetPicker so executors get the identical local +
 * k8s-device selection without coupling to the orchestrator panel.
 */
function DaemonTargetPicker({
  isDark,
  targets,
  selectedKey,
  loading,
  error,
  onSelect,
  labelClass,
}: {
  isDark: boolean;
  targets: DaemonTarget[];
  selectedKey: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (key: string) => void;
  labelClass: string;
}) {
  return (
    <div className="grid gap-1.5" data-testid="pro-tile-executor-target-picker">
      <span className={labelClass}>Runtime host</span>
      {targets.length === 0 && loading ? (
        <p className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-500'}`}>Loading host candidates…</p>
      ) : null}
      {targets.length === 0 && !loading ? (
        <p className={`text-xs ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
          No host available. Create a K8S device in this workspace or pair the local daemon with `prismer setup`.
        </p>
      ) : null}
      {targets.length > 0 ? (
        <ul className="grid gap-1">
          {targets.map((t) => {
            const key = daemonTargetKey(t);
            const checked = key === selectedKey;
            return (
              <li key={key}>
                <label
                  className={`flex cursor-pointer items-center gap-2 border px-2.5 py-1.5 text-xs ${radius.button} ${
                    checked
                      ? isDark
                        ? 'border-violet-400/40 bg-violet-400/10 text-violet-200'
                        : 'border-violet-300 bg-violet-50 text-violet-800'
                      : isDark
                        ? 'border-white/10 text-zinc-300 hover:bg-white/[0.04]'
                        : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'
                  } ${t.bindable ? '' : 'opacity-70'}`}
                >
                  <input
                    type="radio"
                    name="pro-tile-executor-target"
                    data-testid={`pro-tile-executor-target-${t.source}`}
                    checked={checked}
                    onChange={() => onSelect(key)}
                    disabled={!t.bindable}
                  />
                  <span className="flex-1 truncate">{t.label}</span>
                  {!t.bindable && t.mismatchReason ? (
                    <span className={`shrink-0 ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                      {t.mismatchReason}
                    </span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? <p className={`text-[10px] ${isDark ? 'text-red-300' : 'text-red-600'}`}>K8S devices: {error}</p> : null}
    </div>
  );
}

export default ProTileExecutor;
