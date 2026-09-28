import { bundleRoot, readPointer, readVerifiedRuntimeMetadata } from './bundle-store.js';

export interface RuntimeOtaSnapshot {
  managerPid: number | null;
  version: string;
  source: 'bundle' | 'builtin';
  current: string | null;
  previous: string | null;
  activeBundleDigest: string | null;
  signatureChecksum: string | null;
  signatureVerified: boolean;
}

export interface RuntimeOtaSnapshotOptions {
  home: string;
  runningVersion: string;
  managerPidEnv?: string;
}

function parseManagerPid(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

/** Capture immutable, fail-closed provenance for the running process. */
export function readRuntimeOtaSnapshot(options: RuntimeOtaSnapshotOptions): RuntimeOtaSnapshot {
  const root = bundleRoot(options.home);
  const current = readPointer(root, 'current');
  const previous = readPointer(root, 'previous');
  const managerPid = parseManagerPid(options.managerPidEnv ?? process.env.SANDBOX_MANAGER_PID);
  const baseline: RuntimeOtaSnapshot = {
    managerPid,
    version: options.runningVersion,
    source: current === options.runningVersion ? 'bundle' : 'builtin',
    current,
    previous,
    activeBundleDigest: null,
    signatureChecksum: null,
    signatureVerified: false,
  };
  if (current === null || current !== options.runningVersion) return Object.freeze(baseline);

  const metadata = readVerifiedRuntimeMetadata(root, current);
  if (metadata === null || metadata.previous !== previous) return Object.freeze(baseline);

  return Object.freeze({
    ...baseline,
    activeBundleDigest: `sha256:${metadata.sha256}`,
    signatureChecksum: `sha256:${metadata.signatureSha256}`,
    signatureVerified: true,
  });
}
