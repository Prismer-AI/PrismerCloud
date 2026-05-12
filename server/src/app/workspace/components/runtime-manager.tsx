'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { GradientCard } from '@/components/playground/gradient-card';
import { useI18n } from '@/contexts/i18n-context';
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  EllipsisVertical,
  FileText,
  Loader2,
  Play,
  Plus,
  Trash2,
  Laptop,
  Server,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react';

import { avatarGradient, avatarInitials, radius, springSoft, surface } from '../lib/design';
import { getWorkspaceToken, imFetch } from '../lib/im-api';
import { createAgent, createShellTask, installAgentToRuntime } from '../lib/mutations';
import type {
  AgentDTO,
  RuntimeAgentDTO,
  RuntimeDaemonStatus,
  RuntimeDeviceDTO,
  RuntimeInstallationDTO,
  RuntimeKind,
  TaskDetailDTO,
  WorkspaceRuntimeDTO,
} from '../lib/types';
import { ProvisioningProgressStrip } from './provisioning-progress-strip';
import { SurfaceHeader } from './surface-header';
import { InlineAgentRename } from './agent-rename/InlineAgentRename';
import type { WorkspaceInspector } from './workspace-inspector-dialog';

interface RuntimeManagerProps {
  isDark: boolean;
  runtime: WorkspaceRuntimeDTO | null;
  installations: RuntimeInstallationDTO[];
  agents: AgentDTO[];
  onOpenInspector: (inspector: WorkspaceInspector) => void;
  onCreateRuntime: () => Promise<void> | void;
  onRuntimeChanged: () => Promise<void> | void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
  /**
   * §30 follow-up — relocated `+ Create` entry. Lives in this surface
   * because team creation is a device-scoped setup action (not a
   * high-frequency global). Header renders a compact `+` button; empty
   * state renders a centered primary CTA. Both call back to page.tsx's
   * `setUnifiedOpen(true)`.
   */
  onOpenCreation: () => void;
}

const ONLINE_WINDOW_MS = 90_000;

const deviceGradient = {
  local: { from: '#8b5cf6', to: '#22d3ee' },
  k8s: { from: '#06b6d4', to: '#3b82f6' },
  offline: { from: '#a1a1aa', to: '#71717a' },
};

export function RuntimeManager({
  isDark,
  runtime,
  installations,
  agents,
  onOpenInspector,
  onCreateRuntime,
  onRuntimeChanged,
  notify,
  onOpenCreation,
}: RuntimeManagerProps) {
  const { t } = useI18n();
  const [now, setNow] = useState(0);
  const [logTarget, setLogTarget] = useState<RuntimeInstallationDTO | null>(null);
  const [installTarget, setInstallTarget] = useState<RuntimeInstallationDTO | null>(null);
  const [deletingRuntimeId, setDeletingRuntimeId] = useState<string | null>(null);
  const [shellTarget, setShellTarget] = useState<RuntimeDeviceDTO | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const devices = useMemo(() => runtime?.devices ?? [], [runtime]);
  const registeredByUserId = useMemo(() => new Map(agents.map((agent) => [agent.userId, agent])), [agents]);
  const deviceSurfaces = useMemo(
    () => buildDeviceSurfaces(devices, installations, registeredByUserId),
    [devices, installations, registeredByUserId],
  );

  // §30 B3.7 — onCreateRuntime is retained on the prop shape so callers
  // (page.tsx) keep their existing wiring even though the header CTA was
  // removed. The DeviceWorkbench panel may re-bind it later; silence the
  // unused-var lint until then.
  void onCreateRuntime;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/*
        §30 B3.7 completion — all scattered creation entries (cloud
        runtime, k8s device, new-agent buttons) have been removed from
        this surface. Workspace now has exactly ONE creation entry: the
        TopBar `+ Create` button (unified-creation flow). `onCreateRuntime`
        is retained on the prop shape for future re-binding; see void
        below.
      */}
      <SurfaceHeader
        isDark={isDark}
        title={t('workspace.runtime.title')}
        subtitle={t('workspace.runtime.subtitle')}
        actions={
          <button
            type="button"
            onClick={onOpenCreation}
            data-testid="runtime-header-create"
            aria-label="创建新团队"
            title="创建新团队"
            className={`inline-flex h-8 w-8 items-center justify-center border transition-colors ${radius.button} ${
              isDark
                ? 'border-white/[0.08] bg-white/[0.04] text-zinc-200 hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-violet-200'
                : 'border-zinc-200 bg-white text-zinc-700 hover:border-violet-400 hover:bg-violet-50 hover:text-violet-700'
            }`}
          >
            <Plus className="h-4 w-4" />
          </button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <DeviceWorkbench
          isDark={isDark}
          surfaces={deviceSurfaces}
          selectedId={selectedDeviceId}
          now={now}
          onSelect={setSelectedDeviceId}
          onClose={() => setSelectedDeviceId(null)}
          onShell={(device) => setShellTarget(device)}
          onLogs={(installation) => setLogTarget(installation)}
          onInstall={(installation) => setInstallTarget(installation)}
          onOpenCreation={onOpenCreation}
          onOpenAgent={(agentId) => onOpenInspector({ kind: 'agent', agentId })}
          onDeleteAgent={async (agentId) => {
            if (!window.confirm('Delete this agent identity?')) return;
            const res = await imFetch(`/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
            if (!res.ok) {
              notify(`Agent delete failed: ${res.message}`, 'error');
              return;
            }
            await onRuntimeChanged();
            notify('Agent deleted.', 'success');
          }}
          onDeleteInstallation={async (installation) => {
            if (!window.confirm(`Delete runtime ${installation.runtimeInstanceId}?`)) return;
            setDeletingRuntimeId(installation.id);
            try {
              const token = getWorkspaceToken();
              if (!token) {
                notify('No auth token for runtime delete.', 'error');
                return;
              }
              const res = await fetch(`/api/sandboxes/${encodeURIComponent(installation.id)}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!res.ok) {
                const body = await res.text().catch(() => '');
                notify(`Runtime delete failed: ${body || res.status}`, 'error');
                return;
              }
              await onRuntimeChanged();
              notify('Runtime deleted.', 'success');
            } finally {
              setDeletingRuntimeId(null);
            }
          }}
          onForgetBinding={async (daemonId) => {
            if (!runtime?.workspaceId) {
              notify('No workspace selected for device unbind.', 'error');
              return;
            }
            if (!window.confirm(`Forget local daemon ${daemonId} from this workspace?`)) return;
            setDeletingRuntimeId(daemonId);
            try {
              const res = await imFetch(
                `/workspaces/${encodeURIComponent(runtime.workspaceId)}/runtime/bindings/${encodeURIComponent(daemonId)}/forget`,
                { method: 'POST' },
              );
              if (!res.ok) {
                notify(`Forget daemon failed: ${res.message}`, 'error');
                return;
              }
              await onRuntimeChanged();
              notify('Daemon forgotten from workspace.', 'success');
            } finally {
              setDeletingRuntimeId(null);
            }
          }}
          deletingRuntimeId={deletingRuntimeId}
          onRuntimeChanged={onRuntimeChanged}
          notify={notify}
        />
      </div>
      {logTarget ? (
        <RuntimeLogsPanel isDark={isDark} installation={logTarget} onClose={() => setLogTarget(null)} notify={notify} />
      ) : null}
      {installTarget ? (
        <InstallAgentPanel
          isDark={isDark}
          installation={installTarget}
          agents={agents}
          onClose={() => setInstallTarget(null)}
          onInstalled={async () => {
            await onRuntimeChanged();
            setInstallTarget(null);
          }}
          notify={notify}
        />
      ) : null}
      {shellTarget && runtime?.workspaceId ? (
        <ShellCommandPanel
          isDark={isDark}
          workspaceId={runtime.workspaceId}
          device={shellTarget}
          onClose={() => setShellTarget(null)}
          onCreated={async () => {
            await onRuntimeChanged();
            setShellTarget(null);
          }}
          notify={notify}
        />
      ) : null}
      {/*
        §30 B3.7 completion — K8sProvisionWizard render removed alongside
        its trigger buttons. The wizard form body is now re-implemented
        inside unified-creation/pro/ProTileDevice; this surface no longer
        owns the modal. Re-add by mounting from the unified entry if a
        non-Pro path is needed later.
      */}
    </section>
  );
}

interface DeviceSurface {
  id: string;
  name: string;
  kind: RuntimeKind;
  device: RuntimeDeviceDTO | null;
  installation: RuntimeInstallationDTO | null;
  agents: Array<{ runtimeAgent: RuntimeAgentDTO; registered: AgentDTO | null }>;
}

