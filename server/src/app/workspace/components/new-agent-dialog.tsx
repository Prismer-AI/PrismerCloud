'use client';

/**
 * "New Agent" modal — wraps `POST /api/im/register {type:'agent'}`.
 *
 * The form is intentionally split into two creation paths while preserving the
 * existing createAgent mutation contract:
 *   - CLI code agents: codex / claude-code adapters for bounded task execution.
 *   - Long-running role agents: hermes / openclaw adapters, seeded from role
 *     templates and the workspace agent-kind taxonomy.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, Brain, Check, Code2, Cpu, Loader2, Network, ShieldCheck, Sparkles, Terminal, Zap } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  isValidAgentUsername,
  suggestUsername,
  createAgent,
  createAgentProfile,
  createDirectConversation,
  getLocalDaemonHealth,
  type AgentTypeEnum,
} from '../lib/mutations';
import { AGENT_KIND_PRESETS, type AgentKind } from '../lib/agent-kind';
import { radius, s, springHeavy, springSnap, springSoft } from '../lib/design';
import { ModelPicker } from './model-picker';
import { ROLE_TEMPLATES, type AgentRoleTemplate } from '../lib/templates';
import type { LocalDaemonHealthDTO } from '../lib/types';

type CliAdapter = 'codex' | 'claude-code';
type LongRunningAdapter = 'hermes' | 'openclaw';
type Adapter = CliAdapter | LongRunningAdapter;

const CLI_ADAPTERS: Array<{
  id: CliAdapter;
  label: string;
  icon: typeof Code2;
  summary: string;
  defaultName: string;
  usernameSeed: string;
}> = [
  {
    id: 'codex',
    label: 'Codex',
    icon: Code2,
    summary: 'Repo-aware implementation and review jobs with a bounded prompt.',
    defaultName: 'Codex Agent',
    usernameSeed: 'codex-agent',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    icon: Terminal,
    summary: 'Deterministic terminal execution for scoped coding tasks.',
    defaultName: 'Claude Code Agent',
    usernameSeed: 'claude-code-agent',
  },
];

const LONG_RUNNING_ADAPTERS: Array<{
  id: LongRunningAdapter;
  label: string;
  icon: typeof Brain;
  summary: string;
}> = [
  {
    id: 'hermes',
    label: 'Hermes',
    icon: Brain,
    summary: 'Persistent coordinator with memory, routing, and task orchestration.',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    icon: Network,
    summary: 'Long-running autonomous role adapter for workspace operations.',
  },
];

const AGENT_TYPES: AgentTypeEnum[] = ['assistant', 'specialist', 'orchestrator', 'tool', 'bot'];

interface NewAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId?: string | null;
  onCreated: (result?: { conversationId?: string }) => void;
  isDark: boolean;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
}

function templateDescription(template: AgentRoleTemplate): string {
  if (template.id === 'custom') return 'Custom long-running role agent.';
  const caps = template.capabilities.length ? ` Capabilities: ${template.capabilities.join(', ')}.` : '';
  return `${template.label} role agent. ${template.pitch}${caps}`.slice(0, 500);
}

function cliDescription(adapter: CliAdapter): string {
  const option = CLI_ADAPTERS.find((a) => a.id === adapter);
  return `${option?.label ?? adapter} CLI code agent. Bounded, deterministic execution for scoped workspace tasks.`;
}

function buildLongRunningProfileConfig(input: {
  adapter: LongRunningAdapter;
  template?: AgentRoleTemplate;
  hermesProfileName: string;
  hermesPort: string;
  hermesApiKey: string;
  hermesAutoStart: boolean;
  openclawBaseUrl: string;
  model: string;
}): Record<string, unknown> {
  const base = input.template?.systemPrompt?.trim() ? { systemPrompt: input.template.systemPrompt.trim() } : {};
  if (input.adapter === 'hermes') {
    return {
      ...base,
      hermesProfileName: input.hermesProfileName.trim() || 'default',
      port: Number(input.hermesPort) || 8642,
      apiKey: input.hermesApiKey.trim(),
      autoStart: input.hermesAutoStart,
      startupTimeoutMs: 30_000,
      configurePrismerProvider: true,
      model: input.model || 'us-kimi-k2.6',
      prismerProviderName: 'prismer',
    };
  }
  return {
    ...base,
    baseUrl: input.openclawBaseUrl.trim() || 'http://127.0.0.1:3000',
    model: 'default',
  };
}

export function NewAgentDialog({ open, onOpenChange, workspaceId, onCreated, isDark, notify }: NewAgentDialogProps) {
  const [kind, setKind] = useState<AgentKind>('cli');
  const [cliAdapter, setCliAdapter] = useState<CliAdapter>('codex');
  const [longAdapter, setLongAdapter] = useState<LongRunningAdapter>('hermes');
  const [templateId, setTemplateId] = useState(ROLE_TEMPLATES[0]?.id ?? 'custom');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameDirty, setUsernameDirty] = useState(false);
  const [description, setDescription] = useState('');
  const [agentType, setAgentType] = useState<AgentTypeEnum>('tool');
  const [profileName, setProfileName] = useState('default');
  const [hermesProfileName, setHermesProfileName] = useState('default');
  const [hermesPort, setHermesPort] = useState('8642');
  const [hermesApiKey, setHermesApiKey] = useState('');
  const [hermesAutoStart, setHermesAutoStart] = useState(true);
  const [openclawBaseUrl, setOpenclawBaseUrl] = useState('http://127.0.0.1:3000');
  const [model, setModel] = useState('us-kimi-k2.6');
  const [localDaemon, setLocalDaemon] = useState<LocalDaemonHealthDTO | null>(null);
  const [localDaemonError, setLocalDaemonError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const theme = isDark ? 'dark' : 'light';
  const selectedTemplate = useMemo(
    () => ROLE_TEMPLATES.find((template) => template.id === templateId) ?? ROLE_TEMPLATES[0],
    [templateId],
  );
  const selectedCli = CLI_ADAPTERS.find((option) => option.id === cliAdapter) ?? CLI_ADAPTERS[0];
  const adapter: Adapter = kind === 'cli' ? cliAdapter : longAdapter;
  const preset = AGENT_KIND_PRESETS[kind];

  function applyCliDefaults(nextAdapter: CliAdapter) {
    const option = CLI_ADAPTERS.find((item) => item.id === nextAdapter) ?? CLI_ADAPTERS[0];
    setDisplayName(option.defaultName);
    setUsername(suggestUsername(option.usernameSeed));
    setDescription(cliDescription(nextAdapter));
    setAgentType('tool');
    setUsernameDirty(false);
  }

  function applyTemplateDefaults(template: AgentRoleTemplate) {
    setDisplayName(template.defaultDisplayName || template.label);
    setUsername(suggestUsername(template.defaultUsernameSeed || template.label));
    setDescription(templateDescription(template));
    setLongAdapter(template.defaultAdapter);
    setAgentType(template.id === 'custom' ? 'assistant' : 'orchestrator');
    setUsernameDirty(false);
  }

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setKind('cli');
      setCliAdapter('codex');
      setLongAdapter('hermes');
      setTemplateId(ROLE_TEMPLATES[0]?.id ?? 'custom');
      applyCliDefaults('codex');
      setProfileName('default');
      setHermesProfileName('default');
      setHermesPort('8642');
      setHermesApiKey('');
      setHermesAutoStart(true);
      setOpenclawBaseUrl('http://127.0.0.1:3000');
      setLocalDaemon(null);
      setLocalDaemonError(null);
      setError(null);
    });
  }, [open]);

  useEffect(() => {
    if (!open || kind !== 'long-running') return;
    let cancelled = false;

    async function probeLocalDaemon() {
      const res = await getLocalDaemonHealth();
      if (cancelled) return;
      if (res.ok) {
        setLocalDaemon(res.data);
        setLocalDaemonError(null);
      } else {
        setLocalDaemon(null);
        setLocalDaemonError(res.message);
      }
    }

    void probeLocalDaemon();
    const id = setInterval(() => {
      void probeLocalDaemon();
    }, 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, kind]);

  const usernameValid = !username || isValidAgentUsername(username);
  const hermesPortValid =
    Number.isInteger(Number(hermesPort)) && Number(hermesPort) >= 1 && Number(hermesPort) <= 65535;
  const localDaemonReady = !!localDaemon?.wsConnected;
  const localDaemonWorkspaceMismatch =
    kind === 'long-running' && !!workspaceId && !!localDaemon?.workspaceId && localDaemon.workspaceId !== workspaceId;
  const localDaemonBindable = localDaemonReady && !localDaemonWorkspaceMismatch;
  const canSubmit =
    !submitting &&
    displayName.trim() &&
    username.trim() &&
    usernameValid &&
    (kind !== 'long-running' || !!workspaceId) &&
    (kind !== 'long-running' || localDaemonBindable) &&
    (kind !== 'long-running' || longAdapter !== 'hermes' || hermesPortValid);

  const ids = {
    displayName: useId(),
    username: useId(),
    agentType: useId(),
    description: useId(),
    profileName: useId(),
    hermesProfileName: useId(),
    hermesPort: useId(),
    hermesApiKey: useId(),
    model: useId(),
    openclawBaseUrl: useId(),
  };

  const labelClass = cn('text-xs font-medium', isDark ? 'text-zinc-300' : 'text-zinc-700');
  const inputClass = cn(
    'w-full rounded-xl border px-3 py-2 text-sm outline-none transition focus:ring-2',
    isDark
      ? 'bg-zinc-950/50 border-white/[0.08] text-zinc-100 placeholder:text-zinc-500 focus:ring-violet-500/35'
      : 'bg-white/75 border-zinc-200 text-zinc-900 placeholder:text-zinc-400 focus:ring-violet-400/40',
  );

  async function handleSubmit() {
    setSubmitting(true);
    setError(null);

    const targetWorkspaceId = workspaceId ?? null;
    const targetDaemon = localDaemonBindable ? localDaemon : null;

    if (kind === 'long-running') {
      if (!targetWorkspaceId) {
        const msg = 'Create a workspace before configuring a long-running agent profile.';
        setError(msg);
        notify(msg, 'error');
        setSubmitting(false);
        return;
      }
      if (!targetDaemon) {
        const msg = localDaemonWorkspaceMismatch
          ? `Local daemon is connected to workspace ${localDaemon?.workspaceId}, not this workspace. Run setup for the current account or open the daemon's workspace.`
          : localDaemonError
            ? `Local daemon is not ready: ${localDaemonError}`
            : 'Local daemon is not connected to workspace IM yet.';
        setError(msg);
        notify(msg, 'error');
        setSubmitting(false);
        return;
      }
    }

    const res = await createAgent({
      displayName: displayName.trim(),
      username: username.trim(),
      agentType,
      workspaceId: targetWorkspaceId ?? undefined,
      adapter,
      daemonId: kind === 'long-running' ? targetDaemon?.daemonId : undefined,
      capabilities:
        kind === 'long-running' && selectedTemplate?.capabilities.length ? selectedTemplate.capabilities : undefined,
      description: description.trim() || undefined,
    });
    if (!res.ok) {
      setError(res.message);
      notify(`Couldn't create agent: ${res.message}`, 'error');
      setSubmitting(false);
      return;
    }

    if (kind === 'long-running') {
      const hermesServerKey = hermesApiKey.trim() || generateLocalSecret('hermes');
      const builtConfig = buildLongRunningProfileConfig({
        adapter: longAdapter,
        template: selectedTemplate,
        hermesProfileName,
        hermesPort,
        hermesApiKey: hermesServerKey,
        hermesAutoStart,
        openclawBaseUrl,
        model,
      });
      const profile = await createAgentProfile({
        workspaceId: targetWorkspaceId!,
        agentImUserId: res.data.imUserId,
        adapterName: longAdapter,
        name: profileName.trim() || 'default',
        config: builtConfig,
      });
      if (!profile.ok) {
        const msg = `Agent created, but profile setup failed: ${profile.message}`;
        setError(msg);
        notify(msg, 'error');
        setSubmitting(false);
        return;
      }

      const direct = await createDirectConversation(res.data.imUserId, targetWorkspaceId);
      if (!direct.ok) {
        const msg = `Agent created, but session creation failed: ${direct.message}`;
        setError(msg);
        notify(msg, 'error');
        setSubmitting(false);
        return;
      }

      setSubmitting(false);
      notify(
        `Agent ${res.data.username} is bound to ${targetDaemon!.daemonId.slice(0, 12)} and ready to chat.`,
        'success',
      );
      onCreated({ conversationId: direct.data.id });
      onOpenChange(false);
      return;
    }

    setSubmitting(false);
    notify(`Agent ${res.data.username} created.`, 'success');
    onCreated();
    onOpenChange(false);
  }

  const authorityItems =
    kind === 'long-running' && selectedTemplate
      ? selectedTemplate.authority
      : [
          'Runs one bounded task at a time',
          'Returns deterministic output to the assigning task',
          'No persistent memory or autonomous scheduling',
        ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn('max-h-[92vh] overflow-hidden border p-0 sm:max-w-[1180px]', s(theme, 'modal'), radius.pane)}
      >
        <div
          className={cn(
            'relative grid max-h-[92vh] min-h-[720px] overflow-hidden',
            isDark
              ? 'bg-[linear-gradient(180deg,rgba(24,24,27,0.92),rgba(9,9,11,0.88))]'
              : 'bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(244,244,245,0.86))]',
          )}
        >
          <DialogHeader className="relative z-10 gap-2 border-b px-5 py-4 sm:px-6">
            <div className="flex items-center gap-3 pr-8">
              <motion.div
                layout
                transition={springHeavy}
                className={cn(
                  'flex size-12 items-center justify-center rounded-3xl bg-gradient-to-br ring-1 shadow-[0_18px_50px_-24px_rgba(139,92,246,0.9)]',
                  preset.haloGradient,
                  preset.accentRing,
                )}
              >
                {kind === 'cli' ? <Terminal className="size-5" /> : <Brain className="size-5" />}
              </motion.div>
              <div className="min-w-0">
                <DialogTitle className="text-xl">New agent</DialogTitle>
                <DialogDescription className="mt-0.5">
                  Create a CLI executor or a persistent workspace role.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
              <div className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <PathCard
                    active={kind === 'cli'}
                    testId="new-agent-kind-cli"
                    title="CLI code agent"
                    description={AGENT_KIND_PRESETS.cli.description}
                    icon={Terminal}
                    isDark={isDark}
                    onClick={() => {
                      setKind('cli');
                      applyCliDefaults(cliAdapter);
                      setError(null);
                    }}
                  />
                  <PathCard
                    active={kind === 'long-running'}
                    testId="new-agent-kind-long-running"
                    title="Long-running role"
                    description={AGENT_KIND_PRESETS['long-running'].description}
                    icon={Brain}
                    isDark={isDark}
                    onClick={() => {
                      setKind('long-running');
                      if (selectedTemplate) applyTemplateDefaults(selectedTemplate);
                      setError(null);
                    }}
                  />
                </div>

                <AnimatePresence mode="wait">
                  {kind === 'cli' ? (
                    <motion.div
                      key="cli"
                      initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
                      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                      exit={{ opacity: 0, y: -10, filter: 'blur(6px)' }}
                      transition={springSoft}
                      className="grid gap-3"
                    >
                      <SectionTitle icon={Zap} title="Bounded execution adapter" />
                      <div className="grid gap-3 sm:grid-cols-2">
                        {CLI_ADAPTERS.map((option) => (
                          <AdapterCard
                            key={option.id}
                            active={cliAdapter === option.id}
                            testId={`new-agent-adapter-${option.id}`}
                            label={option.label}
                            summary={option.summary}
                            icon={option.icon}
                            isDark={isDark}
                            tone="cyan"
                            onClick={() => {
                              setCliAdapter(option.id);
                              applyCliDefaults(option.id);
                            }}
                          />
                        ))}
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="role"
                      initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
                      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                      exit={{ opacity: 0, y: -10, filter: 'blur(6px)' }}
                      transition={springSoft}
                      className="grid gap-4"
                    >
                      <div className="grid gap-3">
                        <SectionTitle icon={Sparkles} title="Role template" />
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                          {ROLE_TEMPLATES.map((template) => (
                            <TemplateCard
                              key={template.id}
                              template={template}
                              active={templateId === template.id}
                              testId={`new-agent-template-${template.id}`}
                              isDark={isDark}
                              onClick={() => {
                                setTemplateId(template.id);
                                applyTemplateDefaults(template);
                                setError(null);
                              }}
                            />
                          ))}
                        </div>
                      </div>

                      <div className="grid gap-3">
                        <SectionTitle icon={Cpu} title="Long-running adapter" />
                        <div className="grid gap-3 sm:grid-cols-2">
                          {LONG_RUNNING_ADAPTERS.map((option) => (
                            <AdapterCard
                              key={option.id}
                              active={longAdapter === option.id}
                              testId={`new-agent-adapter-${option.id}`}
                              label={option.label}
                              summary={option.summary}
                              icon={option.icon}
                              isDark={isDark}
                              tone="violet"
                              onClick={() => setLongAdapter(option.id)}
                            />
                          ))}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            <aside
              className={cn(
                'min-h-0 border-t p-5 lg:border-l lg:border-t-0',
                isDark ? 'border-white/[0.07] bg-zinc-950/28' : 'border-zinc-200/80 bg-white/42',
              )}
            >
              <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4">
                <motion.div
                  layout
                  transition={springHeavy}
                  className={cn('overflow-hidden border p-4', radius.pane, s(theme, 'card'))}
                >
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        'flex size-12 shrink-0 items-center justify-center rounded-3xl bg-gradient-to-br ring-1',
                        preset.haloGradient,
                        preset.accentRing,
                      )}
                    >
                      {kind === 'cli' ? <Terminal className="size-5" /> : <Brain className="size-5" />}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{displayName || 'Untitled agent'}</p>
                      <p className={cn('mt-0.5 text-xs', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                        {preset.label} · {adapter}
                      </p>
                    </div>
                  </div>
                  <p className={cn('mt-3 line-clamp-3 text-xs leading-5', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
                    {description || 'Choose a template or adapter to seed this agent.'}
                  </p>
                </motion.div>

                <div className="min-h-0 overflow-y-auto">
                  <div className={cn('grid gap-3 rounded-3xl border p-4', s(theme, 'card'))}>
                    <SectionTitle icon={Bot} title="Identity" />
                    <label className="grid gap-1.5" htmlFor={ids.displayName}>
                      <span className={labelClass}>Display name</span>
                      <input
                        id={ids.displayName}
                        data-testid="new-agent-display-name"
                        className={inputClass}
                        value={displayName}
                        onChange={(e) => {
                          const nextDisplayName = e.target.value;
                          setDisplayName(nextDisplayName);
                          if (!usernameDirty) setUsername(suggestUsername(nextDisplayName));
                        }}
                        placeholder={
                          kind === 'cli' ? selectedCli.defaultName : selectedTemplate?.defaultDisplayName || 'CEO'
                        }
                        autoFocus
                        maxLength={64}
                      />
                    </label>

                    <label className="grid gap-1.5" htmlFor={ids.username}>
                      <span className={labelClass}>Username</span>
                      <input
                        id={ids.username}
                        data-testid="new-agent-username"
                        className={inputClass}
                        value={username}
                        onChange={(e) => {
                          setUsername(e.target.value);
                          setUsernameDirty(true);
                        }}
                        placeholder="agent-001"
                        maxLength={32}
                      />
                      <span className={cn('text-[10px]', usernameValid ? 'text-zinc-500' : 'text-red-500')}>
                        3-32 chars, letters/digits/underscore/hyphen.
                      </span>
                    </label>

                    <label className="grid gap-1.5" htmlFor={ids.description}>
                      <span className={labelClass}>Description</span>
                      <textarea
                        id={ids.description}
                        data-testid="new-agent-description"
                        className={cn(inputClass, 'min-h-[96px] resize-y')}
                        value={description}
                        onChange={(e) => {
                          setDescription(e.target.value);
                        }}
                        placeholder="What does this agent do?"
                        maxLength={500}
                      />
                    </label>

                    <div className="grid gap-3 sm:grid-cols-[1fr_auto] lg:grid-cols-1">
                      <label className="grid gap-1.5" htmlFor={ids.agentType}>
                        <span className={labelClass}>Agent type</span>
                        <select
                          id={ids.agentType}
                          data-testid="new-agent-type"
                          className={inputClass}
                          value={agentType}
                          onChange={(e) => setAgentType(e.target.value as AgentTypeEnum)}
                        >
                          {AGENT_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {type}
                            </option>
                          ))}
                        </select>
                      </label>
                      <span
                        data-testid="new-agent-adapter"
                        className={cn(
                          'self-end rounded-full border px-2.5 py-1 text-[10px]',
                          kind === 'cli' ? AGENT_KIND_PRESETS.cli.chipBg : AGENT_KIND_PRESETS['long-running'].chipBg,
                        )}
                      >
                        adapter: {adapter}
                      </span>
                    </div>

                    {kind === 'long-running' ? (
                      <motion.div
                        layout
                        transition={springSoft}
                        className={cn(
                          'grid gap-3 rounded-2xl border p-3',
                          isDark ? 'border-white/[0.06] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50/80',
                        )}
                      >
                        <SectionTitle icon={Cpu} title="Runtime profile" />
                        <motion.div
                          layout
                          transition={springSoft}
                          className={cn(
                            'grid gap-1.5 rounded-2xl border px-3 py-2 text-xs',
                            localDaemonBindable
                              ? isDark
                                ? 'border-emerald-400/20 bg-emerald-400/8 text-emerald-200'
                                : 'border-emerald-200 bg-emerald-50 text-emerald-800'
                              : isDark
                                ? 'border-amber-400/20 bg-amber-400/8 text-amber-200'
                                : 'border-amber-200 bg-amber-50 text-amber-800',
                          )}
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-medium">Runtime target</span>
                            <span data-testid="new-agent-local-daemon-status">
                              {localDaemonWorkspaceMismatch
                                ? 'wrong workspace'
                                : localDaemonReady
                                  ? 'connected'
                                  : 'required'}
                            </span>
                          </div>
                          <p className="truncate font-mono text-[10px] opacity-80">
                            {localDaemon?.daemonId ??
                              localDaemonError ??
                              'Run prismer setup on this machine to start the local runtime'}
                          </p>
                          {localDaemonWorkspaceMismatch ? (
                            <p className="text-[10px] leading-4 opacity-80">
                              daemon workspace {localDaemon?.workspaceId}; current workspace {workspaceId}
                            </p>
                          ) : null}
                        </motion.div>
                        <label className="grid gap-1.5" htmlFor={ids.profileName}>
                          <span className={labelClass}>Profile name</span>
                          <input
                            id={ids.profileName}
                            data-testid="new-agent-profile-name"
                            className={inputClass}
                            value={profileName}
                            onChange={(event) => setProfileName(event.target.value)}
                            placeholder="default"
                            maxLength={48}
                          />
                        </label>

                        {longAdapter === 'hermes' ? (
                          <>
                            <label className="grid gap-1.5" htmlFor={ids.hermesProfileName}>
                              <span className={labelClass}>Hermes profile</span>
                              <input
                                id={ids.hermesProfileName}
                                data-testid="new-agent-hermes-profile"
                                className={inputClass}
                                value={hermesProfileName}
                                onChange={(event) => setHermesProfileName(event.target.value)}
                                placeholder="default"
                                maxLength={64}
                              />
                            </label>
                            <div className="grid gap-3 sm:grid-cols-[120px_minmax(0,1fr)] lg:grid-cols-1">
                              <label className="grid gap-1.5" htmlFor={ids.hermesPort}>
                                <span className={labelClass}>Port</span>
                                <input
                                  id={ids.hermesPort}
                                  data-testid="new-agent-hermes-port"
                                  className={inputClass}
                                  value={hermesPort}
                                  onChange={(event) => setHermesPort(event.target.value)}
                                  inputMode="numeric"
                                  placeholder="8642"
                                />
                              </label>
                              <label className="grid gap-1.5" htmlFor={ids.hermesApiKey}>
                                <span className={labelClass}>Hermes server key</span>
                                <input
                                  id={ids.hermesApiKey}
                                  data-testid="new-agent-hermes-api-key"
                                  className={inputClass}
                                  value={hermesApiKey}
                                  onChange={(event) => setHermesApiKey(event.target.value)}
                                  placeholder="Auto-generated if empty"
                                  type="password"
                                  autoComplete="off"
                                />
                              </label>
                            </div>
                            <label className="grid gap-1.5" htmlFor={ids.model}>
                              <span className={labelClass}>Model</span>
                              <ModelPicker value={model} onChange={setModel} />
                            </label>
                            <label
                              className={cn(
                                'flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs',
                                isDark ? 'border-white/[0.06] text-zinc-300' : 'border-zinc-200 text-zinc-700',
                              )}
                            >
                              <span>Auto-start Hermes gateway from daemon</span>
                              <input
                                type="checkbox"
                                checked={hermesAutoStart}
                                onChange={(event) => setHermesAutoStart(event.target.checked)}
                                className="h-4 w-4 accent-violet-500"
                              />
                            </label>
                            {!hermesPortValid ? (
                              <p className="text-[10px] text-red-500">Port must be between 1 and 65535.</p>
                            ) : null}
                          </>
                        ) : (
                          <label className="grid gap-1.5" htmlFor={ids.openclawBaseUrl}>
                            <span className={labelClass}>OpenClaw base URL</span>
                            <input
                              id={ids.openclawBaseUrl}
                              className={inputClass}
                              value={openclawBaseUrl}
                              onChange={(event) => setOpenclawBaseUrl(event.target.value)}
                              placeholder="http://127.0.0.1:3000"
                            />
                          </label>
                        )}

                        {!workspaceId ? (
                          <p className={cn('text-[10px]', isDark ? 'text-amber-300' : 'text-amber-700')}>
                            Workspace is still loading; profile creation will unlock once the default workspace is
                            ready.
                          </p>
                        ) : null}
                      </motion.div>
                    ) : null}

                    <div
                      className={cn(
                        'grid gap-2 rounded-2xl border p-3',
                        isDark ? 'border-white/[0.06] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50/80',
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <ShieldCheck className={cn('size-4', preset.accentText)} />
                        <span>Authority</span>
                      </div>
                      {authorityItems.map((item) => (
                        <div
                          key={item}
                          className={cn('flex gap-2 text-xs', isDark ? 'text-zinc-300' : 'text-zinc-600')}
                        >
                          <Check className={cn('mt-0.5 size-3.5 shrink-0', preset.accentText)} />
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>

                    {error ? (
                      <p className={cn('text-xs', isDark ? 'text-red-300' : 'text-red-600')} role="alert">
                        {error}
                      </p>
                    ) : null}
                  </div>
                </div>

                <DialogFooter className="gap-2 border-t border-white/[0.08] pt-4 sm:justify-between">
                  <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button onClick={handleSubmit} disabled={!canSubmit} data-testid="new-agent-submit">
                    {submitting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
                    Create agent
                  </Button>
                </DialogFooter>
              </div>
            </aside>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function generateLocalSecret(prefix: string): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function SectionTitle({ icon: Icon, title }: { icon: typeof Sparkles; title: string }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-zinc-500">
      <Icon className="size-3.5" />
      <span>{title}</span>
    </div>
  );
}

function PathCard({
  active,
  testId,
  title,
  description,
  icon: Icon,
  isDark,
  onClick,
}: {
  active: boolean;
  testId?: string;
  title: string;
  description: string;
  icon: typeof Terminal;
  isDark: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      layout
      type="button"
      data-testid={testId}
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.982 }}
      transition={springSnap}
      className={cn(
        'relative min-h-[132px] overflow-hidden rounded-3xl border p-4 text-left transition-[border-color,background-color,box-shadow]',
        isDark
          ? 'bg-white/[0.035] border-white/[0.07] hover:border-white/15 hover:bg-white/[0.055]'
          : 'bg-white/64 border-zinc-200 hover:bg-white/90',
        active &&
          (isDark
            ? 'border-violet-400/45 shadow-[0_24px_80px_-42px_rgba(139,92,246,0.95)]'
            : 'border-violet-300 shadow-[0_24px_70px_-48px_rgba(124,58,237,0.8)]'),
      )}
    >
      {active ? (
        <motion.span
          layoutId="new-agent-path-active"
          transition={springHeavy}
          className={cn(
            'absolute inset-0 -z-0 rounded-3xl',
            isDark
              ? 'bg-gradient-to-br from-violet-500/14 via-fuchsia-500/8 to-cyan-500/10'
              : 'bg-gradient-to-br from-violet-100/85 via-fuchsia-50/70 to-cyan-50/70',
          )}
        />
      ) : null}
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'relative flex size-11 shrink-0 items-center justify-center rounded-2xl',
            isDark ? 'bg-white/[0.06]' : 'bg-zinc-100',
          )}
        >
          <Icon className="size-5" />
        </div>
        <div className="relative min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span>{title}</span>
            {active ? <Check className="size-4 text-violet-400" /> : null}
          </div>
          <p className={cn('mt-1 text-xs leading-5', isDark ? 'text-zinc-400' : 'text-zinc-600')}>{description}</p>
        </div>
      </div>
    </motion.button>
  );
}

function AdapterCard({
  active,
  testId,
  label,
  summary,
  icon: Icon,
  isDark,
  tone = 'cyan',
  onClick,
}: {
  active: boolean;
  testId?: string;
  label: string;
  summary: string;
  icon: typeof Code2;
  isDark: boolean;
  tone?: 'cyan' | 'violet';
  onClick: () => void;
}) {
  const accent =
    tone === 'violet'
      ? {
          text: 'text-violet-400',
          dark: 'border-violet-400/45 bg-violet-500/10',
          light: 'border-violet-300 bg-violet-50',
        }
      : {
          text: 'text-cyan-400',
          dark: 'border-cyan-400/45 bg-cyan-500/10',
          light: 'border-cyan-300 bg-cyan-50',
        };
  return (
    <motion.button
      layout
      type="button"
      data-testid={testId}
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.982 }}
      transition={springSnap}
      className={cn(
        'relative overflow-hidden rounded-3xl border p-4 text-left transition-[border-color,background-color,box-shadow]',
        isDark
          ? 'bg-white/[0.03] border-white/[0.06] hover:border-white/15 hover:bg-white/[0.05]'
          : 'bg-white/62 border-zinc-200 hover:bg-white',
        active && (isDark ? accent.dark : accent.light),
      )}
    >
      {active ? (
        <motion.span
          layoutId={`new-agent-adapter-${tone}`}
          transition={springHeavy}
          className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-current to-transparent opacity-70"
        />
      ) : null}
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-2xl',
            isDark ? 'bg-white/[0.05]' : 'bg-zinc-100',
          )}
        >
          <Icon className={cn('size-4', accent.text)} />
        </span>
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <span>{label}</span>
            {active ? <Check className={cn('size-3.5', accent.text)} /> : null}
          </div>
          <p className={cn('mt-1 text-xs leading-5', isDark ? 'text-zinc-400' : 'text-zinc-600')}>{summary}</p>
        </div>
      </div>
    </motion.button>
  );
}

function TemplateCard({
  template,
  active,
  testId,
  isDark,
  onClick,
}: {
  template: AgentRoleTemplate;
  active: boolean;
  testId?: string;
  isDark: boolean;
  onClick: () => void;
}) {
  const Icon = template.icon;
  return (
    <motion.button
      layout
      type="button"
      data-testid={testId}
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.982 }}
      transition={springSnap}
      className={cn(
        'relative min-h-[150px] overflow-hidden rounded-3xl border p-3 text-left transition-[border-color,background-color,box-shadow]',
        isDark
          ? 'bg-white/[0.03] border-white/[0.06] hover:border-white/15 hover:bg-white/[0.05]'
          : 'bg-white/62 border-zinc-200 hover:bg-white',
        active &&
          (isDark
            ? 'border-violet-400/45 shadow-[0_22px_70px_-42px_rgba(139,92,246,0.95)]'
            : 'border-violet-300 shadow-[0_22px_60px_-44px_rgba(124,58,237,0.8)]'),
      )}
    >
      <div className={cn('absolute inset-x-0 top-0 h-[74px] bg-gradient-to-br opacity-80', template.gradient)} />
      {active ? (
        <motion.span
          layoutId="new-agent-template-active"
          transition={springHeavy}
          className="absolute inset-0 rounded-3xl ring-2 ring-violet-300/60"
        />
      ) : null}
      <div className="relative">
        <div className="flex items-center justify-between gap-2">
          <div
            className={cn(
              'flex size-10 items-center justify-center rounded-2xl ring-1',
              isDark ? 'bg-zinc-950/28 ring-white/10' : 'bg-white/50 ring-white/70',
            )}
          >
            <Icon className="size-4" />
          </div>
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] font-medium',
              isDark ? 'border-white/15 bg-black/10' : 'border-white/70 bg-white/50',
            )}
          >
            {template.roleBadge}
          </span>
        </div>
        <div className="mt-4 flex items-center gap-2 text-sm font-medium">
          <span>{template.label}</span>
          {active ? <Check className="size-3.5 text-violet-400" /> : null}
        </div>
        <p className={cn('mt-1 line-clamp-2 text-xs leading-5', isDark ? 'text-zinc-400' : 'text-zinc-600')}>
          {template.pitch}
        </p>
      </div>
    </motion.button>
  );
}
