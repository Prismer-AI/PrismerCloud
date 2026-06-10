'use client';

/**
 * §30 B3.5 — Pro mode Device sub-panel.
 *
 * Copy of the K8sProvisionWizard 3-step form body (template → resources
 * → confirm), with chrome rewritten to design.ts tokens. Each step pane
 * is extracted into ./DeviceStepPanes.tsx so this file stays under the
 * 250-line budget. The legacy `k8s-provision-wizard.tsx` dialog is left
 * untouched per B0 audit rule.
 */

import { useState } from 'react';
import { Cpu, Gpu, Loader2, MemoryStick } from 'lucide-react';

import { radius } from '../../../lib/design';
import { imFetch } from '../../../lib/im-api';
import type { RuntimeInstallationDTO } from '../../../lib/types';
import type { UnifiedCreationEvent } from '../context';
import { CPU_CHOICES, GPU_CHOICES, MEM_CHOICES, TEMPLATES } from './device-catalog';
import { ConfirmPane, ResourceRow, TemplatePane } from './DeviceStepPanes';
import { PanelHeader } from './parts';

type Step = 0 | 1 | 2;

export interface ProTileDeviceProps {
  isDark: boolean;
  workspaceId: string;
  onSuccess: (event: UnifiedCreationEvent) => void;
  onBack: () => void;
}

export function ProTileDevice({ isDark, workspaceId, onSuccess, onBack }: ProTileDeviceProps) {
  const [step, setStep] = useState<Step>(0);
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const [cpuId, setCpuId] = useState('medium');
  const [memId, setMemId] = useState('medium');
  const [gpuId, setGpuId] = useState('none');
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const template = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];

  async function provision() {
    if (!workspaceId) {
      setError('No workspace selected.');
      return;
    }
    setProvisioning(true);
    setError(null);
    try {
      const cpu = CPU_CHOICES.find((c) => c.id === cpuId) ?? CPU_CHOICES[1];
      const mem = MEM_CHOICES.find((m) => m.id === memId) ?? MEM_CHOICES[1];
      const gpu = GPU_CHOICES.find((g) => g.id === gpuId) ?? GPU_CHOICES[0];
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
        }),
      });
      if (!res.ok) {
        setError(res.message || 'Provision failed.');
        return;
      }
      onSuccess({ kind: 'device', id: res.data?.id ?? '' });
    } finally {
      setProvisioning(false);
    }
  }

  return (
    <div data-testid="pro-tile-device" className="grid gap-3">
      <PanelHeader
        isDark={isDark}
        title="Set up a cloud computer"
        subtitle="Pick a type and size — we'll get an isolated computer ready in a few seconds."
      />

      <ol className="flex items-center gap-2 text-[11px] font-semibold">
        {(['Template', 'Resources', 'Confirm'] as const).map((label, i) => (
          <li
            key={label}
            data-testid={`pro-tile-device-step-${i}`}
            data-active={step === i ? 'true' : 'false'}
            className={`inline-flex items-center gap-2 border px-3 py-1 ${radius.chip} ${
              step === i
                ? isDark
                  ? 'border-violet-400/30 bg-violet-400/10 text-violet-200'
                  : 'border-violet-300 bg-violet-50 text-violet-700'
                : isDark
                  ? 'border-white/10 text-zinc-500'
                  : 'border-zinc-200 text-zinc-500'
            }`}
          >
            <span className="font-mono">{i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {step === 0 ? <TemplatePane isDark={isDark} templateId={templateId} onSelect={setTemplateId} /> : null}

      {step === 1 ? (
        <div data-testid="pro-tile-device-pane-resources" className="grid gap-3">
          <ResourceRow
            isDark={isDark}
            icon={<Cpu className="h-4 w-4" />}
            label="CPU"
            testidPrefix="pro-tile-device-cpu"
            choices={CPU_CHOICES.map((c) => ({ id: c.id, label: c.label }))}
            value={cpuId}
            onChange={setCpuId}
          />
          <ResourceRow
            isDark={isDark}
            icon={<MemoryStick className="h-4 w-4" />}
            label="Memory"
            testidPrefix="pro-tile-device-mem"
            choices={MEM_CHOICES.map((m) => ({ id: m.id, label: m.label }))}
            value={memId}
            onChange={setMemId}
          />
          <ResourceRow
            isDark={isDark}
            icon={<Gpu className="h-4 w-4" />}
            label="GPU"
            testidPrefix="pro-tile-device-gpu"
            choices={GPU_CHOICES.map((g) => ({ id: g.id, label: g.label }))}
            value={gpuId}
            onChange={setGpuId}
          />
        </div>
      ) : null}

      {step === 2 ? (
        <ConfirmPane isDark={isDark} template={template} cpuId={cpuId} memId={memId} gpuId={gpuId} error={error} />
      ) : null}

      <footer className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            if (step === 0) onBack();
            else setStep((s) => (s === 0 ? 0 : ((s - 1) as Step)));
          }}
          disabled={provisioning}
          data-testid="pro-tile-device-back"
          className={`inline-flex items-center px-3 py-1.5 text-xs font-medium ${radius.button} ${
            isDark ? 'text-zinc-300 hover:bg-white/[0.06]' : 'text-zinc-600 hover:bg-zinc-100'
          } disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {step === 0 ? 'Cancel' : 'Back'}
        </button>
        {step < 2 ? (
          <button
            type="button"
            data-testid="pro-tile-device-next"
            onClick={() => setStep((s) => (s === 2 ? 2 : ((s + 1) as Step)))}
            className={`inline-flex items-center px-4 py-1.5 text-xs font-semibold ${radius.button} ${
              isDark
                ? 'bg-violet-500/90 text-white hover:bg-violet-400'
                : 'bg-violet-600 text-white hover:bg-violet-500'
            }`}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            data-testid="pro-tile-device-provision"
            disabled={provisioning || !workspaceId}
            onClick={() => void provision()}
            className={`inline-flex items-center px-4 py-1.5 text-xs font-semibold ${radius.button} ${
              isDark
                ? 'bg-violet-500/90 text-white hover:bg-violet-400'
                : 'bg-violet-600 text-white hover:bg-violet-500'
            } disabled:cursor-wait disabled:opacity-70`}
          >
            {provisioning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {provisioning ? 'Setting up…' : 'Create'}
          </button>
        )}
      </footer>
    </div>
  );
}

export default ProTileDevice;
