// Barrel for the fork-recall SPI. Importers should pull from here so a
// future internal refactor of the per-file split doesn't churn callers.

export {
  runForkedRecallInProcess,
  finalizeSelected,
  buildManifest,
  SELECT_MEMORIES_SYSTEM_PROMPT,
  buildSelectorUserMessage,
  parseSelectorOutput,
  emitForkTrace,
  newForkId,
} from './runner.js';

export type {
  ForkLLMResult,
  ForkedRecallResult,
  RunForkedRecallInProcessParams,
} from './runner.js';

export type {
  ManifestEntry,
  ManifestResponse,
  ManifestOptions,
  RelevantMemory,
  CacheSafeParams,
  SelectedFilenames,
  ForkTraceEvent,
} from './runner.js';
