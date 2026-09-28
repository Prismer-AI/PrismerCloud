import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const REQUIRED_PKF_NATIVE_TOOLS = [
  'pkf_mint_sids',
  'pkf_validate',
  'pkf_outline',
  'pkf_search',
  'pkf_read',
  'pkf_bundle_commit',
] as const;

export const REQUIRED_PKF_SKILLS = ['pkf-writing', 'pkf-svg'] as const;

export type PkfRuntimeCapabilityTrigger = 'startup' | 'profile-changed';
export type PkfSkillDoctorState = 'ok' | 'warn' | 'error';
export type PkfSkillDoctorCheckName =
  | 'cloudCatalog'
  | 'agentInstalledLedger'
  | 'daemonSkillsRoot'
  | 'hermesNativeRegistry'
  | 'promptFragment';

export type PkfHermesNativeSkillsInput =
  | { status: 'listed'; slugs: Iterable<string> }
  | { status: 'skipped' | 'probe_failed' | 'unavailable'; reason?: string };

export interface PkfSkillDoctorCheck {
  name: PkfSkillDoctorCheckName;
  state: PkfSkillDoctorState;
  required: string[];
  available: string[];
  missing: string[];
  reason?: string;
  remediation?: string;
}

export interface PkfSkillDoctorReport {
  ok: boolean;
  state: PkfSkillDoctorState;
  required: string[];
  checks: PkfSkillDoctorCheck[];
  warnings: string[];
  errors: string[];
}

export interface PkfRuntimeCapabilityReport {
  schemaVersion: 1;
  trigger: PkfRuntimeCapabilityTrigger;
  profileId?: string;
  checkedAt: string;
  status: 'available' | 'unavailable';
  nativeTools: {
    required: string[];
    available: string[];
    missing: string[];
  };
  skills: {
    required: string[];
    available: string[];
    missing: string[];
  };
  pkfCore: 'available' | 'unavailable';
  cloudCli: 'available' | 'unavailable';
  doctor: PkfSkillDoctorReport;
}

export interface ValidatePkfRuntimeCapabilityInput {
  trigger: PkfRuntimeCapabilityTrigger;
  profileId?: string;
  availableNativeTools: Iterable<string>;
  skillsRoot: string | null;
  pkfCoreAvailable: boolean;
  cloudCliAvailable: boolean;
  catalogSkillSlugs?: Iterable<string> | null;
  installedSkillSlugs?: Iterable<string> | null;
  hermesNativeSkills?: PkfHermesNativeSkillsInput;
  promptSkillSlugs?: Iterable<string> | null;
  promptFragment?: string | null;
  nativeMissingSeverity?: 'warn' | 'error';
  now?: Date;
}

/**
 * Host-side discovery receipt. This is the only place that decides whether the
 * PKF authoring plane is usable; an agent must never rediscover it with PATH or
 * Python probes.
 */
export function validatePkfRuntimeCapability(
  input: ValidatePkfRuntimeCapabilityInput,
): PkfRuntimeCapabilityReport {
  const nativeToolSet = new Set(
    [...input.availableNativeTools].map((name) => name.trim()).filter(Boolean),
  );
  const availableTools = REQUIRED_PKF_NATIVE_TOOLS.filter((name) => nativeToolSet.has(name));
  const missingTools = REQUIRED_PKF_NATIVE_TOOLS.filter((name) => !nativeToolSet.has(name));
  const availableSkills = REQUIRED_PKF_SKILLS.filter(
    (slug) => input.skillsRoot !== null && existsSync(join(input.skillsRoot, slug, 'SKILL.md')),
  );
  const missingSkills = REQUIRED_PKF_SKILLS.filter((slug) => !availableSkills.includes(slug));
  const doctor = buildPkfSkillDoctorReport(input, availableSkills);
  const status =
    missingTools.length === 0 &&
    missingSkills.length === 0 &&
    input.pkfCoreAvailable &&
    input.cloudCliAvailable
      ? 'available'
      : 'unavailable';

  return {
    schemaVersion: 1,
    trigger: input.trigger,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    checkedAt: (input.now ?? new Date()).toISOString(),
    status,
    nativeTools: {
      required: [...REQUIRED_PKF_NATIVE_TOOLS],
      available: availableTools,
      missing: missingTools,
    },
    skills: {
      required: [...REQUIRED_PKF_SKILLS],
      available: availableSkills,
      missing: missingSkills,
    },
    pkfCore: input.pkfCoreAvailable ? 'available' : 'unavailable',
    cloudCli: input.cloudCliAvailable ? 'available' : 'unavailable',
    doctor,
  };
}

