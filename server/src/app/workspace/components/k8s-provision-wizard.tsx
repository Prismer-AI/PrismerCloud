'use client';

/**
 * Wave-8 W11 — K8s pod provisioning wizard.
 *
 * Three-step modal that posts to `/api/workspace/runtime-installations` with
 * `kind:'k8s'` plus a chosen template + resource shape. The cloud route
 * persists an `im_containers` row with `runtimeKind='k8s'`; the wizard does
 * NOT itself wait for the EKS pod to be ready (the W5 readiness card on the
 * runtime panel takes over once the DTO returns). When the sandbox controller
 * is unreachable the route still persists a `provisioning` row so the wizard
 * always closes successfully and the user can watch the readiness rows
 * converge later — see route.ts §W11 fallback for rationale.
 */

import { useEffect, useState } from 'react';
import { Cpu, Gpu, Layers, Loader2, MemoryStick } from 'lucide-react';
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
import { imFetch } from '../lib/im-api';
import { PROJECT_FILTER_ALL, PROJECT_FILTER_UNSCOPED, readActiveProjectFromStorage } from '../lib/projects-api';
import type { RuntimeInstallationDTO } from '../lib/types';

interface K8sTemplate {
  id: string;
  label: string;
  /** When omitted the server resolves from Nacos CONTAINER_IMAGE. */
  image?: string;
  description: string;
  recommendedFor: string;
  /** When true, shown but not selectable. */
  disabled?: boolean;
}

// Only the daemon sandbox is CI-built. CUDA/devbox are roadmap items.
const TEMPLATES: K8sTemplate[] = [
  {
    id: 'sandbox-default',
    label: 'Sandbox · daemon',
    description: 'Standard daemon-first sandbox. Hermes + adapters preinstalled.',
    recommendedFor: 'Most agent runtimes',
  },
  {
    id: 'sandbox-cuda',
    label: 'Sandbox · CUDA',
    description: 'CUDA 12.4 base. Requires a GPU node-pool on the cluster.',
    recommendedFor: 'Coming soon',
    disabled: true,
  },
  {
    id: 'sandbox-devbox',
    label: 'Sandbox · devbox',
    description: 'Heavy devtools (gcc, python, node, rust). Larger image.',
    recommendedFor: 'Coming soon',
    disabled: true,
  },
];

const CPU_CHOICES: Array<{ id: string; label: string; cpuRequest: string; cpuLimit: string }> = [
  { id: 'small', label: '1 vCPU', cpuRequest: '250m', cpuLimit: '1000m' },
  { id: 'medium', label: '2 vCPU', cpuRequest: '500m', cpuLimit: '2000m' },
  { id: 'large', label: '4 vCPU', cpuRequest: '1000m', cpuLimit: '4000m' },
];

const MEM_CHOICES: Array<{ id: string; label: string; memoryRequest: string; memoryLimit: string }> = [
  { id: 'small', label: '2 GiB', memoryRequest: '1Gi', memoryLimit: '2Gi' },
  { id: 'medium', label: '4 GiB', memoryRequest: '2Gi', memoryLimit: '4Gi' },
  { id: 'large', label: '8 GiB', memoryRequest: '4Gi', memoryLimit: '8Gi' },
];

const GPU_CHOICES: Array<{ id: string; label: string; gpu: number }> = [
  { id: 'none', label: '0 (no GPU)', gpu: 0 },
  { id: 'one', label: '1 × T4', gpu: 1 },
];

interface K8sProvisionWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  isDark: boolean;
  notify: (message: string, type: 'success' | 'error' | 'info') => void;
  /** Called with the new installation DTO (or `null` if route returned no body). */
  onProvisioned: (installation: RuntimeInstallationDTO | null) => Promise<void> | void;
}

type Step = 0 | 1 | 2;