function buildDeviceSurfaces(
  devices: RuntimeDeviceDTO[],
  installations: RuntimeInstallationDTO[],
  registeredByUserId: Map<string, AgentDTO>,
): DeviceSurface[] {
  const matchedInstallations = new Set<string>();
  const surfaces = devices.map((device): DeviceSurface => {
    const installation =
      installations.find(
        (item) => item.daemonId === device.deviceId || device.deviceId.endsWith(item.runtimeInstanceId),
      ) ?? null;
    if (installation) matchedInstallations.add(installation.id);
    return {
      id: device.deviceId,
      name: device.name,
      kind: installation?.runtimeKind ?? (device.deviceId.startsWith('container:') ? 'k8s' : 'docker'),
      device,
      installation,
      agents: device.agents.map((agent) => ({
        runtimeAgent: agent,
        registered: registeredByUserId.get(agent.id) ?? null,
      })),
    };
  });

  for (const installation of installations) {
    if (matchedInstallations.has(installation.id)) continue;
    surfaces.push({
      id: installation.daemonId,
      name: installation.runtimeInstanceId,
      kind: installation.runtimeKind ?? 'k8s',
      device: null,
      installation,
      agents: [],
    });
  }

  return surfaces.sort((a, b) => Number(Boolean(b.device)) - Number(Boolean(a.device)) || a.name.localeCompare(b.name));
}

function DeviceWorkbench({
  isDark,
  surfaces,
  selectedId,
  now,
  onSelect,
  onClose,
  onShell,
  onLogs,
  onInstall,
  onOpenAgent,
  onOpenCreation,
  onDeleteAgent,
  onDeleteInstallation,
  onForgetBinding,
  deletingRuntimeId,
  onRuntimeChanged,
  notify,
}: {
  isDark: boolean;
  surfaces: DeviceSurface[];
  selectedId: string | null;
  now: number;
  onSelect: (id: string) => void;
  onClose: () => void;
  onShell: (device: RuntimeDeviceDTO) => void;
  onLogs: (installation: RuntimeInstallationDTO) => void;
  onInstall: (installation: RuntimeInstallationDTO) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenCreation: () => void;
  onDeleteAgent: (agentId: string) => Promise<void> | void;
  onDeleteInstallation: (installation: RuntimeInstallationDTO) => Promise<void> | void;
  onForgetBinding: (daemonId: string) => Promise<void> | void;
  deletingRuntimeId: string | null;
  onRuntimeChanged: () => Promise<void> | void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const selectedSurface = surfaces.find((surfaceItem) => surfaceItem.id === selectedId) ?? null;

  if (surfaces.length === 0) {
    return (
      <div
        data-testid="device-workbench"
        className={`flex min-h-[440px] items-center justify-center border p-8 ${radius.pane} ${surface.pane[isDark ? 'dark' : 'light']}`}
      >
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <div
            aria-hidden
            className={`flex h-16 w-16 items-center justify-center rounded-2xl ${
              isDark ? 'bg-violet-500/15 text-violet-300' : 'bg-violet-100 text-violet-600'
            }`}
          >
            <Bot className="h-8 w-8" />
          </div>
          <h3 className={`text-xl font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>还没有 AI 团队</h3>
          <p className={`text-sm leading-6 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            点这里创建你的第一个 AI 团队 — 选行业 + 规模, 30 秒上岗。
          </p>
          <button
            type="button"
            onClick={onOpenCreation}
            data-testid="device-empty-create-cta"
            className={`mt-2 inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_18px_42px_-22px_rgba(139,92,246,0.85)] transition-colors ${radius.button} ${
              isDark ? 'bg-violet-500 hover:bg-violet-400' : 'bg-violet-600 hover:bg-violet-500'
            }`}
          >
            <Plus className="h-4 w-4" />
            创建团队
          </button>
        </div>
      </div>
    );
  }

  return (
    <section data-testid="device-workbench" className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
        {surfaces.map((surfaceItem, index) => (
          <DeviceSurfaceCard
            key={surfaceItem.id}
            isDark={isDark}
            surfaceItem={surfaceItem}
            now={now}
            index={index}
            onOpen={() => onSelect(surfaceItem.id)}
            onShell={onShell}
            onLogs={onLogs}
            onInstall={onInstall}
            onOpenAgent={onOpenAgent}
            onDeleteAgent={onDeleteAgent}
            onDeleteInstallation={onDeleteInstallation}
            onForgetBinding={onForgetBinding}
            deletingRuntimeId={deletingRuntimeId}
            onRuntimeChanged={onRuntimeChanged}
            notify={notify}
          />
        ))}
      </div>

      {selectedSurface ? (
        <DeviceDetailsDialog
          isDark={isDark}
          surfaceItem={selectedSurface}
          now={now}
          onClose={onClose}
          onShell={onShell}
          onLogs={onLogs}
          onInstall={onInstall}
          onOpenAgent={onOpenAgent}
          onDeleteAgent={onDeleteAgent}
          onDeleteInstallation={onDeleteInstallation}
          onForgetBinding={onForgetBinding}
          deletingRuntimeId={deletingRuntimeId}
          onRuntimeChanged={onRuntimeChanged}
          notify={notify}
        />
      ) : null}
    </section>
  );
}

function DeviceSurfaceCard({
  isDark,
  surfaceItem,
  now,
  index,
  onOpen,
  onShell,
  onLogs,
  onInstall,
  onOpenAgent,
  onDeleteAgent,
  onDeleteInstallation,
  onForgetBinding,
  deletingRuntimeId,
  onRuntimeChanged,
  notify,
}: {
  isDark: boolean;
  surfaceItem: DeviceSurface;
  now: number;
  index: number;
  onOpen: () => void;
  onShell: (device: RuntimeDeviceDTO) => void;
  onLogs: (installation: RuntimeInstallationDTO) => void;
  onInstall: (installation: RuntimeInstallationDTO) => void;
  onOpenAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => Promise<void> | void;
  onDeleteInstallation: (installation: RuntimeInstallationDTO) => Promise<void> | void;
  onForgetBinding: (daemonId: string) => Promise<void> | void;
  deletingRuntimeId: string | null;
  onRuntimeChanged: () => Promise<void> | void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const device = surfaceItem.device;
  const installation = surfaceItem.installation;
  const online = device ? isDeviceOnline(device, now) : false;
  const daemonStatus = device?.daemonStatus ?? (online ? 'connected' : device?.lastSeenAt ? 'stale' : 'offline');
  const [menuOpen, setMenuOpen] = useState(false);
  const gradient =
    surfaceItem.kind === 'k8s' ? deviceGradient.k8s : online ? deviceGradient.local : deviceGradient.offline;
  const DeviceIcon = surfaceItem.kind === 'k8s' ? Server : Laptop;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...springSoft, delay: index * 0.025 }}
    >
      <GradientCard
        gradientFrom={gradient.from}
        gradientTo={gradient.to}
        isDark={isDark}
        disabled={!online}
        className="h-full"
      >
        <article
          data-testid={`device-card-${surfaceItem.id}`}
          onClick={() => {
            setMenuOpen(false);
            onOpen();
          }}
          className={`relative z-20 flex h-[308px] cursor-pointer flex-col overflow-visible rounded-3xl border p-4 backdrop-blur-xl transition-all duration-300 ${
            isDark
              ? 'border-white/[0.08] bg-zinc-950/72 text-zinc-100 shadow-[0_24px_80px_-45px_rgba(0,0,0,0.9)] hover:border-white/[0.14]'
              : 'border-white/80 bg-white/82 text-zinc-900 shadow-[0_24px_80px_-50px_rgba(15,23,42,0.35)] hover:border-white'
          }`}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
              onOpen();
            }}
            className="flex w-full min-w-0 items-start gap-3 text-left"
          >
            <span
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ring-1 ${
                isDark ? 'bg-white/[0.06] ring-white/[0.08]' : 'bg-white/75 ring-zinc-200/70'
              }`}
              style={{ color: gradient.from }}
            >
              <DeviceIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1 pr-10">
              <span className={`block truncate text-[15px] font-bold ${isDark ? 'text-zinc-50' : 'text-zinc-950'}`}>
                {surfaceItem.name}
              </span>
              <span
                className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] ${
                  isDark ? 'text-zinc-400' : 'text-zinc-500'
                }`}
              >
                <StatusDot tone={online ? 'green' : 'zinc'} />
                <span>{surfaceItem.kind === 'k8s' ? 'k8s' : 'local'}</span>
                <span>daemon {daemonStatus}</span>
                <span>{surfaceItem.agents.length} agents</span>
              </span>
            </span>
          </button>

          <div className="absolute right-4 top-4 z-50">
            <button
              type="button"
              data-testid={`device-card-menu-${surfaceItem.id}`}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((value) => !value);
              }}
              className={`flex h-8 w-8 items-center justify-center rounded-2xl border shadow-sm ${
                isDark
                  ? 'border-white/[0.08] bg-zinc-950/90 text-zinc-300 hover:bg-zinc-900'
                  : 'border-zinc-200 bg-white/90 text-zinc-600 hover:bg-white'
              }`}
            >
              <EllipsisVertical className="h-4 w-4" />
            </button>
            {menuOpen ? (
              <DeviceActionMenu
                isDark={isDark}
                device={device}
                installation={installation}
                deleting={
                  installation
                    ? deletingRuntimeId === installation.id
                    : device
                      ? deletingRuntimeId === device.deviceId
                      : false
                }
                onClose={() => setMenuOpen(false)}
                onDetails={onOpen}
                onShell={onShell}
                onLogs={onLogs}
                onInstall={onInstall}
                onDeleteInstallation={onDeleteInstallation}
                onForgetBinding={onForgetBinding}
                onRuntimeChanged={onRuntimeChanged}
                notify={notify}
              />
            ) : null}
          </div>

          {/* Migration 322 — provisioning progress strip, only renders while
              the underlying im_containers row is mid-provisioning. */}
          {installation && installation.provisioning?.step ? (
            <ProvisioningProgressStrip
              installationId={installation.id}
              isDark={isDark}
              initialProgress={{
                step: installation.provisioning.step,
                history: installation.provisioning.history,
                status: installation.status,
              }}
            />
          ) : null}

          <div className="mt-auto pt-4">
            {surfaceItem.agents.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {surfaceItem.agents.slice(0, 3).map((item) => (
                  <DeviceAgentCard
                    key={item.runtimeAgent.id}
                    isDark={isDark}
                    runtimeAgent={item.runtimeAgent}
                    registered={item.registered}
                    expanded={false}
                    onOpen={() => onOpenAgent(item.runtimeAgent.id)}
                    onDelete={() => void onDeleteAgent(item.runtimeAgent.id)}
                    onRenamed={() => void onRuntimeChanged()}
                  />
                ))}
                {surfaceItem.agents.length > 3 ? (
                  <span
                    className={`inline-flex h-9 items-center rounded-2xl border px-3 text-[11px] ${
                      isDark
                        ? 'border-white/[0.08] bg-white/[0.03] text-zinc-400'
                        : 'border-zinc-200 bg-white/70 text-zinc-500'
                    }`}
                  >
                    +{surfaceItem.agents.length - 3} more
                  </span>
                ) : null}
              </div>
            ) : (
              <div
                className={`rounded-2xl border border-dashed px-3 py-3 text-xs ${
                  isDark ? 'border-white/[0.08] text-zinc-500' : 'border-zinc-200 text-zinc-500'
                }`}
              >
                No agents declared
              </div>
            )}
          </div>
        </article>
      </GradientCard>
    </motion.div>
  );
}