/** Render a bounded host receipt into agent context. It explicitly forbids the
 * historical command-v/Python self-check loop in both success and failure. */
export function renderPkfRuntimeCapabilityDirective(report: PkfRuntimeCapabilityReport): string {
  const missing = [
    ...report.nativeTools.missing.map((name) => `tool:${name}`),
    ...report.skills.missing.map((name) => `skill:${name}`),
    ...(report.pkfCore === 'unavailable' ? ['package:@prismer/pkf'] : []),
    ...(report.cloudCli === 'unavailable' ? ['cli:cloud'] : []),
  ];
  return [
    '## PKF Runtime capability receipt (host verified)',
    `status: ${report.status}`,
    `doctor: ${report.doctor.state}`,
    `doctor checks: ${report.doctor.checks
      .map((check) => `${check.name}=${check.state}${check.reason ? `(${check.reason})` : ''}`)
      .join('; ')}`,
    `native function tools: ${report.nativeTools.available.join(', ') || 'none'}`,
    `skills: ${report.skills.available.join(', ') || 'none'}`,
    `@prismer/pkf: ${report.pkfCore}; Cloud CLI: ${report.cloudCli}`,
    ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
    'Never run `command -v`, PATH probes, Python imports, or hand-written validators/SID generators to rediscover or replace these capabilities.',
    report.status === 'unavailable'
      ? 'Keep PKF as a draft or use an explicitly available fallback; do not claim validation, persistence, or attachment success.'
      : 'Call pkf_* names through the native function-tool API. Use `cloud pkf …` only for the documented shell lane.',
  ].join('\n');
}

function buildPkfSkillDoctorReport(
  input: ValidatePkfRuntimeCapabilityInput,
  availableDiskSkills: readonly string[],
): PkfSkillDoctorReport {
  const required = [...REQUIRED_PKF_SKILLS];
  const checks: PkfSkillDoctorCheck[] = [
    presenceCheck({
      name: 'cloudCatalog',
      required,
      slugs: input.catalogSkillSlugs,
      unavailableReason: 'cloud_catalog_unavailable',
      remediation: 'Run built-in skill catalog reconcile; verify sdk/cloud/catalog/skills contains pkf-writing and pkf-svg.',
    }),
    presenceCheck({
      name: 'agentInstalledLedger',
      required,
      slugs: input.installedSkillSlugs,
      unavailableReason: 'agent_installed_ledger_unavailable',
      remediation: 'POST /api/im/agents/:agentId/skills/install-builtins, then rerun daemon skill sync.',
    }),
    diskSkillCheck(input.skillsRoot, required, availableDiskSkills),
    hermesNativeRegistryCheck(input.hermesNativeSkills, required, input.nativeMissingSeverity ?? 'error'),
    promptFragmentCheck(input, required),
  ];
  const errors = checks.filter((check) => check.state === 'error').map((check) => check.name);
  const warnings = checks.filter((check) => check.state === 'warn').map((check) => check.name);
  return {
    ok: errors.length === 0,
    state: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warn' : 'ok',
    required,
    checks,
    warnings,
    errors,
  };
}

function presenceCheck(input: {
  name: PkfSkillDoctorCheckName;
  required: string[];
  slugs?: Iterable<string> | null;
  unavailableReason: string;
  remediation: string;
}): PkfSkillDoctorCheck {
  if (input.slugs === undefined) {
    return {
      name: input.name,
      state: 'warn',
      required: input.required,
      available: [],
      missing: [],
      reason: 'not_checked',
    };
  }
  if (input.slugs === null) {
    return {
      name: input.name,
      state: 'error',
      required: input.required,
      available: [],
      missing: input.required,
      reason: input.unavailableReason,
      remediation: input.remediation,
    };
  }
  const available = normalizeNames(input.slugs);
  const missing = missingRequired(input.required, available);
  return {
    name: input.name,
    state: missing.length > 0 ? 'error' : 'ok',
    required: input.required,
    available,
    missing,
    ...(missing.length > 0
      ? {
          reason: 'missing_required_skill',
          remediation: input.remediation,
        }
      : {}),
  };
}

