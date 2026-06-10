/**
 * Skill Creator — local phase state machine (release201/28 §3.4).
 *
 * Folds the normalised `AuthoringEvent` stream (live SSE bus OR the mock
 * `simulateAuthoringRun` generator) into the canvas view-model the surface
 * renders. Pure reducer — no React, no side effects — so it is identical under
 * mock + live and trivially testable.
 *
 * Phase ladder (mirrors the prototype's `phase` variable, mapped onto the
 * `AuthoringPhase` union the bus emits):
 *   idle → drafting → building → draftReady → evaluating → evaluated → published
 */

import type { AuthoringEvent, AuthoringPhase } from '../authoring-events';
import type { EvalCase, ManifestFile, SourceRef } from '../types';

export type CreatorPhase =
  | 'idle'
  | 'drafting'
  | 'building'
  | 'draftReady'
  | 'evaluating'
  | 'evaluated'
  | 'published';

export interface SteeringMessageState {
  id: string;
  role: 'agent' | 'user';
  text: string;
  quickReplies?: { label: string; action: string }[];
}

export interface CreatorState {
  phase: CreatorPhase;
  /** false until the first user/agent action — drives the empty-canvas state. */
  started: boolean;
  skillName: string;
  skillSlug: string;
  messages: SteeringMessageState[];
  typing: boolean;
  files: ManifestFile[];
  sources: SourceRef[];
  skillMd: string;
  /** true while SKILL.md is still streaming deltas. */
  streamingMd: boolean;
  evalCases: EvalCase[];
  passRate: number | null;
  activity: { id: string; tool: string; summary: string }[];
}

export function initialCreatorState(manifestTemplate: ManifestFile[]): CreatorState {
  return {
    phase: 'idle',
    started: false,
    skillName: '',
    skillSlug: '',
    messages: [],
    typing: false,
    // start from a pending skeleton so the tree exists before the first write
    files: manifestTemplate.map((f) => ({ ...f, size: null, status: 'pending' })),
    sources: [],
    skillMd: '',
    streamingMd: false,
    evalCases: [],
    passRate: null,
    activity: [],
  };
}

let seq = 0;
const nextId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** Map the bus's `AuthoringPhase` onto the richer local `CreatorPhase`. */
function phaseFor(p: AuthoringPhase, prev: CreatorPhase): CreatorPhase {
  switch (p) {
    case 'intent':
      return 'drafting';
    case 'fetch':
      return prev === 'idle' ? 'drafting' : prev;
    case 'compose':
      return 'building';
    case 'eval':
      return 'evaluating';
    case 'done':
      // `done` lands us at whichever terminal the prior events implied
      return prev === 'evaluating' ? 'evaluated' : prev === 'building' ? 'draftReady' : prev;
    default:
      return prev;
  }
}

/** Append a user/agent message (used by the surface for local sends). */
export function pushMessage(state: CreatorState, role: 'agent' | 'user', text: string): CreatorState {
  return { ...state, started: true, messages: [...state.messages, { id: nextId('msg'), role, text }] };
}

export function setTyping(state: CreatorState, typing: boolean): CreatorState {
  return { ...state, typing };
}

/** Promote → published terminal (local action; no AuthoringEvent equivalent). */
export function publish(state: CreatorState): CreatorState {
  return { ...state, phase: 'published' };
}

/** Fold a single authoring event into the state. */
export function reduceCreator(state: CreatorState, ev: AuthoringEvent): CreatorState {
  switch (ev.type) {
    case 'authoring.phase':
      return { ...state, started: true, phase: phaseFor(ev.phase, state.phase), typing: ev.phase === 'compose' ? false : state.typing };

    case 'authoring.message':
      return {
        ...state,
        started: true,
        typing: false,
        messages: [
          ...state.messages,
          { id: nextId('msg'), role: 'agent', text: ev.text, quickReplies: ev.quickReplies },
        ],
      };

    case 'authoring.source.pulled':
      return {
        ...state,
        started: true,
        sources: [
          ...state.sources,
          { kind: ev.kind, ref: ev.ref, bytes: ev.bytes, meta: `fetched · ${(ev.bytes / 1024).toFixed(1)} KB` },
        ],
      };

    case 'authoring.file.writing':
      return {
        ...state,
        started: true,
        streamingMd: ev.path === 'SKILL.md' ? true : state.streamingMd,
        files: upsertFile(state.files, ev.path, (f) => ({ ...f, status: 'writing' })),
      };

    case 'authoring.file.written':
      return {
        ...state,
        streamingMd: ev.path === 'SKILL.md' ? false : state.streamingMd,
        files: upsertFile(state.files, ev.path, (f) => ({ ...f, status: 'done', size: ev.size, sha256: ev.sha256 })),
      };

    case 'authoring.preview.delta':
      return ev.path === 'SKILL.md'
        ? { ...state, skillMd: state.skillMd + ev.chunk, streamingMd: true }
        : state;

    case 'authoring.tool':
      return { ...state, activity: [...state.activity, { id: nextId('tool'), tool: ev.tool, summary: ev.summary }] };

    case 'eval.progress': {
      // case index → case row; pass-rate is recomputed from accumulated cases
      const cases = [...state.evalCases];
      cases[ev.caseIndex] = { name: cases[ev.caseIndex]?.name ?? `case ${ev.caseIndex + 1}`, passed: ev.passed, ms: ev.ms };
      return { ...state, phase: 'evaluating', evalCases: cases };
    }

    case 'eval.finished':
      return { ...state, phase: 'evaluated', passRate: ev.passRate };

    case 'authoring.failed':
      // surface handles gated/failure rendering; keep the state inert
      return { ...state, typing: false };

    default:
      return state;
  }
}

function upsertFile(files: ManifestFile[], path: string, fn: (f: ManifestFile) => ManifestFile): ManifestFile[] {
  const idx = files.findIndex((f) => f.path === path);
  if (idx === -1) return [...files, fn({ path, size: null, status: 'pending' })];
  const next = [...files];
  next[idx] = fn(next[idx]);
  return next;
}

/**
 * Seed case names from the eval fixture so streamed `eval.progress` rows show
 * the human-readable name (the event only carries an index). Live wiring will
 * carry names in the event payload; this keeps mock parity with the prototype.
 */
export function seedEvalCaseNames(state: CreatorState, names: string[]): CreatorState {
  if (state.evalCases.length > 0 || names.length === 0) return state;
  return { ...state, evalCases: names.map((name) => ({ name, passed: false, ms: 0 })) };
}