function DeviceDetailsDialog({
  isDark,
  surfaceItem,
  now,
  onClose,
  onShell,
  onLogs,
  onInstall,
  onOpenAgent,
  onDeleteAgent,
  onDeleteInstallation,
  onForgetBinding,
  deletingRuntimeId,
  onRuntimeChanged,
  notify,
}: {
  isDark: boolean;
  surfaceItem: DeviceSurface;
  now: number;
  onClose: () => void;
  onShell: (device: RuntimeDeviceDTO) => void;
  onLogs: (installation: RuntimeInstallationDTO) => void;
  onInstall: (installation: RuntimeInstallationDTO) => void;
  onOpenAgent: (agentId: string) => void;
  onDeleteAgent: (agentId: string) => Promise<void> | void;
  onDeleteInstallation: (installation: RuntimeInstallationDTO) => Promise<void> | void;
  onForgetBinding: (daemonId: string) => Promise<void> | void;
  deletingRuntimeId: string | null;
  onRuntimeChanged: () => Promise<void> | void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const device = surfaceItem.device;
  const online = device ? isDeviceOnline(device, now) : false;
  const DeviceIcon = surfaceItem.kind === 'k8s' ? Server : Laptop;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <motion.aside
        data-testid="device-details-dialog"
        initial={{ opacity: 0, y: 16, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={springSoft}
        className={`flex max-h-[88vh] w-[min(980px,94vw)] flex-col overflow-hidden border ${radius.pane} ${surface.pane[isDark ? 'dark' : 'light']}`}
      >
        <header
          className={`flex shrink-0 items-start gap-3 border-b px-5 py-4 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <span
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${
              surfaceItem.kind === 'k8s'
                ? isDark
                  ? 'bg-cyan-500/12 text-cyan-200'
                  : 'bg-cyan-50 text-cyan-700'
                : isDark
                  ? 'bg-violet-500/12 text-violet-200'
                  : 'bg-violet-50 text-violet-700'
            }`}
          >
            <DeviceIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className={`truncate text-base font-bold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
                {surfaceItem.name}
              </h3>
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${online ? phaseClass('online', isDark) : phaseClass('stopped', isDark)}`}
              >
                {online ? 'online' : 'offline'}
              </span>
              <RuntimeKindBadge isDark={isDark} kind={surfaceItem.kind} />
            </div>
            <p className={`mt-1 truncate text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {surfaceItem.id} · {surfaceItem.agents.length} hosted agents
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close device details"
            className={`flex h-9 w-9 items-center justify-center rounded-2xl border ${isDark ? 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.05]' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'}`}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="grid gap-3">
              <DeviceRuntimeSummary
                isDark={isDark}
                device={surfaceItem.device}
                installation={surfaceItem.installation}
                now={now}
                onLogs={onLogs}
                onInstall={onInstall}
                onDeleteInstallation={onDeleteInstallation}
                onForgetBinding={onForgetBinding}
                deleting={
                  surfaceItem.installation
                    ? deletingRuntimeId === surfaceItem.installation.id
                    : surfaceItem.device
                      ? deletingRuntimeId === surfaceItem.device.deviceId
                      : false
                }
                onRuntimeChanged={onRuntimeChanged}
                notify={notify}
              />
              <DeviceCliPreview
                isDark={isDark}
                device={surfaceItem.device}
                installation={surfaceItem.installation}
                onShell={onShell}
              />
            </div>

            <div className="min-w-0">
              <div className="mb-2 flex items-center justify-between">
                <p
                  className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}
                >
                  Agents
                </p>
                {surfaceItem.installation ? (
                  <RuntimeActionButton
                    isDark={isDark}
                    onClick={() => onInstall(surfaceItem.installation!)}
                    icon={<Plus className="h-3.5 w-3.5" />}
                    label="Attach agent"
                  />
                ) : null}
              </div>
              <div className="grid gap-2">
                {surfaceItem.agents.length === 0 ? (
                  <div
                    className={`rounded-2xl border border-dashed px-3 py-6 text-center text-xs ${isDark ? 'border-white/[0.08] text-zinc-500' : 'border-zinc-200 text-zinc-500'}`}
                  >
                    No agents declared on this device.
                  </div>
                ) : (
                  surfaceItem.agents.map((item) => (
                    <DeviceAgentCard
                      key={item.runtimeAgent.id}
                      isDark={isDark}
                      runtimeAgent={item.runtimeAgent}
                      registered={item.registered}
                      expanded
                      onOpen={() => onOpenAgent(item.runtimeAgent.id)}
                      onDelete={() => void onDeleteAgent(item.runtimeAgent.id)}
                      onRenamed={() => void onRuntimeChanged()}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </motion.aside>
    </div>
  );
}

function DeviceActionMenu({
  isDark,
  device,
  installation,
  deleting,
  onClose,
  onDetails,
  onShell,
  onLogs,
  onInstall,
  onDeleteInstallation,
  onForgetBinding,
  onRuntimeChanged,
  notify,
}: {
  isDark: boolean;
  device: RuntimeDeviceDTO | null;
  installation: RuntimeInstallationDTO | null;
  deleting: boolean;
  onClose: () => void;
  onDetails: () => void;
  onShell: (device: RuntimeDeviceDTO) => void;
  onLogs: (installation: RuntimeInstallationDTO) => void;
  onInstall: (installation: RuntimeInstallationDTO) => void;
  onDeleteInstallation: (installation: RuntimeInstallationDTO) => Promise<void> | void;
  onForgetBinding: (daemonId: string) => Promise<void> | void;
  onRuntimeChanged: () => Promise<void> | void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [busyAction, setBusyAction] = useState<'start' | 'stop' | null>(null);

  async function runtimeAction(kind: 'start' | 'stop') {
    if (!installation) return;
    const path = kind === 'start' ? installation.observability.startPath : installation.observability.stopPath;
    const token = getWorkspaceToken();
    if (!token) {
      notify('No auth token for device runtime action.', 'error');
      return;
    }
    setBusyAction(kind);
    try {
      const res = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        notify(`Device runtime ${kind} failed: ${body || res.status}`, 'error');
        return;
      }
      await onRuntimeChanged();
      notify(`Device runtime ${kind} requested.`, 'success');
      onClose();
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div
      data-testid="device-action-menu"
      className={`absolute right-0 top-10 z-[70] w-48 overflow-hidden rounded-2xl border p-1 shadow-[0_24px_80px_-20px_rgba(0,0,0,0.45)] ${
        isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'
      }`}
      onClick={(event) => event.stopPropagation()}
    >
      <DeviceMenuItem
        isDark={isDark}
        testid={`device-action-details-${device?.deviceId ?? installation?.id ?? 'unknown'}`}
        icon={<FileText className="h-3.5 w-3.5" />}
        label="Details"
        onClick={() => {
          onClose();
          onDetails();
        }}
      />
      <DeviceMenuItem
        isDark={isDark}
        testid={`device-action-terminal-${device?.deviceId ?? installation?.id ?? 'unknown'}`}
        icon={<TerminalSquare className="h-3.5 w-3.5" />}
        label="Open terminal"
        disabled={!device}
        onClick={() => {
          if (!device) return;
          onClose();
          onShell(device);
        }}
      />
      {installation ? (
        <>
          <DeviceMenuItem
            isDark={isDark}
            testid={`device-action-logs-${installation.id}`}
            icon={<FileText className="h-3.5 w-3.5" />}
            label="Logs"
            onClick={() => {
              onClose();
              onLogs(installation);
            }}
          />
          <DeviceMenuItem
            isDark={isDark}
            testid={`device-action-attach-${installation.id}`}
            icon={<Bot className="h-3.5 w-3.5" />}
            label="Attach agent"
            onClick={() => {
              onClose();
              onInstall(installation);
            }}
          />
          <div className={`my-1 h-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`} />
          <DeviceMenuItem
            isDark={isDark}
            testid={`device-action-start-${installation.id}`}
            icon={
              busyAction === 'start' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )
            }
            label={busyAction === 'start' ? 'Starting' : 'Start runtime'}
            disabled={busyAction !== null}
            onClick={() => void runtimeAction('start')}
          />
          <DeviceMenuItem
            isDark={isDark}
            testid={`device-action-stop-${installation.id}`}
            icon={
              busyAction === 'stop' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )
            }
            label={busyAction === 'stop' ? 'Stopping' : 'Stop runtime'}
            disabled={busyAction !== null}
            onClick={() => void runtimeAction('stop')}
          />
          <DeviceMenuItem
            isDark={isDark}
            danger
            testid={`device-action-delete-${installation.id}`}
            icon={deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            label={deleting ? 'Deleting' : 'Delete runtime'}
            disabled={deleting}
            onClick={() => {
              onClose();
              void onDeleteInstallation(installation);
            }}
          />
        </>
      ) : device && device.deviceId !== '__unbound__' ? (
        <>
          <div className={`my-1 h-px ${isDark ? 'bg-white/[0.06]' : 'bg-zinc-200'}`} />
          <DeviceMenuItem
            isDark={isDark}
            danger
            testid={`device-action-forget-${device.deviceId}`}
            icon={deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            label={deleting ? 'Forgetting' : 'Forget from workspace'}
            disabled={deleting}
            onClick={() => {
              onClose();
              void onForgetBinding(device.deviceId);
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function DeviceMenuItem({
  isDark,
  icon,
  label,
  onClick,
  testid,
  disabled = false,
  danger = false,
}: {
  isDark: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  testid?: string;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      disabled={disabled}
      className={`flex h-9 w-full items-center gap-2 rounded-xl px-2.5 text-left text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? isDark
            ? 'text-red-200 hover:bg-red-400/10'
            : 'text-red-600 hover:bg-red-50'
          : isDark
            ? 'text-zinc-300 hover:bg-white/[0.05]'
            : 'text-zinc-700 hover:bg-zinc-50'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function DeviceRuntimeSummary({
  isDark,
  device,
  installation,
  now,
  onLogs,
  onInstall,
  onDeleteInstallation,
  onForgetBinding,
  deleting,
  onRuntimeChanged,
  notify,
}: {
  isDark: boolean;
  device: RuntimeDeviceDTO | null;
  installation: RuntimeInstallationDTO | null;
  now: number;
  onLogs: (installation: RuntimeInstallationDTO) => void;
  onInstall: (installation: RuntimeInstallationDTO) => void;
  onDeleteInstallation: (installation: RuntimeInstallationDTO) => Promise<void> | void;
  onForgetBinding: (daemonId: string) => Promise<void> | void;
  deleting: boolean;
  onRuntimeChanged: () => Promise<void> | void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [busyAction, setBusyAction] = useState<'start' | 'stop' | null>(null);
  const online = device ? isDeviceOnline(device, now) : false;
  const daemonStatus: RuntimeDaemonStatus =
    device?.daemonStatus ?? (online ? 'connected' : device?.lastSeenAt ? 'stale' : 'offline');
  const containerStatus = installation?.containerStatus ?? 'unknown';

  async function runtimeAction(kind: 'start' | 'stop') {
    if (!installation) return;
    const path = kind === 'start' ? installation.observability.startPath : installation.observability.stopPath;
    const token = getWorkspaceToken();
    if (!token) {
      notify('No auth token for device runtime action.', 'error');
      return;
    }
    setBusyAction(kind);
    try {
      const res = await fetch(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        notify(`Device runtime ${kind} failed: ${body || res.status}`, 'error');
        return;
      }
      await onRuntimeChanged();
      notify(`Device runtime ${kind} requested.`, 'success');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div
      className={`rounded-2xl border p-3 ${isDark ? 'border-white/[0.07] bg-white/[0.025]' : 'border-zinc-200 bg-white/70'}`}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <RuntimeStat isDark={isDark} label="Daemon" value={daemonStatus} />
        <RuntimeStat isDark={isDark} label="Runtime" value={installation ? containerStatus : 'local'} />
        <RuntimeStat
          isDark={isDark}
          label="Heartbeat"
          value={device ? formatRelative(device.lastSeenAt, now) : 'not declared'}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {installation ? (
          <>
            <RuntimeActionButton
              isDark={isDark}
              onClick={() => onLogs(installation)}
              icon={<FileText className="h-3.5 w-3.5" />}
              label="Logs"
            />
            <RuntimeActionButton
              isDark={isDark}
              onClick={() => onInstall(installation)}
              icon={<Bot className="h-3.5 w-3.5" />}
              label="Attach agent"
            />
            <RuntimeActionButton
              isDark={isDark}
              onClick={() => void runtimeAction('start')}
              icon={
                busyAction === 'start' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )
              }
              label={busyAction === 'start' ? 'Starting' : 'Start'}
            />
            <RuntimeActionButton
              isDark={isDark}
              onClick={() => void runtimeAction('stop')}
              icon={
                busyAction === 'stop' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Square className="h-3.5 w-3.5" />
                )
              }
              label={busyAction === 'stop' ? 'Stopping' : 'Stop'}
            />
            <RuntimeActionButton
              isDark={isDark}
              onClick={() => void onDeleteInstallation(installation)}
              icon={deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              label={deleting ? 'Deleting' : 'Delete runtime'}
            />
          </>
        ) : device && device.deviceId !== '__unbound__' ? (
          <RuntimeActionButton
            isDark={isDark}
            onClick={() => void onForgetBinding(device.deviceId)}
            icon={deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            label={deleting ? 'Forgetting' : 'Forget from workspace'}
          />
        ) : (
          <span className={`text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            This synthetic group has no daemon binding.
          </span>
        )}
      </div>
    </div>
  );
}

function DeviceCliPreview({
  isDark,
  device,
  installation,
  onShell,
}: {
  isDark: boolean;
  device: RuntimeDeviceDTO | null;
  installation: RuntimeInstallationDTO | null;
  onShell: (device: RuntimeDeviceDTO) => void;
}) {
  const setupCommand =
    'node sdk/prismer-cloud/runtime/dist/cli.js setup --cloud http://localhost:3000 --token <jwt> --device-name local-mac';
  const daemonCommand = 'node sdk/prismer-cloud/runtime/dist/cli.js status';
  return (
    <div
      className={`overflow-hidden rounded-2xl border ${isDark ? 'border-white/[0.08] bg-zinc-950/80' : 'border-zinc-200 bg-zinc-950 text-zinc-100'}`}
    >
      <div
        className={`flex items-center justify-between border-b px-3 py-2 ${isDark ? 'border-white/[0.06]' : 'border-white/10'}`}
      >
        <div className="flex items-center gap-2 text-[11px] font-semibold">
          <TerminalSquare className="h-3.5 w-3.5 text-emerald-400" />
          CLI
        </div>
        <button
          type="button"
          onClick={() => {
            if (device) onShell(device);
          }}
          disabled={!device}
          className="h-7 rounded-xl border border-white/10 px-2 text-[10px] font-semibold text-zinc-200 disabled:opacity-40"
        >
          Open terminal
        </button>
      </div>
      <pre className="max-h-28 overflow-auto px-3 py-2 text-[11px] leading-5 text-zinc-300">
        {installation
          ? `# ${installation.runtimeInstanceId}\n${installation.observability.logsPath}\n${installation.observability.startPath}`
          : `${setupCommand}\n${daemonCommand}`}
      </pre>
    </div>
  );
}

function DeviceAgentCard({
  isDark,
  runtimeAgent,
  registered,
  expanded,
  onOpen,
  onDelete,
  onRenamed,
}: {
  isDark: boolean;
  runtimeAgent: RuntimeAgentDTO;
  registered: AgentDTO | null;
  expanded: boolean;
  onOpen: () => void;
  onDelete: () => void;
  /**
   * §30 B3.8 Q2 — fired after a successful slug rename so the parent can
   * patch its local `agents` cache without waiting for the WS event.
   */
  onRenamed?: (agentImUserId: string, newSlug: string) => void;
}) {
  const label = registered?.name ?? runtimeAgent.name;
  const slug = registered?.username ?? null;
  const statusTone =
    runtimeAgent.status === 'busy'
      ? 'amber'
      : runtimeAgent.status === 'online' || runtimeAgent.status === 'idle'
        ? 'green'
        : 'zinc';
  // The rename pencil sits as a SIBLING of the motion.button so its inner
  // <button> elements don't get nested inside the card's <button> (invalid
  // HTML). Hover state is shared via the `group/agent` Tailwind class on the
  // outer wrapper.
  return (
    <span className={`group/agent relative inline-flex ${expanded ? 'w-full' : 'max-w-full'}`}>
      <motion.button
        type="button"
        data-testid={`device-agent-${runtimeAgent.id}`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        whileHover={{ y: -1, scale: 1.01 }}
        whileTap={{ scale: 0.99 }}
        transition={springSoft}
        className={`min-w-0 text-left transition-colors ${
          expanded
            ? `flex w-full items-center gap-3 rounded-2xl border px-3 py-2 ${
                isDark
                  ? 'border-white/[0.07] bg-white/[0.025] hover:bg-white/[0.05]'
                  : 'border-zinc-200 bg-white/70 hover:bg-white'
              }`
            : `inline-flex h-9 max-w-full items-center gap-2 rounded-2xl border px-2.5 ${
                isDark
                  ? 'border-white/[0.08] bg-white/[0.035] hover:bg-white/[0.06]'
                  : 'border-white/80 bg-white/70 hover:bg-white'
              }`
        }`}
      >
        <RuntimeAgentAvatar seed={runtimeAgent.id} label={label} />
        <span className="min-w-0 flex-1">
          <span className={`block truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            {label}
          </span>
          {expanded ? (
            <span className={`block truncate text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {slug ? <span className="font-mono">@{slug} · </span> : null}
              {runtimeAgent.status} · {runtimeAgent.version ?? 'unknown version'}
              {runtimeAgent.currentTaskId ? ` · ${runtimeAgent.currentTaskId}` : ''}
            </span>
          ) : null}
        </span>
        <StatusDot tone={statusTone} />
        <span className={`ml-auto flex shrink-0 items-center gap-1 ${expanded ? '' : 'hidden group-hover/agent:flex'}`}>
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onOpen();
              }
            }}
            className={`inline-flex h-7 items-center rounded-xl px-2 text-[10px] font-semibold ${
              isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-600 hover:bg-zinc-100'
            }`}
          >
            Details
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                onDelete();
              }
            }}
            className={`inline-flex h-7 items-center rounded-xl px-2 text-[10px] font-semibold ${
              isDark ? 'text-red-200 hover:bg-red-400/10' : 'text-red-600 hover:bg-red-50'
            }`}
          >
            Delete
          </span>
        </span>
      </motion.button>
      {/* §30 B3.8 Q2 — rename pencil overlay (top-right). Sibling of the
          motion.button so its internal <button>s don't nest. Only renders
          when we have a registered slug to rewrite. */}
      {slug && registered ? (
        <span
          className="absolute right-1 top-1 z-10 opacity-0 transition-opacity group-hover/agent:opacity-100 focus-within:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <InlineAgentRename
            agentImUserId={registered.userId}
            currentSlug={slug}
            isDark={isDark}
            size="sm"
            onRenamed={(newSlug) => onRenamed?.(registered.userId, newSlug)}
          />
        </span>
      ) : null}
    </span>
  );
}

function StatusDot({ tone }: { tone: 'green' | 'amber' | 'red' | 'zinc' | 'cyan' }) {
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass(tone)}`} />;
}

function dotClass(tone: 'green' | 'cyan' | 'amber' | 'red' | 'zinc'): string {
  switch (tone) {
    case 'green':
      return 'bg-emerald-500';
    case 'cyan':
      return 'bg-cyan-500';
    case 'amber':
      return 'bg-amber-500';
    case 'red':
      return 'bg-red-500';
    case 'zinc':
    default:
      return 'bg-zinc-500';
  }
}

function RuntimeLogsPanel({
  isDark,
  installation,
  onClose,
  notify,
}: {
  isDark: boolean;
  installation: RuntimeInstallationDTO;
  onClose: () => void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<'connecting' | 'streaming' | 'closed' | 'error'>(() =>
    getWorkspaceToken() ? 'connecting' : 'error',
  );

  useEffect(() => {
    const token = getWorkspaceToken();
    if (!token) {
      notify('No auth token for device runtime logs.', 'error');
      return;
    }
    const ctrl = new AbortController();

    async function streamLogs() {
      try {
        const res = await fetch(installation.observability.logsPath, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          setStatus('error');
          notify(`Device runtime logs failed: ${res.status}`, 'error');
          return;
        }
        setStatus('streaming');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!ctrl.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          const nextLines = frames
            .map((frame) =>
              frame
                .split('\n')
                .filter((line) => line.startsWith('data: '))
                .map((line) => line.slice(6))
                .join('\n'),
            )
            .filter(Boolean);
          if (nextLines.length > 0) {
            setLines((prev) => [...prev, ...nextLines].slice(-400));
          }
        }
        setStatus('closed');
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setStatus('error');
        notify(`Device runtime logs failed: ${err instanceof Error ? err.message : 'stream error'}`, 'error');
      }
    }

    void streamLogs();
    return () => ctrl.abort();
  }, [installation.observability.logsPath, notify]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end bg-black/35 p-4 backdrop-blur-sm">
      <motion.aside
        initial={{ opacity: 0, y: 18, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 18, scale: 0.985 }}
        transition={springSoft}
        className={`flex h-[min(720px,86vh)] w-[min(920px,94vw)] flex-col overflow-hidden border ${radius.pane} ${surface.pane[isDark ? 'dark' : 'light']}`}
      >
        <header
          className={`flex shrink-0 items-center justify-between border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <div className="min-w-0">
            <p className={`truncate text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
              Device runtime logs
            </p>
            <p className={`truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {installation.podName} · {status}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={`rounded-2xl border px-3 py-1.5 text-xs font-semibold ${isDark ? 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.05]' : 'border-zinc-200 text-zinc-700 hover:bg-zinc-100'}`}
          >
            Close
          </button>
        </header>
        <pre
          className={`min-h-0 flex-1 overflow-auto p-4 text-[11px] leading-5 ${isDark ? 'bg-black/20 text-zinc-300' : 'bg-zinc-950 text-zinc-100'}`}
        >
          {lines.length === 0 ? `Waiting for log frames from ${installation.podName}...\n` : lines.join('\n')}
        </pre>
      </motion.aside>
    </div>
  );
}

/**
 * W5 — install verification cadence. After the install RPC returns we poll
 * the workspace runtime snapshot looking for the new agent's imUserId on
 * any device whose deviceId matches our daemonId. Daemon `agent.host.declare`
 * fires on first WS reconnect (immediately after install) plus a 30s loop;
 * we cap the wait at 90s = 3 declare cycles. Beyond that the daemon almost
 * certainly didn't pick up the profile and we surface a `failed` state with
 * the install_id for diagnostics.
 */
const INSTALL_VERIFY_TIMEOUT_MS = 90_000;
const INSTALL_VERIFY_INTERVAL_MS = 3_000;

type InstallVerificationState =
  | { status: 'idle' }
  | { status: 'verifying'; agentImUserId: string; agentName: string; sinceMs: number }
  | { status: 'verified'; agentImUserId: string; agentName: string; elapsedMs: number }
  | { status: 'failed'; agentImUserId: string; agentName: string; reason: string };

function InstallAgentPanel({
  isDark,
  installation,
  agents,
  onClose,
  onInstalled,
  notify,
}: {
  isDark: boolean;
  installation: RuntimeInstallationDTO;
  agents: AgentDTO[];
  onClose: () => void;
  onInstalled: () => Promise<void> | void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.userId ?? '');
  const [mode, setMode] = useState<'existing' | 'new'>(agents.length > 0 ? 'existing' : 'new');
  const [adapterName, setAdapterName] = useState('hermes');
  const [displayName, setDisplayName] = useState('Runtime Engineer');
  const [username, setUsername] = useState(() => `runtime-${Math.random().toString(36).slice(2, 8)}`);
  const [installing, setInstalling] = useState(false);
  const [verification, setVerification] = useState<InstallVerificationState>({ status: 'idle' });
  const selectedAgent = agents.find((agent) => agent.userId === agentId) ?? null;

  // W5 — once install RPC succeeds, switch the panel into a polling state.
  // We poll the runtime snapshot for up to INSTALL_VERIFY_TIMEOUT_MS or until
  // the agent's imUserId shows up under any device matching our daemonId.
  // Polling lives in an effect (not the install handler) so a successful
  // install can be re-verified on remount and the modal stays interactive.
  useEffect(() => {
    if (verification.status !== 'verifying') return;
    const startedAt = Date.now() - verification.sinceMs;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const elapsedMs = Date.now() - startedAt;
      const res = await imFetch<WorkspaceRuntimeDTO>(
        `/workspaces/${encodeURIComponent(installation.workspaceId)}/runtime`,
      );
      if (cancelled) return;
      if (res.ok) {
        const matched = (res.data?.devices ?? []).some(
          (device) =>
            (device.deviceId === installation.daemonId || device.deviceId.endsWith(installation.runtimeInstanceId)) &&
            device.agents.some((agent) => agent.id === verification.agentImUserId),
        );
        if (matched) {
          setVerification({
            status: 'verified',
            agentImUserId: verification.agentImUserId,
            agentName: verification.agentName,
            elapsedMs,
          });
          await onInstalled();
          return;
        }
      }
      if (elapsedMs >= INSTALL_VERIFY_TIMEOUT_MS) {
        setVerification({
          status: 'failed',
          agentImUserId: verification.agentImUserId,
          agentName: verification.agentName,
          reason: `Daemon did not declare ${verification.agentName} within ${Math.round(INSTALL_VERIFY_TIMEOUT_MS / 1000)}s. The device runtime may be offline or the adapter spawn failed — check Logs.`,
        });
        return;
      }
      window.setTimeout(tick, INSTALL_VERIFY_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [verification, installation.workspaceId, installation.daemonId, installation.runtimeInstanceId, onInstalled]);

  async function install() {
    if (mode === 'existing' && !agentId) {
      notify('Select an agent to install.', 'error');
      return;
    }
    setInstalling(true);
    try {
      let targetAgentId = agentId;
      let targetAgentName = selectedAgent?.name ?? 'Agent';
      if (mode === 'new') {
        const created = await createAgent({
          username: username.trim(),
          displayName: displayName.trim(),
          agentType: adapterName === 'codex' || adapterName === 'claude-code' ? 'tool' : 'orchestrator',
          workspaceId: installation.workspaceId,
          adapter: adapterName,
          description: `${displayName.trim()} hosted on device runtime ${installation.runtimeInstanceId}`,
        });
        if (!created.ok) {
          notify(`Create agent failed: ${created.message}`, 'error');
          return;
        }
        targetAgentId = created.data.imUserId;
        targetAgentName = created.data.displayName;
      }

      const installed = await installAgentToRuntime({
        runtimeInstallationId: installation.id,
        agentImUserId: targetAgentId,
        adapterName,
        profileName: 'default',
        config: defaultProfileConfig(adapterName),
      });
      if (!installed.ok) {
        notify(`Install failed: ${installed.message}`, 'error');
        return;
      }
      notify(`${targetAgentName} installed; verifying daemon declare...`, 'info');
      // Switch the panel into the verification state. Don't `await onInstalled`
      // here — that triggers the parent's reload and races the panel's own
      // poll. The verified branch will call onInstalled() when it succeeds.
      setVerification({
        status: 'verifying',
        agentImUserId: targetAgentId,
        agentName: targetAgentName,
        sinceMs: 0,
      });
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm">
      <motion.aside
        data-testid="install-agent-panel"
        initial={{ opacity: 0, y: 16, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 16, scale: 0.985 }}
        transition={springSoft}
        className={`w-[min(560px,94vw)] overflow-hidden border ${radius.pane} ${surface.pane[isDark ? 'dark' : 'light']}`}
      >
        <header className={`border-b px-5 py-4 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}>
          <p className={`text-sm font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>
            Install agent to device
          </p>
          <p className={`mt-0.5 truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            {installation.runtimeInstanceId} · {installation.daemonId}
          </p>
        </header>

        <div className="space-y-4 p-5">
          <div
            className={`grid grid-cols-2 gap-2 rounded-2xl border p-1 ${isDark ? 'border-white/[0.08] bg-white/[0.03]' : 'border-zinc-200 bg-zinc-100'}`}
          >
            {(['existing', 'new'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                className={`h-9 rounded-xl text-xs font-semibold transition-colors ${
                  mode === item
                    ? isDark
                      ? 'bg-white/[0.1] text-zinc-100'
                      : 'bg-white text-zinc-900 shadow-sm'
                    : isDark
                      ? 'text-zinc-500 hover:text-zinc-300'
                      : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {item === 'existing' ? 'Existing agent' : 'New agent'}
              </button>
            ))}
          </div>

          <label className="block">
            <span className={`mb-1.5 block text-[11px] font-semibold ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              Agent
            </span>
            {mode === 'existing' ? (
              <select
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                className={`h-11 w-full rounded-2xl border px-3 text-sm outline-none ${isDark ? 'border-white/[0.08] bg-zinc-950/80 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'}`}
              >
                {agents.length === 0 ? <option value="">No agents registered</option> : null}
                {agents.map((agent) => (
                  <option key={agent.userId} value={agent.userId}>
                    {agent.name}
                  </option>
                ))}
              </select>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  className={`h-11 rounded-2xl border px-3 text-sm outline-none ${isDark ? 'border-white/[0.08] bg-zinc-950/80 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'}`}
                  placeholder="Display name"
                />
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className={`h-11 rounded-2xl border px-3 text-sm outline-none ${isDark ? 'border-white/[0.08] bg-zinc-950/80 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'}`}
                  placeholder="username"
                />
              </div>
            )}
          </label>

          <label className="block">
            <span className={`mb-1.5 block text-[11px] font-semibold ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              Adapter
            </span>
            <select
              value={adapterName}
              onChange={(event) => setAdapterName(event.target.value)}
              className={`h-11 w-full rounded-2xl border px-3 text-sm outline-none ${isDark ? 'border-white/[0.08] bg-zinc-950/80 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900'}`}
            >
              <option value="hermes">Hermes</option>
              <option value="openclaw">OpenClaw</option>
              <option value="claude-code">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>

          <div
            className={`rounded-2xl border px-3 py-3 text-[11px] ${isDark ? 'border-white/[0.06] bg-white/[0.03] text-zinc-500' : 'border-zinc-200 bg-white/70 text-zinc-500'}`}
          >
            Install is idempotent. The daemon will upsert its local agent/profile mirror, reload hosted agents, and
            redeclare to cloud.
          </div>

          {verification.status !== 'idle' ? <InstallVerificationBanner isDark={isDark} state={verification} /> : null}
        </div>

        <footer
          className={`flex justify-end gap-2 border-t px-5 py-4 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <button
            type="button"
            onClick={onClose}
            data-testid="install-agent-close"
            className={`h-9 rounded-2xl border px-3 text-xs font-semibold ${isDark ? 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.05]' : 'border-zinc-200 text-zinc-700 hover:bg-zinc-100'}`}
          >
            {verification.status === 'verified' ? 'Done' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={install}
            disabled={
              installing ||
              verification.status === 'verifying' ||
              (mode === 'existing' ? !agentId : !displayName.trim() || !username.trim())
            }
            data-testid="install-agent-submit"
            className={`h-9 rounded-2xl px-3 text-xs font-semibold text-white disabled:cursor-wait disabled:opacity-60 ${isDark ? 'bg-violet-500 hover:bg-violet-400' : 'bg-violet-600 hover:bg-violet-700'}`}
          >
            {installing
              ? 'Installing'
              : verification.status === 'verifying'
                ? 'Verifying...'
                : verification.status === 'verified'
                  ? 'Re-install'
                  : 'Install'}
          </button>
        </footer>
      </motion.aside>
    </div>
  );
}

/**
 * W5 — verification banner shown inside the InstallAgentPanel after the
 * install RPC succeeds. Three states: verifying (spinner + elapsed time),
 * verified (green check), failed (red X with reason). The data-testid
 * `install-verification` lets specs assert on the panel's outcome without
 * scraping the parent runtime card.
 */
function InstallVerificationBanner({ isDark, state }: { isDark: boolean; state: InstallVerificationState }) {
  if (state.status === 'verifying') {
    return (
      <div
        data-testid="install-verification"
        data-state="verifying"
        className={`flex items-start gap-3 rounded-2xl border px-3 py-3 text-[11px] ${
          isDark ? 'border-cyan-400/20 bg-cyan-400/10 text-cyan-200' : 'border-cyan-200 bg-cyan-50 text-cyan-700'
        }`}
      >
        <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Verifying daemon declare for {state.agentName}</p>
          <p className="mt-0.5 opacity-80">
            Polling /workspaces/:id/runtime every 3s for up to {Math.round(INSTALL_VERIFY_TIMEOUT_MS / 1000)}s.
          </p>
        </div>
      </div>
    );
  }
  if (state.status === 'verified') {
    return (
      <div
        data-testid="install-verification"
        data-state="verified"
        className={`flex items-start gap-3 rounded-2xl border px-3 py-3 text-[11px] ${
          isDark
            ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
            : 'border-emerald-200 bg-emerald-50 text-emerald-700'
        }`}
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Verified {state.agentName}</p>
          <p className="mt-0.5 opacity-80">Daemon declared the agent in {formatDuration(state.elapsedMs)}.</p>
        </div>
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <div
        data-testid="install-verification"
        data-state="failed"
        className={`flex items-start gap-3 rounded-2xl border px-3 py-3 text-[11px] ${
          isDark ? 'border-red-400/20 bg-red-400/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700'
        }`}
      >
        <X className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Install pending-declare for {state.agentName}</p>
          <p className="mt-0.5 opacity-80">{state.reason}</p>
        </div>
      </div>
    );
  }
  return null;
}

function defaultProfileConfig(adapterName: string): Record<string, unknown> {
  switch (adapterName) {
    case 'claude-code':
    case 'codex':
      return { cwd: '/workspace' };
    case 'openclaw':
      return { baseUrl: 'http://127.0.0.1:3000', model: 'default' };
    case 'hermes':
    default:
      return { hermesProfileName: 'default', port: 8642, apiKey: '', autoStart: true, startupTimeoutMs: 30_000 };
  }
}

function RuntimeStat({ isDark, label, value }: { isDark: boolean; label: string; value: string }) {
  return (
    <div
      className={`rounded-2xl border px-2.5 py-2 ${isDark ? 'border-white/[0.06] bg-white/[0.03]' : 'border-zinc-200 bg-white/70'}`}
    >
      <p className={`text-[10px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{label}</p>
      <p className={`mt-0.5 truncate text-xs font-semibold ${isDark ? 'text-zinc-100' : 'text-zinc-900'}`}>{value}</p>
    </div>
  );
}

function RuntimeActionButton({
  isDark,
  onClick,
  icon,
  label,
  testid,
  disabled = false,
}: {
  isDark: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  testid?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      disabled={disabled}
      className={`inline-flex h-8 items-center gap-1.5 rounded-2xl border px-2.5 text-[11px] font-semibold transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45 ${
        isDark
          ? 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.05]'
          : 'border-zinc-200 text-zinc-700 hover:bg-zinc-100'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * Real-time terminal panel for daemon shell execution.
 *
 * Why a terminal (not a one-shot form):
 * - The daemon already streams stdout/stderr chunks back as
 *   `task.dispatch.progress` (see sdk/.../shell-executor.ts) which the cloud
 *   persists into `im_task_logs` (see ws/handler.ts handleTaskDispatchProgress).
 *   So GET /api/im/tasks/:id already returns the live output.
 * - Previous fire-and-forget `ShellCommandPanel` created the task but never
 *   surfaced output, leaving users blind.
 * - This panel polls /tasks/:id every 1.2s (cache-warm, cheap) until the task
 *   reaches a terminal status, then renders chunks as a scrollback terminal.
 *   Each command's output stays visible above the prompt.
 *
 * Trade-offs:
 * - Polling, not SSE/WS — simpler, no new infra; 1.2s cadence is "live enough"
 *   for human shell sessions and matches `/tasks/events` SSE granularity.
 * - No xterm.js — pure monospace `<div>` to keep the workspace bundle small;
 *   ANSI escapes will be visible literally (acceptable for diagnostic shells,
 *   the legacy fire-and-forget panel had the same property).
 */

interface TerminalEntry {
  id: string;
  command: string;
  cwd: string;
  taskId: string | null;
  status: 'submitting' | 'running' | 'completed' | 'failed' | 'error';
  exitCode: number | null;
  errorMessage: string | null;
  /** Concatenated stdout+stderr in arrival order (mirrors a real terminal). */
  output: string;
  /** Highest sequence we've already merged so re-polls don't duplicate chunks. */
  seenSequence: number;
  startedAt: number;
  completedAt: number | null;
}

const TERMINAL_POLL_MS = 1_200;
const TERMINAL_HISTORY_MAX = 12; // cap scrollback so the DOM doesn't grow unbounded

function ShellCommandPanel({
  isDark,
  workspaceId,
  device,
  onClose,
  onCreated,
  notify,
}: {
  isDark: boolean;
  workspaceId: string;
  device: RuntimeDeviceDTO;
  onClose: () => void;
  onCreated: () => Promise<void> | void;
  notify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(60_000);
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const isOnline = isDeviceOnline(device, Date.now());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-scroll to bottom on new output. Reading scrollHeight inside an
  // effect (rather than after every setState) is enough — React batches the
  // render, the layout settles, then we pin the view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  // Polling loop: every 1.2s, find any non-terminal entry and fetch /tasks/:id
  // to merge new progress logs. Stops automatically once all entries are
  // terminal — no leftover timer when the user closes the panel.
  useEffect(() => {
    const pending = entries.filter((e) => e.taskId && (e.status === 'running' || e.status === 'submitting'));
    if (pending.length === 0) return;

    let cancelled = false;
    const interval = window.setInterval(async () => {
      if (cancelled) return;
      // Snapshot current pending tasks; the list can change while requests
      // are in flight, but reconciliation by id in setEntries handles that.
      const targets = pending.map((e) => ({ id: e.id, taskId: e.taskId! }));
      await Promise.all(
        targets.map(async ({ id, taskId }) => {
          const res = await imFetch<TaskDetailDTO>(`/tasks/${encodeURIComponent(taskId)}`);
          if (!res.ok || cancelled) return;
          setEntries((prev) => mergeTaskDetail(prev, id, res.data));
        }),
      );
    }, TERMINAL_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // We intentionally re-subscribe whenever the set of pending entries
    // changes (a new submission, or one finishes) so we don't keep polling
    // after everything settles.
  }, [entries]);

  async function submit() {
    const trimmed = command.trim();
    if (!trimmed || submitting) return;
    if (!isOnline) {
      notify('Daemon is offline; reconnect before running commands.', 'error');
      return;
    }
    const entryId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cwdValue = cwd.trim();
    setEntries((prev) =>
      capHistory([
        ...prev,
        {
          id: entryId,
          command: trimmed,
          cwd: cwdValue || '~',
          taskId: null,
          status: 'submitting',
          exitCode: null,
          errorMessage: null,
          output: '',
          seenSequence: -1,
          startedAt: Date.now(),
          completedAt: null,
        },
      ]),
    );
    setCommand('');
    setSubmitting(true);
    try {
      const result = await createShellTask({
        workspaceId,
        command: trimmed,
        targetDaemonId: device.deviceId,
        cwd: cwdValue || undefined,
        timeoutMs,
      });
      if (!result.ok) {
        notify(`Command failed: ${result.message}`, 'error');
        setEntries((prev) =>
          prev.map((e) =>
            e.id === entryId ? { ...e, status: 'error', errorMessage: result.message, completedAt: Date.now() } : e,
          ),
        );
        return;
      }
      setEntries((prev) =>
        prev.map((e) => (e.id === entryId ? { ...e, taskId: result.data.id, status: 'running' } : e)),
      );
      await onCreated();
    } finally {
      setSubmitting(false);
      // Refocus the prompt so the user can keep typing without a click.
      inputRef.current?.focus();
    }
  }

  function clearScrollback() {
    setEntries((prev) => prev.filter((e) => e.status === 'running' || e.status === 'submitting'));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={springSoft}
        data-testid="runtime-terminal-panel"
        className={`flex w-full max-w-3xl flex-col overflow-hidden border ${radius.pane} ${
          isDark ? 'border-white/[0.08] bg-zinc-950 text-zinc-100' : 'border-zinc-300 bg-white text-zinc-900'
        }`}
        style={{ height: 'min(640px, 90vh)' }}
      >
        <div
          className={`flex items-start gap-3 border-b px-4 py-3 ${isDark ? 'border-white/[0.06]' : 'border-zinc-200'}`}
        >
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${isDark ? 'bg-cyan-500/12 text-cyan-200' : 'bg-cyan-50 text-cyan-700'}`}
          >
            <TerminalSquare className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold">Terminal · {device.name}</h3>
            <p className={`mt-0.5 truncate text-[11px] ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              daemon {device.deviceId} · {isOnline ? 'online' : 'offline'} · output streams from task.dispatch.progress
            </p>
          </div>
          <button
            type="button"
            onClick={clearScrollback}
            disabled={entries.length === 0}
            className={`h-8 rounded-2xl border px-3 text-[11px] font-semibold transition-colors disabled:opacity-40 ${isDark ? 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.05]' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'}`}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close terminal"
            className={`flex h-8 w-8 items-center justify-center rounded-2xl border ${isDark ? 'border-white/[0.08] text-zinc-300 hover:bg-white/[0.05]' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100'}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {!isOnline ? (
          <div
            className={`border-b px-4 py-2 text-[11px] ${isDark ? 'border-amber-400/20 bg-amber-400/10 text-amber-100' : 'border-amber-200 bg-amber-50 text-amber-800'}`}
          >
            Daemon heartbeat is stale. Commands queue but won&apos;t run until the daemon reconnects.
          </div>
        ) : null}

        <div
          ref={scrollRef}
          className={`min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[12px] leading-5 ${isDark ? 'bg-black' : 'bg-zinc-950 text-zinc-100'}`}
        >
          {entries.length === 0 ? (
            <p className="text-zinc-500">
              Ready. Type a command below and press Enter to dispatch it as a shell task.
              <br />
              Output streams here as the daemon emits stdout/stderr.
            </p>
          ) : (
            entries.map((entry) => <TerminalBlock key={entry.id} entry={entry} />)
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className={`border-t px-4 py-3 ${isDark ? 'border-white/[0.06] bg-zinc-950' : 'border-zinc-200 bg-zinc-50'}`}
        >
          <div className="flex items-center gap-2">
            <ChevronRight className={`h-4 w-4 shrink-0 ${isDark ? 'text-emerald-400' : 'text-emerald-500'}`} />
            <input
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              autoFocus
              placeholder={isOnline ? 'ls -la' : 'daemon offline — commands will queue'}
              disabled={submitting}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              className={`min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none ${isDark ? 'text-zinc-100 placeholder-zinc-600' : 'text-zinc-900 placeholder-zinc-400'}`}
            />
            <button
              type="submit"
              disabled={submitting || !command.trim() || !isOnline}
              className="h-8 rounded-2xl bg-cyan-500 px-3 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? 'Sending' : 'Run'}
            </button>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px]">
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="cwd (daemon default)"
              className={`h-8 rounded-2xl border px-3 font-mono text-[11px] outline-none ${isDark ? 'border-white/[0.06] bg-black/30 text-zinc-200 placeholder-zinc-600' : 'border-zinc-200 bg-white text-zinc-700 placeholder-zinc-400'}`}
            />
            <input
              type="number"
              min={1_000}
              max={1_800_000}
              step={1_000}
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Number(e.target.value) || 60_000)}
              title="timeout in ms"
              className={`h-8 rounded-2xl border px-3 font-mono text-[11px] outline-none ${isDark ? 'border-white/[0.06] bg-black/30 text-zinc-200' : 'border-zinc-200 bg-white text-zinc-700'}`}
            />
          </div>
        </form>
      </motion.div>
    </div>
  );
}

function TerminalBlock({ entry }: { entry: TerminalEntry }) {
  const trimmedOutput = entry.output.replace(/\n+$/, '');
  return (
    <div className="mb-3">
      <div className="flex items-baseline gap-2 text-emerald-400">
        <span>$</span>
        <span className="break-all text-zinc-100">{entry.command}</span>
        {entry.cwd && entry.cwd !== '~' ? <span className="text-zinc-500">({entry.cwd})</span> : null}
      </div>
      {trimmedOutput ? <pre className="whitespace-pre-wrap text-zinc-200">{trimmedOutput}</pre> : null}
      <div className="mt-1 text-[11px]">
        {entry.status === 'submitting' ? (
          <span className="text-zinc-500">dispatching...</span>
        ) : entry.status === 'running' ? (
          <span className="text-cyan-400">running... (live)</span>
        ) : entry.status === 'completed' ? (
          <span className="text-emerald-400">
            exit 0 · {formatDurationFromTimestamps(entry.startedAt, entry.completedAt)}
          </span>
        ) : entry.status === 'failed' ? (
          <span className="text-red-400">
            exit {entry.exitCode ?? '?'}
            {entry.errorMessage ? ` · ${entry.errorMessage}` : ''} ·{' '}
            {formatDurationFromTimestamps(entry.startedAt, entry.completedAt)}
          </span>
        ) : (
          <span className="text-red-400">{entry.errorMessage ?? 'error'}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Merge a /tasks/:id response into a terminal entry. Idempotent: tracks the
 * highest sequence we've absorbed so re-polls don't duplicate chunks. Falls
 * back to the task `result.output` (formatted blob from shell-executor) when
 * progress logs aren't available — this matches the daemon contract that
 * always sends a final reply even if all chunks were dropped.
 */
function mergeTaskDetail(prev: TerminalEntry[], entryId: string, detail: TaskDetailDTO): TerminalEntry[] {
  return prev.map((e) => {
    if (e.id !== entryId) return e;
    let nextOutput = e.output;
    let highestSeq = e.seenSequence;
    for (const log of detail.logs ?? []) {
      if (log.action !== 'progress') continue;
      const meta = log.metadata as { stream?: string; chunk?: string; sequence?: number } | undefined;
      const seq = typeof meta?.sequence === 'number' ? meta.sequence : -1;
      if (seq <= highestSeq) continue;
      if (typeof meta?.chunk === 'string' && meta.chunk.length > 0) {
        nextOutput += meta.chunk;
      }
      highestSeq = seq;
    }

    const status = detail.task.status;
    let nextStatus: TerminalEntry['status'] = e.status;
    let exitCode: number | null = e.exitCode;
    let errorMessage: string | null = e.errorMessage;
    let completedAt: number | null = e.completedAt;

    if (status === 'completed') {
      nextStatus = 'completed';
      exitCode = 0;
      completedAt = e.completedAt ?? Date.now();
      // Some daemons emit only the final reply (no progress chunks). The
      // formatted output blob from shell-executor is then our only signal —
      // append it once if we haven't received any chunks.
      if (nextOutput.length === 0 && typeof detail.task.result === 'string') {
        nextOutput = detail.task.result as string;
      }
    } else if (status === 'failed' || status === 'cancelled') {
      nextStatus = 'failed';
      errorMessage = detail.task.error ?? errorMessage;
      // Daemon reply error code is daemon-private; surface task.error which
      // ws/handler.ts already populated.
      exitCode = exitCode ?? null;
      completedAt = e.completedAt ?? Date.now();
      if (nextOutput.length === 0 && typeof detail.task.result === 'string') {
        nextOutput = detail.task.result as string;
      }
    } else if (status === 'running' || status === 'assigned') {
      nextStatus = 'running';
    }

    return {
      ...e,
      output: nextOutput,
      seenSequence: highestSeq,
      status: nextStatus,
      exitCode,
      errorMessage,
      completedAt,
    };
  });
}

function capHistory(entries: TerminalEntry[]): TerminalEntry[] {
  if (entries.length <= TERMINAL_HISTORY_MAX) return entries;
  return entries.slice(entries.length - TERMINAL_HISTORY_MAX);
}

function formatDurationFromTimestamps(startedAt: number, completedAt: number | null): string {
  const end = completedAt ?? Date.now();
  return formatDuration(Math.max(0, end - startedAt));
}

function RuntimeAgentAvatar({ seed, label, cli = false }: { seed: string; label: string; cli?: boolean }) {
  const avatar = avatarGradient(seed);
  return (
    <span
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-[10px] font-bold text-white"
      style={{ background: `linear-gradient(135deg, ${avatar.from}, ${avatar.to})` }}
    >
      {cli ? <TerminalSquare className="h-4 w-4" /> : avatarInitials(label)}
    </span>
  );
}

function isDeviceOnline(device: RuntimeDeviceDTO, now: number): boolean {
  if (!device.lastSeenAt) return false;
  const ts = Date.parse(device.lastSeenAt);
  return Number.isFinite(ts) && now - ts <= ONLINE_WINDOW_MS;
}

function formatRelative(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'never';
  const diff = Math.max(0, now - ts);
  if (diff < 30_000) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/**
 * Wave-8 W11 — runtime kind chip. K8s pods get a cyan tint to differentiate
 * from the (default) docker daemon path; both share the same square-border
 * shape so the strip stays visually quiet.
 */
function RuntimeKindBadge({ isDark, kind }: { isDark: boolean; kind: RuntimeKind }) {
  const isK8s = kind === 'k8s';
  return (
    <span
      data-testid="runtime-kind-badge"
      data-kind={kind}
      className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
        isK8s
          ? isDark
            ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200'
            : 'border-cyan-300 bg-cyan-50 text-cyan-700'
          : isDark
            ? 'border-white/10 bg-white/[0.04] text-zinc-400'
            : 'border-zinc-200 bg-zinc-50 text-zinc-600'
      }`}
    >
      {isK8s ? 'K8s' : 'Docker'}
    </span>
  );
}

function phaseClass(phase: string, isDark: boolean): string {
  switch (phase) {
    case 'online':
      return isDark
        ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
        : 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'provisioning':
      return isDark ? 'border-cyan-400/20 bg-cyan-400/10 text-cyan-200' : 'border-cyan-200 bg-cyan-50 text-cyan-700';
    case 'stopped':
      return isDark ? 'border-zinc-500/20 bg-zinc-500/10 text-zinc-300' : 'border-zinc-200 bg-zinc-100 text-zinc-700';
    case 'failed':
      return isDark ? 'border-red-400/20 bg-red-400/10 text-red-200' : 'border-red-200 bg-red-50 text-red-700';
    default:
      return isDark
        ? 'border-amber-400/20 bg-amber-400/10 text-amber-200'
        : 'border-amber-200 bg-amber-50 text-amber-700';
  }
}