function diskSkillCheck(
  skillsRoot: string | null,
  required: string[],
  availableDiskSkills: readonly string[],
): PkfSkillDoctorCheck {
  const available = normalizeNames(availableDiskSkills);
  const missing = skillsRoot === null ? required : missingRequired(required, available);
  return {
    name: 'daemonSkillsRoot',
    state: missing.length > 0 ? 'error' : 'ok',
    required,
    available,
    missing,
    ...(skillsRoot === null
      ? {
          reason: 'skills_root_unavailable',
          remediation: 'Resolve the profile skills root and rerun daemon skill sync.',
        }
      : missing.length > 0
        ? {
            reason: 'missing_skill_file',
            remediation: 'Rerun daemon skill sync or restore the built-in skill bundle.',
          }
        : {}),
  };
}

function hermesNativeRegistryCheck(
  native: PkfHermesNativeSkillsInput | undefined,
  required: string[],
  nativeMissingSeverity: 'warn' | 'error',
): PkfSkillDoctorCheck {
  if (native === undefined) {
    return {
      name: 'hermesNativeRegistry',
      state: 'warn',
      required,
      available: [],
      missing: [],
      reason: 'not_checked',
    };
  }
  if (native.status !== 'listed') {
    return {
      name: 'hermesNativeRegistry',
      state: 'warn',
      required,
      available: [],
      missing: [],
      reason: native.reason ?? native.status,
      remediation: 'Upgrade Hermes or inspect /v1/skills probe health; dispatch remains non-blocking.',
    };
  }
  const available = normalizeNames(native.slugs);
  const missing = missingRequired(required, available);
  return {
    name: 'hermesNativeRegistry',
    state: missing.length > 0 ? nativeMissingSeverity : 'ok',
    required,
    available,
    missing,
    ...(missing.length > 0
      ? {
          reason: 'missing_required_skill',
          remediation: 'Restart the Hermes gateway after skill sync; verify /v1/skills lists pkf-writing and pkf-svg.',
        }
      : {}),
  };
}

function promptFragmentCheck(
  input: ValidatePkfRuntimeCapabilityInput,
  required: string[],
): PkfSkillDoctorCheck {
  const promptSlugs =
    input.promptSkillSlugs !== undefined
      ? input.promptSkillSlugs
      : input.promptFragment !== undefined
        ? input.promptFragment === null
          ? null
          : extractSkillSlugsFromPromptFragment(input.promptFragment)
        : undefined;
  if (promptSlugs === undefined) {
    return {
      name: 'promptFragment',
      state: 'warn',
      required,
      available: [],
      missing: [],
      reason: 'not_checked',
    };
  }
  if (promptSlugs === null) {
    return {
      name: 'promptFragment',
      state: 'error',
      required,
      available: [],
      missing: required,
      reason: 'prompt_fragment_unavailable',
      remediation: 'Read skills after built-in install and before composing the adapter instructions.',
    };
  }
  const available = normalizeNames(promptSlugs);
  const missing = missingRequired(required, available);
  return {
    name: 'promptFragment',
    state: missing.length > 0 ? 'error' : 'ok',
    required,
    available,
    missing,
    ...(missing.length > 0
      ? {
          reason: 'missing_prompt_skill',
          remediation: 'Read skills after built-in install and ensure renderSkillsSystemPrompt includes required PKF skills.',
        }
      : {}),
  };
}

export function extractSkillSlugsFromPromptFragment(prompt: string): string[] {
  if (!prompt.trim()) return [];
  const slugs: string[] = [];
  for (const match of prompt.matchAll(/^##\s+([a-zA-Z0-9_-]+)\s*$/gm)) {
    const slug = match[1]?.trim();
    if (slug) slugs.push(slug);
  }
  return normalizeNames(slugs);
}

function normalizeNames(names: Iterable<string>): string[] {
  return [...new Set([...names].map((name) => name.trim()).filter(Boolean))].sort();
}

function missingRequired(required: readonly string[], available: readonly string[]): string[] {
  const set = new Set(available);
  return required.filter((slug) => !set.has(slug));
}
