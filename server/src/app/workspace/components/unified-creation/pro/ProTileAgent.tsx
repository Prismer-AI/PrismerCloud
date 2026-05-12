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
 * Sub-blocks (role template grid, adapter tabs, daemon status badge)
 * live in ./AgentSubBlocks.tsx so this file stays under 250 lines.
 */

import { useEffect, useId, useMemo, useState } from 'react';

import { radius, s } from '../../../lib/design';
import { isValidAgentUsername, suggestUsername, type AgentTypeEnum } from '../../../lib/mutations';
import { ROLE_TEMPLATES, type AgentRoleTemplate } from '../../../lib/templates';
import type { UnifiedCreationEvent } from '../UnifiedCreationModal';
import {
  AdapterTabs,
  DaemonStatusBadge,
  HermesFields,
  IdentityFields,
  OpenClawField,
  RoleTemplateGrid,
  type LongRunningAdapter,
} from './AgentSubBlocks';
import {
  buildLongRunningProfileConfig,
  createLongRunningAgent,
  generateLocalSecret,
} from './create-long-running-agent';
import { inputClass as makeInput, labelClass as makeLabel, PanelFooter, PanelHeader } from './parts';
import { useDaemonHealth } from './use-daemon-health';

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
  const [description, setDescription] = useState('');
  const [agentType, setAgentType] = useState<AgentTypeEnum>('orchestrator');
  const [hermesPort, setHermesPort] = useState('8642');
  const [hermesApiKey, setHermesApiKey] = useState('');
  const [openclawBaseUrl, setOpenclawBaseUrl] = useState('http://127.0.0.1:3000');
  const [model, setModel] = useState('us-kimi-k2.6');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Daemon health polling — scoped via the hook's lifecycle (B0 Risk #2).
  const {
    daemon: localDaemon,
    error: localDaemonError,
    workspaceMismatch: localDaemonWorkspaceMismatch,
    bindable: localDaemonBindable,
  } = useDaemonHealth(workspaceId);

  const selectedTemplate = useMemo(
    () => ROLE_TEMPLATES.find((t) => t.id === templateId) ?? ROLE_TEMPLATES[0],
    [templateId],
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
    localDaemonBindable &&
    (longAdapter !== 'hermes' || hermesPortValid);

  function applyTemplate(t: AgentRoleTemplate) {
    setTemplateId(t.id);
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
    if (!localDaemonBindable || !localDaemon) {
      setError(
        localDaemonWorkspaceMismatch
          ? `Local daemon is connected to workspace ${localDaemon?.workspaceId}, not this workspace.`
          : localDaemonError
            ? `Local daemon is not ready: ${localDaemonError}`
            : 'Local daemon is not connected to workspace IM yet.',
      );
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
    });
    const result = await createLongRunningAgent({
      workspaceId,
      displayName: displayName.trim(),
      username: username.trim(),
      agentType,
      description: description.trim() || undefined,
      adapter: longAdapter,
      daemon: localDaemon,
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
        <RoleTemplateGrid isDark={isDark} selectedId={templateId} onSelect={applyTemplate} />
      </section>

      <section className={`grid gap-2.5 border p-3 ${radius.card} ${s(theme, 'card')}`}>
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

        <AdapterTabs isDark={isDark} value={longAdapter} onChange={setLongAdapter} />

        {longAdapter === 'hermes' ? (
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
          />
        ) : (
          <OpenClawField
            inputClass={inputClass}
            labelClass={labelClass}
            id={ids.openclawBaseUrl}
            value={openclawBaseUrl}
            onChange={setOpenclawBaseUrl}
          />
        )}

        <DaemonStatusBadge
          isDark={isDark}
          daemon={localDaemon}
          daemonError={localDaemonError}
          bindable={localDaemonBindable}
          workspaceMismatch={localDaemonWorkspaceMismatch}
        />

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

export default ProTileAgent;
