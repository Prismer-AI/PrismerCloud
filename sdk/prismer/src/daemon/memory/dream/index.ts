// Barrel for the daemon-side Dream module — M-C (doc 25 §3 支柱 3).

export {
  DREAM_IDLE_WINDOW_MS,
  DREAM_LOCK_TTL_MS,
  DREAM_MIN_INTERVAL_MS,
  DREAM_SESSION_THRESHOLD,
  decideDreamRun,
  acquireDreamLock,
  releaseDreamLock,
  bumpActivity,
  incrementSessionCount,
} from './policy.js';
export type { WorkspaceTrackingState, SchedulerDecision } from './policy.js';

export { DreamScheduler } from './scheduler.js';
export type { DreamRunner, DreamSchedulerOptions } from './scheduler.js';

export { CloudDreamRunner } from './runner.js';
export type { CloudDreamRunnerOptions } from './runner.js';

export {
  EXTRACT_SYSTEM_PROMPT,
  SessionExtractRunner,
  parseExtractOutput,
} from './extract-runner.js';
export type {
  ExtractInput,
  ExtractRunnerOptions,
  ExtractedProposal,
} from './extract-runner.js';
