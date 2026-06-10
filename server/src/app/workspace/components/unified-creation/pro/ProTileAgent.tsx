'use client';

/**
 * §30 B3.5 — Pro mode Agent sub-panel.
 *
 * Copy of NewAgentDialog's long-running creation path. Pro Agent ALWAYS
 * means long-running (the CLI branch lives only in the legacy dialog).
 * The 3-call pipeline (register → profile → direct conversation) follows
 * NewAgentDialog.handleSubmit lines 318-361 verbatim, including partial-
 * success error messaging — see B0 audit Risk #1.
 *
 * B0 Risk #2 mitigation: daemon polling effect lives in THIS file and
 * only mounts while the Pro Agent sub-panel is rendered. Pressing Back
 * unmounts ProTileAgent and the interval is cleared via cleanup —
 * polling never leaks across the picker boundary.
 *
 * v200 K8S device picker (2026-05-19): the host candidate dropdown now lists
 * BOTH the local host daemon AND any workspace K8S devices. Selected target
 * threads through to create-long-running-agent.ts which dispatches the
 * install path (WS pull for host, runtime-installations POST for K8S).
 *
 * Sub-blocks (role template grid, adapter tabs, daemon status badge)
 * live in ./AgentSubBlocks.tsx so this file stays under 250 lines.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookOpenText, ChevronRight } from 'lucide-react';

import { radius, s } from '../../../lib/design';
import { isValidAgentUsername, suggestUsername, type AgentTypeEnum } from '../../../lib/mutations';
import { getDefaultModelForProvider } from '../../../lib/model-defaults';
import { ROLE_TEMPLATES, type AgentRoleTemplate } from '../../../lib/templates';
import type { UnifiedCreationEvent } from '../context';
import {
  AdapterTabs,
  DaemonStatusBadge,
  HermesFields,
  IdentityFields,
  OpenClawField,
  RoleTemplateGrid,
  type LongRunningAdapter,
} from './AgentSubBlocks';
import { daemonTargetKey, type DaemonTarget } from './daemon-target';
import {
  buildLongRunningProfileConfig,
  createLongRunningAgent,
  generateLocalSecret,
} from './create-long-running-agent';
import { inputClass as makeInput, labelClass as makeLabel, PanelFooter, PanelHeader } from './parts';
import { useDaemonTargets } from './use-daemon-health';
import { RoleSearchPalette } from './RoleSearchPalette';
import { BrowseAllRolesModal } from '../template-browser';
import { adaptApiRowToRoleTemplate } from './adapt-role-template';
import { AdvancedProxyAccordion } from './AdvancedProxyAccordion';
import type { ProxyProvider } from '../../proxy-provider-select';

export interface ProTileAgentProps {
  isDark: boolean;
  workspaceId: string;
  onSuccess: (event: UnifiedCreationEvent) => void;
  onBack: () => void;
}

export function ProTileAgent({ isDark, workspaceId, onSuccess, onBack }: ProTileAgentProps) {
  const theme = isDark ? 'dark' : 'light';

  const [templateId, setTemplateId] = useState(ROLE_TEMPLATES[0]?.id ?? 'custom');
  const [longAdapter, setLongAdapter] = useState<LongRunningAdapter>('hermes');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameDirty, setUsernameDirty] = useState(false);
  // Identity fields (display name / @handle / description / agent type) are
  // auto-seeded from the picked template and only need to be edited in <5%
  // of cases. Collapse by default to stop them dominating the form.
  const [identityOpen, setIdentityOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [agentType, setAgentType] = useState<AgentTypeEnum>('orchestrator');
  const [hermesPort, setHermesPort] = useState('8642');
  const [hermesApiKey, setHermesApiKey] = useState('');
  const [openclawBaseUrl, setOpenclawBaseUrl] = useState('http://127.0.0.1:3000');
  const [model, setModel] = useState(getDefaultModelForProvider('newapi'));
  const [proxyProvider, setProxyProvider] = useState<ProxyProvider>('newapi');

  // 2026-05-30 — proxyProvider × model 紧耦合. 切 provider 时 model reset 到
  // 该漏斗的 default. prev-value ref 避免初次 mount 把 useState seed 冲掉.
  const prevProxyProviderRef = useRef<ProxyProvider | null>(null);
  useEffect(() => {
    if (prevProxyProviderRef.current === null) {
      prevProxyProviderRef.current = proxyProvider;
      return;
    }
    if (prevProxyProviderRef.current === proxyProvider) return;
    prevProxyProviderRef.current = proxyProvider;
    setModel(getDefaultModelForProvider(proxyProvider));
  }, [proxyProvider]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Multi-source host target polling — host daemon + K8S workspace devices.
  const { targets, loading: targetsLoading, error: targetsError } = useDaemonTargets(workspaceId);
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);

  // Default the picker to the first bindable target, falling back to the first
  // entry (the host) so the UI always shows a selection.
  const selectedTarget: DaemonTarget | null = useMemo(() => {
    if (targets.length === 0) return null;
    if (selectedTargetKey) {
      const found = targets.find((t) => daemonTargetKey(t) === selectedTargetKey);
      if (found) return found;
    }
    return targets.find((t) => t.bindable) ?? targets[0];
  }, [targets, selectedTargetKey]);

  // Search-selected template from the role library palette (200+ agency
  // templates). Takes precedence over the 5-tile grid id when set.
  const [searchTemplate, setSearchTemplate] = useState<AgentRoleTemplate | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);

  const selectedTemplate = useMemo(
    () => searchTemplate ?? ROLE_TEMPLATES.find((t) => t.id === templateId) ?? ROLE_TEMPLATES[0],
    [searchTemplate, templateId],
  );

  // Seed defaults from initial template once on mount.
  useEffect(() => {
    if (!selectedTemplate) return;
    setDisplayName(selectedTemplate.defaultDisplayName || selectedTemplate.label);
    setUsername(suggestUsername(selectedTemplate.defaultUsernameSeed || selectedTemplate.label));
    setDescription(`${selectedTemplate.label} role agent. ${selectedTemplate.pitch}`.slice(0, 500));
    setLongAdapter(selectedTemplate.defaultAdapter);
    setUsernameDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ids = {
    displayName: useId(),
    username: useId(),
    agentType: useId(),
    description: useId(),
    hermesPort: useId(),
    hermesApiKey: useId(),
    model: useId(),
    openclawBaseUrl: useId(),
  };

  const usernameValid = !username || isValidAgentUsername(username);
  const hermesPortValid =
    Number.isInteger(Number(hermesPort)) && Number(hermesPort) >= 1 && Number(hermesPort) <= 65535;
  const canSubmit =
    !submitting &&
    !!displayName.trim() &&
    !!username.trim() &&
    usernameValid &&
    !!workspaceId &&
    !!selectedTarget?.bindable &&
    (longAdapter !== 'hermes' || hermesPortValid);

  function applyTemplate(t: AgentRoleTemplate, source: 'grid' | 'search' = 'grid') {
    if (source === 'search') {
      setSearchTemplate(t);
      // Clear grid selection so the active highlight reflects search choice.
      setTemplateId('');
    } else {
      setSearchTemplate(null);
      setTemplateId(t.id);
    }
    setDisplayName(t.defaultDisplayName || t.label);
    setUsername(suggestUsername(t.defaultUsernameSeed || t.label));
    setDescription(`${t.label} role agent. ${t.pitch}`.slice(0, 500));
    setLongAdapter(t.defaultAdapter);
    setAgentType(t.id === 'custom' ? 'assistant' : 'orchestrator');
    setUsernameDirty(false);
  }

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);
    if (!selectedTarget?.bindable) {
      setError(selectedTarget?.mismatchReason ?? 'Pick a runtime host before creating the agent.');
      setSubmitting(false);
      return;
    }
    const config = buildLongRunningProfileConfig({
      adapter: longAdapter,
      template: selectedTemplate,
      hermesPort,
      hermesApiKey: hermesApiKey.trim() || generateLocalSecret('hermes'),
      openclawBaseUrl,
      model,
      proxyProvider,
    });
    const result = await createLongRunningAgent({
      workspaceId,
      displayName: displayName.trim(),
      username: username.trim(),
      agentType,
      description: description.trim() || undefined,
      adapter: longAdapter,
      target: selectedTarget,
      template: selectedTemplate,
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
    <div data-testid="pro-tile-agent" className="grid gap-3">
      <PanelHeader
        isDark={isDark}
        title="New long-running agent"
        subtitle="Register, configure adapter profile, and open a direct conversation."
      />

      <section className={`grid gap-2 border p-3 ${radius.card} ${s(theme, 'card')}`}>
        <span className={labelClass}>Role template</span>
        {/* Two coequal entry points: search palette for power users who know
            the role, browse button for users who want to scan the catalogue. */}
        <div className="flex items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <RoleSearchPalette isDark={isDark} onSelect={(t) => applyTemplate(t, 'search')} disabled={submitting} />
          </div>
          <button
            type="button"
            onClick={() => setBrowseOpen(true)}
            data-testid="pro-role-browse-all"
            className={[
              'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60',
              isDark
                ? 'border-violet-400/40 bg-violet-500/10 text-violet-100 hover:border-violet-300/70 hover:bg-violet-500/20'
                : 'border-violet-300 bg-violet-50 text-violet-800 hover:border-violet-400 hover:bg-violet-100',
            ].join(' ')}
          >
            <BookOpenText aria-hidden className="h-3.5 w-3.5" strokeWidth={1.8} />
            浏览全部
          </button>
        </div>
        <BrowseAllRolesModal
          open={browseOpen}
          onOpenChange={setBrowseOpen}
          isDark={isDark}
          mode="single"
          selectedSlugs={new Set(searchTemplate ? [searchTemplate.id] : [])}
          onPick={(item) => applyTemplate(adaptApiRowToRoleTemplate(item), 'search')}
          targetWorkspaceId={workspaceId}
          onForked={(result) => onSuccess({ kind: 'agent', ids: [result.newImUserId] })}
        />
        {searchTemplate ? (
          <div
            className={`flex items-baseline justify-between rounded-md border px-2 py-1.5 text-xs ${
              isDark
                ? 'border-violet-400/30 bg-violet-400/10 text-violet-200'
                : 'border-violet-200 bg-violet-50 text-violet-800'
            }`}
            data-testid="pro-role-search-selected"
          >
            <span className="truncate">已选库内角色：{searchTemplate.label}</span>
            <button
              type="button"
              onClick={() => applyTemplate(ROLE_TEMPLATES[0])}
              className={isDark ? 'text-violet-300 hover:text-violet-200' : 'text-violet-700 hover:text-violet-900'}
            >
              清除
            </button>
          </div>
        ) : null}
        <RoleTemplateGrid isDark={isDark} selectedId={templateId} onSelect={(t) => applyTemplate(t, 'grid')} />
      </section>

      <section className={`grid gap-2.5 border p-3 ${radius.card} ${s(theme, 'card')}`}>
        <button
          type="button"
          onClick={() => setIdentityOpen((open) => !open)}
          data-testid="pro-tile-agent-identity-toggle"
          aria-expanded={identityOpen}
          className={[
            'group flex w-full items-center justify-between rounded-md px-1 py-1 text-left',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60',
            isDark ? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-700 hover:text-zinc-900',
          ].join(' ')}
        >
          <span className="flex items-center gap-1.5">
            <ChevronRight
              aria-hidden
              className={`h-3.5 w-3.5 transition-transform ${identityOpen ? 'rotate-90' : ''}`}
              strokeWidth={2}
            />
            <span className="text-xs font-medium">名称 / 用户名 / 描述</span>
          </span>
          <span className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {identityOpen ? '收起' : `已自动填写：${displayName || '—'}`}
          </span>
        </button>
        {identityOpen ? (
          <IdentityFields
            inputClass={inputClass}
            labelClass={labelClass}
            ids={ids}
            displayName={displayName}
            setDisplayName={setDisplayName}
            username={username}
            setUsername={setUsername}
            usernameDirty={usernameDirty}
            setUsernameDirty={setUsernameDirty}
            description={description}
            setDescription={setDescription}
            agentType={agentType}
            setAgentType={setAgentType}
            usernameValid={usernameValid}
            suggestUsername={suggestUsername}
          />
        ) : null}

        <AdapterTabs isDark={isDark} value={longAdapter} onChange={setLongAdapter} />

        {longAdapter === 'hermes' ? (
          <>
            <HermesFields
              isDark={isDark}
              inputClass={inputClass}
              labelClass={labelClass}
              ids={{ hermesPort: ids.hermesPort, hermesApiKey: ids.hermesApiKey, model: ids.model }}
              hermesPort={hermesPort}
              setHermesPort={setHermesPort}
              hermesApiKey={hermesApiKey}
              setHermesApiKey={setHermesApiKey}
              model={model}
              onModelChange={setModel}
              proxyProvider={proxyProvider}
            />
            <AdvancedProxyAccordion
              isDark={isDark}
              proxyProvider={proxyProvider}
              onProxyProviderChange={setProxyProvider}
              testIdPrefix="pro-tile-agent"
            />
          </>
        ) : (
          <OpenClawField
            inputClass={inputClass}
            labelClass={labelClass}
            id={ids.openclawBaseUrl}
            value={openclawBaseUrl}
            onChange={setOpenclawBaseUrl}
          />
        )}

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
        submitLabel="Create agent"
        testIdBack="pro-tile-agent-back"
        testIdSubmit="pro-tile-agent-submit"
      />
    </div>
  );
}

/**
 * Inline radio-group picker: lists every DaemonTarget the workspace can host
 * the agent on. Disabled rows render their `mismatchReason` so the user knows
 * why they can't be picked (e.g. "Paired to workspace cmp1zqd…" for the host
 * daemon when paired to a different workspace).
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
    <div className="grid gap-1.5" data-testid="pro-tile-agent-target-picker">
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
                    name="pro-tile-agent-target"
                    data-testid={`pro-tile-agent-target-${t.source}`}
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

export default ProTileAgent;
