'use client';

/**
 * §30 B3.5 — Sub-blocks for ProTileAgent (role template grid, adapter
 * tabs, daemon status badge). Extracted so ProTileAgent stays under
 * the 250-line budget.
 */

import { Bot, Brain } from 'lucide-react';

import { radius } from '../../../lib/design';
import { ROLE_TEMPLATES, type AgentRoleTemplate } from '../../../lib/templates';
import { ModelPicker } from '../../model-picker';
import type { ProxyProvider } from '../../proxy-provider-select';
import type { DaemonTarget } from './daemon-target';

export type LongRunningAdapter = 'hermes' | 'openclaw';

// ───────────────────────── Role template grid ─────────────────────────

export function RoleTemplateGrid({
  isDark,
  selectedId,
  onSelect,
}: {
  isDark: boolean;
  selectedId: string;
  onSelect: (t: AgentRoleTemplate) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {ROLE_TEMPLATES.map((t) => {
        const active = selectedId === t.id;
        return (
          <button
            key={t.id}
            type="button"
            data-testid={`pro-tile-agent-template-${t.id}`}
            onClick={() => onSelect(t)}
            className={`border px-2 py-1.5 text-left text-xs transition-colors ${radius.button} ${
              active
                ? isDark
                  ? 'border-violet-400/40 bg-violet-400/10 text-violet-200'
                  : 'border-violet-300 bg-violet-50 text-violet-800'
                : isDark
                  ? 'border-white/10 text-zinc-300 hover:bg-white/[0.04]'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50'
            }`}
          >
            <span className="block font-semibold">{t.roleBadge}</span>
            <span className="block opacity-70">{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ───────────────────────── Adapter tabs ─────────────────────────

export function AdapterTabs({
  isDark,
  value,
  onChange,
}: {
  isDark: boolean;
  value: LongRunningAdapter;
  onChange: (next: LongRunningAdapter) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(['hermes', 'openclaw'] as const).map((a) => {
        const active = value === a;
        const Icon = a === 'hermes' ? Brain : Bot;
        return (
          <button
            key={a}
            type="button"
            data-testid={`pro-tile-agent-adapter-${a}`}
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

// ───────────────────────── Identity fields ─────────────────────────

export type AgentTypeOption = 'assistant' | 'specialist' | 'orchestrator' | 'tool' | 'bot';

const AGENT_TYPES: readonly AgentTypeOption[] = ['assistant', 'specialist', 'orchestrator', 'tool', 'bot'];

export interface IdentityFieldsProps {
  inputClass: string;
  labelClass: string;
  ids: { displayName: string; username: string; description: string; agentType: string };
  displayName: string;
  setDisplayName: (v: string) => void;
  username: string;
  setUsername: (v: string) => void;
  usernameDirty: boolean;
  setUsernameDirty: (v: boolean) => void;
  description: string;
  setDescription: (v: string) => void;
  agentType: AgentTypeOption;
  setAgentType: (v: AgentTypeOption) => void;
  usernameValid: boolean;
  suggestUsername: (display: string) => string;
}

export function IdentityFields(props: IdentityFieldsProps) {
  const {
    inputClass,
    labelClass,
    ids,
    displayName,
    setDisplayName,
    username,
    setUsername,
    usernameDirty,
    setUsernameDirty,
    description,
    setDescription,
    agentType,
    setAgentType,
    usernameValid,
    suggestUsername,
  } = props;
  return (
    <>
      <label className="grid gap-1" htmlFor={ids.displayName}>
        <span className={labelClass}>Display name</span>
        <input
          id={ids.displayName}
          data-testid="pro-tile-agent-display-name"
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
          data-testid="pro-tile-agent-username"
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
      <label className="grid gap-1" htmlFor={ids.description}>
        <span className={labelClass}>Description</span>
        <textarea
          id={ids.description}
          data-testid="pro-tile-agent-description"
          className={`${inputClass} min-h-[56px] resize-y`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
        />
      </label>
      <label className="grid gap-1" htmlFor={ids.agentType}>
        <span className={labelClass}>Agent type</span>
        <select
          id={ids.agentType}
          data-testid="pro-tile-agent-type"
          className={inputClass}
          value={agentType}
          onChange={(e) => setAgentType(e.target.value as AgentTypeOption)}
        >
          {AGENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

// ───────────────────────── Adapter config fields ─────────────────────────

export function HermesFields({
  isDark,
  inputClass,
  labelClass,
  ids,
  hermesPort,
  setHermesPort,
  hermesApiKey,
  setHermesApiKey,
  model,
  onModelChange,
  proxyProvider,
}: {
  isDark: boolean;
  inputClass: string;
  labelClass: string;
  ids: { hermesPort: string; hermesApiKey: string; model: string };
  hermesPort: string;
  setHermesPort: (v: string) => void;
  hermesApiKey: string;
  setHermesApiKey: (v: string) => void;
  model: string;
  onModelChange: (v: string) => void;
  /**
   * 2026-05-30 — proxyProvider × model 紧耦合. 透给嵌套的 ModelPicker, 让它
   * 按 provider 漏斗拉 list. optional 是为了不破现有 caller (workspace-inspector-
   * dialog 那种 ad-hoc 用法).
   */
  proxyProvider?: ProxyProvider;
}) {
  void isDark;
  return (
    <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)]">
      <label className="grid gap-1" htmlFor={ids.hermesPort}>
        <span className={labelClass}>Port</span>
        <input
          id={ids.hermesPort}
          data-testid="pro-tile-agent-hermes-port"
          className={inputClass}
          value={hermesPort}
          onChange={(e) => setHermesPort(e.target.value)}
          inputMode="numeric"
          placeholder="8642"
        />
      </label>
      <label className="grid gap-1" htmlFor={ids.hermesApiKey}>
        <span className={labelClass}>Hermes server key</span>
        <input
          id={ids.hermesApiKey}
          data-testid="pro-tile-agent-hermes-key"
          className={inputClass}
          value={hermesApiKey}
          onChange={(e) => setHermesApiKey(e.target.value)}
          type="password"
          placeholder="Auto-generated if empty"
          autoComplete="off"
        />
      </label>
      <label className="grid gap-1" htmlFor={ids.model}>
        <span className={labelClass}>Model</span>
        <ModelPicker value={model} onChange={onModelChange} proxyProvider={proxyProvider} />
      </label>
    </div>
  );
}

export function OpenClawField({
  inputClass,
  labelClass,
  id,
  value,
  onChange,
}: {
  inputClass: string;
  labelClass: string;
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="grid gap-1" htmlFor={id}>
      <span className={labelClass}>OpenClaw base URL</span>
      <input
        id={id}
        data-testid="pro-tile-agent-openclaw-url"
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="http://127.0.0.1:3000"
      />
    </label>
  );
}

// ───────────────────────── Daemon status badge ─────────────────────────

/**
 * Informational badge showing the currently-selected DaemonTarget's status.
 * Color flips emerald (bindable) ↔ amber (not bindable). Renders the target
 * label as the headline and the daemonId / mismatchReason as a mono detail.
 *
 * v200 K8S device picker (2026-05-19): generalized from LocalDaemonHealthDTO
 * to DaemonTarget so the badge mirrors whatever the user picked in the
 * runtime-host radio group above it.
 */
export function DaemonStatusBadge({ isDark, target }: { isDark: boolean; target: DaemonTarget | null }) {
  const bindable = !!target?.bindable;
  const headline = !target
    ? 'No device selected'
    : target.source === 'local-host'
      ? 'Local computer'
      : `Cloud computer (${target.status})`;
  const status = !target ? 'required' : bindable ? 'ready' : (target.mismatchReason ?? 'not ready');
  const detail = !target
    ? 'Run prismer setup or create a K8S device in this workspace.'
    : target.source === 'local-host'
      ? target.daemonId || 'Run prismer setup on this machine'
      : (target.daemonId ?? target.podName);
  return (
    <div
      data-testid="pro-tile-agent-daemon-status"
      className={`mt-1 border px-3 py-2 text-xs ${radius.button} ${
        bindable
          ? isDark
            ? 'border-emerald-400/20 bg-emerald-400/8 text-emerald-200'
            : 'border-emerald-200 bg-emerald-50 text-emerald-800'
          : isDark
            ? 'border-amber-400/20 bg-amber-400/8 text-amber-200'
            : 'border-amber-200 bg-amber-50 text-amber-800'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">{headline}</span>
        <span>{status}</span>
      </div>
      <p className="mt-0.5 truncate font-mono text-[10px] opacity-80">{detail}</p>
    </div>
  );
}
