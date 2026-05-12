'use client';

/**
 * §30 B3.5 — Pro mode Profile sub-panel.
 *
 * Standalone profile creation form (per spec §2.8.5: "Profile → 从
 * NewAgentDialog 拆出来独立化"). B0 audit recommended extracting the
 * runtime-profile block out of NewAgentDialog into a reusable form.
 *
 * What this panel does: pick an existing agent → pick adapter → name the
 * profile → adapter-specific config → POST /agent_profiles. No agent
 * registration, no conversation creation — pure profile binding for an
 * agent that already exists. Config builder lives in ./profile-config.ts.
 */

import { useId, useMemo, useState } from 'react';

import { radius, s } from '../../../lib/design';
import { createAgentProfile } from '../../../lib/mutations';
import type { AgentDTO } from '../../../lib/types';
import type { UnifiedCreationEvent } from '../UnifiedCreationModal';
import { inputClass as makeInput, labelClass as makeLabel, PanelFooter, PanelHeader } from './parts';
import { ModelPicker } from '../../model-picker';
import { ADAPTERS, buildProfileConfig, type AdapterName } from './profile-config';

export interface ProTileProfileProps {
  isDark: boolean;
  workspaceId: string;
  agents: AgentDTO[];
  onSuccess: (event: UnifiedCreationEvent) => void;
  onBack: () => void;
}

export function ProTileProfile({ isDark, workspaceId, agents, onSuccess, onBack }: ProTileProfileProps) {
  const theme = isDark ? 'dark' : 'light';
  const agentOnlyAgents = useMemo(() => agents.filter((a) => !!a.agentType), [agents]);

  const [agentImUserId, setAgentImUserId] = useState<string>(agentOnlyAgents[0]?.userId ?? '');
  const [adapterName, setAdapterName] = useState<AdapterName>('hermes');
  const [profileName, setProfileName] = useState('default');
  const [hermesPort, setHermesPort] = useState('8642');
  const [hermesApiKey, setHermesApiKey] = useState('');
  const [openclawBaseUrl, setOpenclawBaseUrl] = useState('http://127.0.0.1:3000');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [model, setModel] = useState('us-kimi-k2.6');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = {
    agent: useId(),
    profileName: useId(),
    hermesPort: useId(),
    hermesApiKey: useId(),
    model: useId(),
    openclawBaseUrl: useId(),
    systemPrompt: useId(),
  };

  const hermesPortValid =
    Number.isInteger(Number(hermesPort)) && Number(hermesPort) >= 1 && Number(hermesPort) <= 65535;
  const canSubmit =
    !submitting &&
    !!agentImUserId &&
    !!profileName.trim() &&
    (adapterName !== 'hermes' || hermesPortValid) &&
    !!workspaceId;

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    const config = buildProfileConfig(adapterName, { hermesPort, hermesApiKey, openclawBaseUrl, systemPrompt, model });
    const res = await createAgentProfile({
      workspaceId,
      agentImUserId,
      adapterName,
      name: profileName.trim() || 'default',
      config,
    });
    setSubmitting(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    // Reuse the `agent` event kind so parent's reload-on-agent-event picks up
    // the new profile binding.
    onSuccess({ kind: 'agent', ids: [agentImUserId] });
  }

  const inputClass = makeInput(isDark);
  const labelClass = makeLabel(isDark);

  return (
    <div data-testid="pro-tile-profile" className="grid gap-3">
      <PanelHeader
        isDark={isDark}
        title="New agent profile"
        subtitle="Bind an adapter config (hermes / openclaw / codex / claude-code) to an existing agent."
      />

      {agentOnlyAgents.length === 0 ? (
        <div
          data-testid="pro-tile-profile-empty"
          className={`border px-4 py-3 text-xs ${radius.card} ${s(theme, 'inset')} ${
            isDark ? 'text-zinc-400' : 'text-zinc-500'
          }`}
        >
          No agents in this workspace yet. Create an agent first, then return here to bind a profile.
        </div>
      ) : (
        <section className={`grid gap-2.5 border p-3 ${radius.card} ${s(theme, 'card')}`}>
          <label className="grid gap-1" htmlFor={ids.agent}>
            <span className={labelClass}>Agent</span>
            <select
              id={ids.agent}
              data-testid="pro-tile-profile-agent"
              className={inputClass}
              value={agentImUserId}
              onChange={(e) => setAgentImUserId(e.target.value)}
            >
              {agentOnlyAgents.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.name} ({a.agentType ?? 'agent'})
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-1">
            <span className={labelClass}>Adapter</span>
            <div className="flex flex-wrap gap-2">
              {ADAPTERS.map((a) => {
                const active = adapterName === a;
                return (
                  <button
                    key={a}
                    type="button"
                    data-testid={`pro-tile-profile-adapter-${a}`}
                    onClick={() => setAdapterName(a)}
                    className={`border px-3 py-1 text-[11px] font-semibold transition-colors ${radius.chip} ${
                      active
                        ? isDark
                          ? 'border-violet-400/40 bg-violet-400/10 text-violet-200'
                          : 'border-violet-300 bg-violet-50 text-violet-800'
                        : isDark
                          ? 'border-white/10 text-zinc-400 hover:bg-white/[0.04]'
                          : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'
                    }`}
                  >
                    {a}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="grid gap-1" htmlFor={ids.profileName}>
            <span className={labelClass}>Profile name</span>
            <input
              id={ids.profileName}
              data-testid="pro-tile-profile-name"
              className={inputClass}
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              placeholder="default"
              maxLength={48}
            />
          </label>

          {adapterName === 'hermes' ? (
            <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)]">
              <label className="grid gap-1" htmlFor={ids.hermesPort}>
                <span className={labelClass}>Port</span>
                <input
                  id={ids.hermesPort}
                  data-testid="pro-tile-profile-hermes-port"
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
                  data-testid="pro-tile-profile-hermes-key"
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
                <ModelPicker value={model} onChange={setModel} />
              </label>
              {!hermesPortValid ? (
                <p className="text-[10px] text-red-500 sm:col-span-2">Port must be between 1 and 65535.</p>
              ) : null}
            </div>
          ) : null}

          {adapterName === 'openclaw' ? (
            <label className="grid gap-1" htmlFor={ids.openclawBaseUrl}>
              <span className={labelClass}>OpenClaw base URL</span>
              <input
                id={ids.openclawBaseUrl}
                data-testid="pro-tile-profile-openclaw-url"
                className={inputClass}
                value={openclawBaseUrl}
                onChange={(e) => setOpenclawBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:3000"
              />
            </label>
          ) : null}

          <label className="grid gap-1" htmlFor={ids.systemPrompt}>
            <span className={labelClass}>System prompt (optional)</span>
            <textarea
              id={ids.systemPrompt}
              data-testid="pro-tile-profile-system-prompt"
              className={`${inputClass} min-h-[72px] resize-y`}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              maxLength={2000}
              placeholder="Seed the adapter with a role-specific prompt."
            />
          </label>

          {error ? (
            <p className={`text-xs ${isDark ? 'text-red-300' : 'text-red-600'}`} role="alert">
              {error}
            </p>
          ) : null}
        </section>
      )}

      <PanelFooter
        isDark={isDark}
        submitting={submitting}
        canSubmit={canSubmit}
        onBack={onBack}
        onSubmit={() => void handleSubmit()}
        submitLabel="Create profile"
        testIdBack="pro-tile-profile-back"
        testIdSubmit="pro-tile-profile-submit"
      />
    </div>
  );
}

export default ProTileProfile;