export function K8sProvisionWizard({
  open,
  onOpenChange,
  workspaceId,
  isDark,
  notify,
  onProvisioned,
}: K8sProvisionWizardProps) {
  const [step, setStep] = useState<Step>(0);
  const [templateId, setTemplateId] = useState(TEMPLATES[0]!.id);
  const [cpuId, setCpuId] = useState('medium');
  const [memId, setMemId] = useState('medium');
  const [gpuId, setGpuId] = useState('none');
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset wizard state every time it reopens — operators expect a clean slate
  // (template/resources can vary wildly between provision events).
  useEffect(() => {
    if (open) {
      setStep(0);
      setTemplateId(TEMPLATES[0]!.id);
      setCpuId('medium');
      setMemId('medium');
      setGpuId('none');
      setProvisioning(false);
      setError(null);
    }
  }, [open]);

  const template = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0]!;
  const cpu = CPU_CHOICES.find((c) => c.id === cpuId) ?? CPU_CHOICES[1]!;
  const mem = MEM_CHOICES.find((m) => m.id === memId) ?? MEM_CHOICES[1]!;
  const gpu = GPU_CHOICES.find((g) => g.id === gpuId) ?? GPU_CHOICES[0]!;

  async function provision(): Promise<void> {
    if (!workspaceId) {
      setError('No workspace selected.');
      return;
    }
    setProvisioning(true);
    setError(null);
    try {
      // M448 (doc 20 Gap A) — inherit ProjectSwitcher's active project (when
      // it's a real id, not the 'all' / '__unscoped' sentinels) so wizard-
      // provisioned pods land scoped just like the simple-create path.
      const activeProject = readActiveProjectFromStorage(workspaceId);
      const scopedProjectId =
        activeProject && activeProject !== PROJECT_FILTER_ALL && activeProject !== PROJECT_FILTER_UNSCOPED
          ? activeProject
          : undefined;
      const res = await imFetch<RuntimeInstallationDTO>('/api/workspace/runtime-installations', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId,
          kind: 'k8s',
          template: template.id,
          cpuRequest: cpu.cpuRequest,
          cpuLimit: cpu.cpuLimit,
          memoryRequest: mem.memoryRequest,
          memoryLimit: mem.memoryLimit,
          gpu: gpu.gpu,
          ...(template.image ? { image: template.image } : {}),
          ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
        }),
      });
      if (!res.ok) {
        const msg = res.message || 'Provision failed.';
        setError(msg);
        notify(`K8s provision failed: ${msg}`, 'error');
        return;
      }
      // 202 fallback path can return empty body — caller still must reload its
      // installations list, so forward `null` and let the parent decide.
      await onProvisioned(res.data ?? null);
      notify('K8s pod provisioning started.', 'success');
      onOpenChange(false);
    } finally {
      setProvisioning(false);
    }
  }

  const stepLabels: Array<{ idx: Step; label: string }> = [
    { idx: 0, label: 'Template' },
    { idx: 1, label: 'Resources' },
    { idx: 2, label: 'Confirm' },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="k8s-wizard"
        className={cn('sm:max-w-[640px]', isDark ? 'border-white/10 bg-zinc-950 text-zinc-100' : 'bg-white')}
      >
        <DialogHeader>
          <DialogTitle>Provision K8s device</DialogTitle>
          <DialogDescription>
            Pick a template and resource shape; the controller schedules an isolated pod, then the device card tracks
            runtime readiness once the daemon registers.
          </DialogDescription>
        </DialogHeader>

        <ol className="flex items-center gap-2 px-1 pb-2 text-[11px] font-semibold">
          {stepLabels.map((s, i) => (
            <li
              key={s.idx}
              data-testid={`k8s-wizard-step-${s.idx}`}
              data-active={step === s.idx ? 'true' : 'false'}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1',
                step === s.idx
                  ? isDark
                    ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-200'
                    : 'border-cyan-300 bg-cyan-50 text-cyan-700'
                  : isDark
                    ? 'border-white/10 text-zinc-500'
                    : 'border-zinc-200 text-zinc-500',
              )}
            >
              <span className="font-mono">{i + 1}</span>
              {s.label}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <div data-testid="k8s-wizard-pane-template" className="space-y-2">
            {TEMPLATES.map((t) => {
              const disabled = t.disabled;
              return (
                <button
                  type="button"
                  key={t.id}
                  disabled={disabled}
                  data-testid={`k8s-wizard-template-${t.id}`}
                  data-selected={templateId === t.id ? 'true' : 'false'}
                  onClick={disabled ? undefined : () => setTemplateId(t.id)}
                  className={cn(
                    'w-full rounded-2xl border px-4 py-3 text-left transition-colors',
                    disabled
                      ? 'cursor-not-allowed opacity-40'
                      : templateId === t.id
                        ? isDark
                          ? 'border-cyan-400/40 bg-cyan-400/5'
                          : 'border-cyan-300 bg-cyan-50/40'
                        : isDark
                          ? 'border-white/10 hover:bg-white/[0.03]'
                          : 'border-zinc-200 hover:bg-zinc-50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4" />
                    <span className="text-sm font-semibold">{t.label}</span>
                    <span
                      className={cn(
                        'ml-auto rounded-full border px-2 py-0.5 text-[9px] font-semibold',
                        disabled
                          ? isDark
                            ? 'border-amber-400/30 text-amber-300'
                            : 'border-amber-400 text-amber-600'
                          : isDark
                            ? 'border-white/10 text-zinc-500'
                            : 'border-zinc-200 text-zinc-500',
                      )}
                    >
                      {disabled ? 'Coming soon' : t.image}
                    </span>
                  </div>
                  <p className={cn('mt-1 text-xs', isDark ? 'text-zinc-400' : 'text-zinc-600')}>{t.description}</p>
                  <p className={cn('mt-1 text-[10px]', isDark ? 'text-zinc-500' : 'text-zinc-500')}>
                    Recommended for: {t.recommendedFor}
                  </p>
                </button>
              );
            })}
          </div>
        ) : null}

        {step === 1 ? (
          <div data-testid="k8s-wizard-pane-resources" className="space-y-3">
            <ResourceRow
              isDark={isDark}
              icon={<Cpu className="h-4 w-4" />}
              label="CPU"
              testidPrefix="k8s-wizard-cpu"
              choices={CPU_CHOICES.map((c) => ({ id: c.id, label: c.label }))}
              value={cpuId}
              onChange={setCpuId}
            />
            <ResourceRow
              isDark={isDark}
              icon={<MemoryStick className="h-4 w-4" />}
              label="Memory"
              testidPrefix="k8s-wizard-mem"
              choices={MEM_CHOICES.map((m) => ({ id: m.id, label: m.label }))}
              value={memId}
              onChange={setMemId}
            />
            <ResourceRow
              isDark={isDark}
              icon={<Gpu className="h-4 w-4" />}
              label="GPU"
              testidPrefix="k8s-wizard-gpu"
              choices={GPU_CHOICES.map((g) => ({ id: g.id, label: g.label }))}
              value={gpuId}
              onChange={setGpuId}
            />
          </div>
        ) : null}

        {step === 2 ? (
          <dl
            data-testid="k8s-wizard-pane-confirm"
            className={cn(
              'grid grid-cols-[120px_minmax(0,1fr)] gap-y-1 rounded-2xl border px-4 py-3 text-xs',
              isDark ? 'border-white/10 bg-white/[0.02] text-zinc-300' : 'border-zinc-200 bg-zinc-50 text-zinc-700',
            )}
          >
            <dt className="font-semibold">Template</dt>
            <dd>{template.label}</dd>
            <dt className="font-semibold">Image</dt>
            <dd className="truncate font-mono text-[11px]">{template.image}</dd>
            <dt className="font-semibold">CPU</dt>
            <dd>
              {cpu.label} (request {cpu.cpuRequest}, limit {cpu.cpuLimit})
            </dd>
            <dt className="font-semibold">Memory</dt>
            <dd>
              {mem.label} (request {mem.memoryRequest}, limit {mem.memoryLimit})
            </dd>
            <dt className="font-semibold">GPU</dt>
            <dd>{gpu.label}</dd>
            {error ? (
              <>
                <dt className="font-semibold text-red-400">Error</dt>
                <dd className="text-red-400">{error}</dd>
              </>
            ) : null}
          </dl>
        ) : null}

        <DialogFooter className="flex flex-row items-center justify-between gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            data-testid="k8s-wizard-back"
            disabled={step === 0 || provisioning}
            onClick={() => setStep((s) => (s === 0 ? 0 : ((s - 1) as Step)))}
          >
            Back
          </Button>
          {step < 2 ? (
            <Button
              type="button"
              data-testid="k8s-wizard-next"
              onClick={() => setStep((s) => (s === 2 ? 2 : ((s + 1) as Step)))}
            >
              Next
            </Button>
          ) : (
            <Button
              type="button"
              data-testid="k8s-wizard-provision"
              disabled={provisioning || !workspaceId}
              onClick={() => void provision()}
              className={cn(provisioning && 'cursor-wait opacity-70')}
            >
              {provisioning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {provisioning ? 'Provisioning…' : 'Provision'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResourceRow({
  isDark,
  icon,
  label,
  testidPrefix,
  choices,
  value,
  onChange,
}: {
  isDark: boolean;
  icon: React.ReactNode;
  label: string;
  testidPrefix: string;
  choices: Array<{ id: string; label: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className={cn('rounded-2xl border px-4 py-3', isDark ? 'border-white/10' : 'border-zinc-200')}>
      <div className="flex items-center gap-2 text-xs font-semibold">
        {icon}
        {label}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            data-testid={`${testidPrefix}-${c.id}`}
            data-selected={value === c.id ? 'true' : 'false'}
            onClick={() => onChange(c.id)}
            className={cn(
              'rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors',
              value === c.id
                ? isDark
                  ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200'
                  : 'border-cyan-300 bg-cyan-50 text-cyan-700'
                : isDark
                  ? 'border-white/10 text-zinc-400 hover:bg-white/[0.04]'
                  : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100',
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}
