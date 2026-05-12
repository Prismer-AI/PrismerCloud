/**
 * §30 B3.5 — K8s device catalog (templates + resource choices).
 *
 * Copied verbatim from `k8s-provision-wizard.tsx:43-82` so the Pro mode
 * Device sub-panel can render without touching the legacy dialog. When
 * §30 B2 (template system) lands, this constants block migrates into
 * `unified-creation/device/constants.ts` and both Simple + Pro modes
 * read from a single catalog.
 */

export interface K8sTemplate {
  id: string;
  label: string;
  image: string;
  description: string;
  recommendedFor: string;
}

export const TEMPLATES: readonly K8sTemplate[] = [
  {
    id: 'sandbox-default',
    label: 'Sandbox · default',
    image: 'dockerhub.services/prismer/library/sandbox:daemon-v1.0',
    description: 'Standard daemon-first sandbox. Hermes + adapters preinstalled.',
    recommendedFor: 'Most agent runtimes',
  },
  {
    id: 'sandbox-cuda',
    label: 'Sandbox · CUDA',
    image: 'dockerhub.services/prismer/library/sandbox:cuda-v1.0',
    description: 'CUDA 12.4 base. Requires a GPU node-pool on the cluster.',
    recommendedFor: 'Local model inference / training tasks',
  },
  {
    id: 'sandbox-devbox',
    label: 'Sandbox · devbox',
    image: 'dockerhub.services/prismer/library/sandbox:devbox-v1.0',
    description: 'Heavy devtools (gcc, python, node, rust). Larger image.',
    recommendedFor: 'Dev tools + scripting agents',
  },
];

export const CPU_CHOICES: ReadonlyArray<{ id: string; label: string; cpuRequest: string; cpuLimit: string }> = [
  { id: 'small', label: '1 vCPU', cpuRequest: '250m', cpuLimit: '1000m' },
  { id: 'medium', label: '2 vCPU', cpuRequest: '500m', cpuLimit: '2000m' },
  { id: 'large', label: '4 vCPU', cpuRequest: '1000m', cpuLimit: '4000m' },
];

export const MEM_CHOICES: ReadonlyArray<{ id: string; label: string; memoryRequest: string; memoryLimit: string }> = [
  { id: 'small', label: '2 GiB', memoryRequest: '1Gi', memoryLimit: '2Gi' },
  { id: 'medium', label: '4 GiB', memoryRequest: '2Gi', memoryLimit: '4Gi' },
  { id: 'large', label: '8 GiB', memoryRequest: '4Gi', memoryLimit: '8Gi' },
];

export const GPU_CHOICES: ReadonlyArray<{ id: string; label: string; gpu: number }> = [
  { id: 'none', label: '0 (no GPU)', gpu: 0 },
  { id: 'one', label: '1 × T4', gpu: 1 },
];
