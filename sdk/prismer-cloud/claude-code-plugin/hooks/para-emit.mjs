#!/usr/bin/env node
/**
 * para-emit.mjs — Universal PARA adapter hook for Claude Code
 *
 * Usage (CC invokes this as a hook):
 *   node para-emit.mjs <CCHookName>
 *   stdin: CC hook JSON payload
 *
 * Translates the CC payload into PARA event(s) per §4.5 of
 * docs/version190/03-para-spec.md, then writes JSONL to:
 *   ~/.prismer/para/events.jsonl  (always, append)
 *   stdout                        (if PRISMER_PARA_STDOUT=1)
 *
 * Error policy: validation/translation errors are written to stderr and the
 * process exits 0 to avoid breaking Claude Code. This hook is observation-only.
 *
 * Mapping: 26 CC hook names → 42 PARA events (see §4.5 table)
 *   SessionStart          → agent.register (first time) + agent.session.started
 *   SessionEnd            → agent.session.ended
 *   UserPromptSubmit      → agent.prompt.submit
 *   PreToolUse            → agent.tool.pre
 *   PostToolUse           → agent.tool.post
 *   PostToolUseFailure    → agent.tool.failure
 *   PermissionRequest     → agent.approval.request
 *   PermissionDenied      → agent.approval.denied
 *   SubagentStart         → agent.subagent.started
 *   SubagentStop          → agent.subagent.ended
 *   TaskCreated           → agent.task.created
 *   TaskCompleted         → agent.task.completed
 *   TeammateIdle          → agent.teammate.idle
 *   Stop                  → agent.turn.end
 *   StopFailure           → agent.turn.failure
 *   Notification          → agent.notification
 *   InstructionsLoaded    → agent.instructions.loaded
 *   ConfigChange          → agent.config.changed
 *   CwdChanged            → agent.cwd.changed
 *   FileChanged           → agent.file.watched
 *   WorktreeCreate        → agent.worktree.created
 *   WorktreeRemove        → agent.worktree.removed
 *   PreCompact            → agent.compact.pre
 *   PostCompact           → agent.compact.post
 *   Elicitation           → agent.elicitation.request
 *   ElicitationResult     → agent.elicitation.result
 */

import { createHash } from 'crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'fs';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { execFileSync, spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Paths ────────────────────────────────────────────────────────────────────

const PARA_DIR = join(homedir(), '.prismer', 'para');
const EVENTS_FILE = join(PARA_DIR, 'events.jsonl');
const AGENT_DESC_FILE = join(PARA_DIR, 'agent-descriptor.json');

// ─── Load @prismer/wire and @prismer/adapters-core ───────────────────────────
// These are bundled as tarballs in node_modules.

let ParaEventSchema, makeRegisterEvent, makeSessionStarted, makeSessionReset,
  makeSessionEnded, makeLlmPre, makeLlmPost, makeToolPre, makeToolPost, makeToolFailure,
  makeTurnStep, makeTurnEnd, makeTurnFailure, makeApprovalRequest, makeTaskCreated,
  makeTaskCompleted, makeCompactPre, makeCompactPost,
  makeSkillActivated, makeSkillDeactivated, makeSkillProposed,
  makeSkillInstalled, makeSkillUninstalled;

function bindParaPackages(wire, adaptersCore) {
  ParaEventSchema = wire.ParaEventSchema;
  makeRegisterEvent = adaptersCore.makeRegisterEvent;
  makeSessionStarted = adaptersCore.makeSessionStarted;
  makeSessionReset = adaptersCore.makeSessionReset;
  makeSessionEnded = adaptersCore.makeSessionEnded;
  makeLlmPre = adaptersCore.makeLlmPre;
  makeLlmPost = adaptersCore.makeLlmPost;
  makeToolPre = adaptersCore.makeToolPre;
  makeToolPost = adaptersCore.makeToolPost;
  makeToolFailure = adaptersCore.makeToolFailure;
  makeTurnStep = adaptersCore.makeTurnStep;
  makeTurnEnd = adaptersCore.makeTurnEnd;
  makeTurnFailure = adaptersCore.makeTurnFailure;
  makeApprovalRequest = adaptersCore.makeApprovalRequest;
  makeTaskCreated = adaptersCore.makeTaskCreated;
  makeTaskCompleted = adaptersCore.makeTaskCompleted;
  makeCompactPre = adaptersCore.makeCompactPre;
  makeCompactPost = adaptersCore.makeCompactPost;
  makeSkillActivated = adaptersCore.makeSkillActivated;
  makeSkillDeactivated = adaptersCore.makeSkillDeactivated;
  makeSkillProposed = adaptersCore.makeSkillProposed;
  makeSkillInstalled = adaptersCore.makeSkillInstalled;
  makeSkillUninstalled = adaptersCore.makeSkillUninstalled;
}

function requireLocalPrtPackage(packageDirName) {
  const sdkRoot = join(__dirname, '..', '..');
  const packageJson = join(sdkRoot, packageDirName, 'package.json');
  const localRequire = createRequire(packageJson);
  return localRequire(join(sdkRoot, packageDirName, 'dist', 'index.js'));
}

try {
  // Resolve from plugin root (one dir up from hooks/)
  const pluginRoot = join(__dirname, '..');
  const wireReq = createRequire(join(pluginRoot, 'package.json'));
  const wire = wireReq('@prismer/wire');
  const adaptersCore = wireReq('@prismer/adapters-core');
  bindParaPackages(wire, adaptersCore);
} catch (e) {
  // Fallback: try resolving from para-emit's own location
  try {
    const r = createRequire(import.meta.url);
    const wire = r('@prismer/wire');
    const adaptersCore = r('@prismer/adapters-core');
    bindParaPackages(wire, adaptersCore);
  } catch (e2) {
    try {
      const wire = requireLocalPrtPackage('wire');
      const adaptersCore = requireLocalPrtPackage('adapters-core');
      bindParaPackages(wire, adaptersCore);
    } catch (e3) {
      process.stderr.write(`[para-emit] FATAL: cannot load @prismer/wire or @prismer/adapters-core: ${e3.message}\n`);
      process.exit(0);
    }
  }
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

function generateId() {
  const h = () => Math.floor(Math.random() * 16).toString(16);
  const s4 = () => Array.from({ length: 4 }, h).join('');
  const s8 = () => Array.from({ length: 8 }, h).join('');
  const v = () => (Math.floor(Math.random() * 4) + 8).toString(16);
  return `${s8()}-${s4()}-4${s4().slice(1)}-${v()}${s4().slice(1)}-${s8()}${s4()}`;
}

/**
 * Generate a stable adapter ID per PARA spec §4.3 AgentDescriptor example
 * ("claude-code@MacBook-Pro"). Format: `<adapter>-<16-hex hash>` where the
 * hash covers adapter + workspace + hostname so:
 *   - Two instances of CC on the same workspace share the SAME id (correct).
 *   - CC and OpenClaw on the same workspace produce DIFFERENT ids (correct —
 *     they are distinct agents even if co-located).
 *   - Daemon can strip the `<adapter>-` prefix to compare location across
 *     adapters when needed.
 */
function stableAdapterId(workspace, adapter = 'claude-code') {
  const hash = createHash('sha256')
    .update(`${adapter}:${workspace}:${hostname()}`)
    .digest('hex')
    .slice(0, 16);
  return `${adapter}-${hash}`;
}

/** Normalize a session ID from the CC payload. */
function sessionId(p) {
  return (typeof p.session_id === 'string' && p.session_id) ||
    (typeof p.sessionId === 'string' && p.sessionId) ||
    generateId();
}

/** Get CC version string (cached). */
let _ccVersion = null;
function getCCVersion() {
  if (_ccVersion !== null) return _ccVersion;
  try {
    const raw = execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 3000 });
    // "Claude Code 1.x.y" → "1.x.y"
    const m = raw.match(/\d+\.\d+[\.\d]*/);
    _ccVersion = m ? m[0] : raw.trim().split('\n')[0];
  } catch {
    _ccVersion = 'unknown';
  }
  return _ccVersion;
}

/** Normalize a tool call ID from the CC payload. */
function callId(p) {
  return (typeof p.tool_use_id === 'string' && p.tool_use_id) ||
    (typeof p.call_id === 'string' && p.call_id) ||
    generateId();
}

/** Safely stringify unknown args. */
function safeArgs(v) {
  if (v === undefined || v === null) return {};
  return typeof v === 'object' ? v : { raw: String(v) };
}

/** Normalize StopFailure errorType to PARA enum. */
function normalizeErrorType(raw) {
  if (!raw) return 'unknown';
  const s = String(raw).toLowerCase();
  if (s.includes('rate') || s.includes('429')) return 'rate_limit';
  if (s.includes('auth') || s.includes('401') || s.includes('403')) return 'auth';
  if (s.includes('bill') || s.includes('credit') || s.includes('quota')) return 'billing';
  if (s.includes('invalid') || s.includes('400')) return 'invalid';
  if (s.includes('server') || s.includes('500') || s.includes('502') || s.includes('503')) return 'server';
  if (s.includes('token') || s.includes('length') || s.includes('context')) return 'max_tokens';
  return 'unknown';
}

/** Normalize Notification type to PARA enum. */
function normalizeNotificationType(raw) {
  if (!raw) return 'other';
  const s = String(raw).toLowerCase();
  if (s.includes('permission') || s.includes('prompt')) return 'permission_prompt';
  if (s.includes('idle')) return 'idle_prompt';
  if (s.includes('auth')) return 'auth_success';
  if (s.includes('elicit') || s.includes('dialog')) return 'elicitation_dialog';
  return 'other';
}

/** Normalize InstructionsLoaded loadReason. */
function normalizeLoadReason(raw) {
  const VALID = ['session_start', 'nested_traversal', 'path_glob_match', 'include', 'compact'];
  if (VALID.includes(raw)) return raw;
  return 'session_start';
}

/** Normalize ConfigChange configSource to PARA enum. */
function normalizeConfigSource(raw) {
  const MAP = {
    user: 'user_settings',
    user_settings: 'user_settings',
    project: 'project_settings',
    project_settings: 'project_settings',
    local: 'local_settings',
    local_settings: 'local_settings',
    policy: 'policy_settings',
    policy_settings: 'policy_settings',
    skills: 'skills',
  };
  return MAP[String(raw).toLowerCase()] || 'user_settings';
}

/** Normalize FileChanged changeType. */
function normalizeChangeType(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === 'add' || s === 'created') return 'add';
  if (s === 'remove' || s === 'deleted') return 'remove';
  return 'modify';
}

/** Normalize agent.session.ended reason. */
function normalizeSessionEndReason(raw) {
  const VALID = ['stop', 'crash', 'quota', 'logout', 'other'];
  const s = String(raw || '').toLowerCase();
  if (VALID.includes(s)) return s;
  return 'other';
}

/** Normalize SkillSource from skill name and location. */
function normalizeSkillSource(skillName) {
  // Check if it's a user skill (in ~/.claude/skills/)
  try {
    const { homedir: getHomeDir, existsSync: exists } = require('os');
    const { join } = require('path');
    const userSkillsDir = join(getHomeDir(), '.claude', 'skills');
    const projectSkillsDir = join(process.cwd(), '.claude', 'skills');

    // User skill
    if (exists(join(userSkillsDir, skillName, 'SKILL.md'))) {
      return { kind: 'user' };
    }
    // Project skill
    if (exists(join(projectSkillsDir, skillName, 'SKILL.md'))) {
      return { kind: 'project', workspace: process.cwd() };
    }
  } catch {}
  // Default to bundled (Claude Code built-in skills)
  return { kind: 'bundled', adapter: 'claude-code' };
}

// ─── Agent Descriptor cache ───────────────────────────────────────────────────

/**
 * Load the cached AgentDescriptor, or null if not cached.
 * @returns {{ id: string, adapter: string, version: string, tiersSupported: number[], capabilityTags: string[], workspace: string } | null}
 */
function loadAgentDescriptor() {
  try {
    if (!existsSync(AGENT_DESC_FILE)) return null;
    const raw = readFileSync(AGENT_DESC_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Build and cache a new AgentDescriptor.
 * @returns {{ id: string, adapter: string, version: string, tiersSupported: number[], capabilityTags: string[], workspace: string }}
 */
function buildAndCacheAgentDescriptor(workspace) {
  const descriptor = {
    id: stableAdapterId(workspace),
    adapter: 'claude-code',
    version: getCCVersion(),
    tiersSupported: [1, 2, 3, 7],
    capabilityTags: ['code', 'shell', 'mcp'],
    workspace,
  };
  try {
    mkdirSync(PARA_DIR, { recursive: true, mode: 0o700 });
    // Atomic write: temp + rename to avoid partial-write corruption under concurrent starts.
    const tmp = AGENT_DESC_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(descriptor, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, AGENT_DESC_FILE);
  } catch {
    // Non-fatal
  }
  return descriptor;
}

// ─── Event output ─────────────────────────────────────────────────────────────

/**
 * Validate a PARA event against the schema and write to JSONL sink(s).
 * Wraps each event with a top-level `ts` (epoch ms) field for ordering.
 */
// 50 MB cap — rotate events.jsonl → events.jsonl.1 when exceeded.
const MAX_EVENTS_FILE_SIZE = 50 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    if (existsSync(EVENTS_FILE) && statSync(EVENTS_FILE).size >= MAX_EVENTS_FILE_SIZE) {
      renameSync(EVENTS_FILE, EVENTS_FILE + '.1');
    }
  } catch {
    // non-fatal
  }
}

/**
 * Validate a PARA event against the schema and write to JSONL sink(s).
 * Wraps each event with a top-level `_ts` (epoch ms) field for ordering.
 */
function emitEvent(raw) {
  let validated;
  try {
    validated = ParaEventSchema.parse(raw);
  } catch (e) {
    process.stderr.write(`[para-emit] validation error: ${e.message}\n`);
    return;
  }
  const line = JSON.stringify({ ...validated, _ts: Date.now() }) + '\n';
  try {
    mkdirSync(PARA_DIR, { recursive: true, mode: 0o700 });
    rotateIfNeeded();
    appendFileSync(EVENTS_FILE, line, { encoding: 'utf-8', mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[para-emit] write error: ${e.message}\n`);
  }
  if (process.env.PRISMER_PARA_STDOUT === '1') {
    process.stdout.write(line);
  }
}

// ─── CC Hook → PARA translation ──────────────────────────────────────────────

/**
 * Translate a CC hook payload into PARA event(s) and emit them.
 * @param {string} hookName — CC hook name (e.g. "SessionStart")
 * @param {object} p — parsed CC payload
 */
function translate(hookName, p) {
  const workspace = process.cwd();

  switch (hookName) {
    // ── SessionStart → agent.register (once) + agent.session.started ─────────
    case 'SessionStart': {
      const sid = sessionId(p);
      const cached = loadAgentDescriptor();
      if (!cached) {
        // First start: emit register then started
        const descriptor = buildAndCacheAgentDescriptor(workspace);
        emitEvent(makeRegisterEvent(descriptor));
      }
      // Always emit session.started
      emitEvent(makeSessionStarted({ sessionId: sid, scope: workspace }));
      // If the CC trigger indicates a reset/clear/compact, also emit session.reset
      const triggerRaw = (p.trigger || p.reason || '').toLowerCase();
      if (['clear', 'compact', 'reset'].some((t) => triggerRaw.includes(t))) {
        const reason = triggerRaw.includes('compact') ? 'compact'
          : triggerRaw.includes('clear') ? 'clear'
          : 'reset';
        emitEvent(makeSessionReset({ sessionId: sid, reason }));
      }
      break;
    }

    // ── SessionEnd → agent.session.ended ────────────────────────────────────
    case 'SessionEnd': {
      emitEvent(makeSessionEnded({
        sessionId: sessionId(p),
        reason: normalizeSessionEndReason(p.end_reason || p.reason),
      }));
      break;
    }

    // ── UserPromptSubmit → agent.prompt.submit ───────────────────────────────
    case 'UserPromptSubmit': {
      // Cap prompt at 3800 chars so single-line JSONL stays well under
      // POSIX PIPE_BUF (~4096B) — preserves atomic append guarantee when
      // CC/OpenClaw/Hermes all write to the same events.jsonl.
      const rawPrompt = String(p.prompt || p.message || '');
      const prompt = rawPrompt.length > 3800 ? rawPrompt.slice(0, 3800) + '…[truncated]' : rawPrompt;
      emitEvent(ParaEventSchema.parse({
        type: 'agent.prompt.submit',
        sessionId: sessionId(p),
        prompt,
        source: 'user',
      }));
      break;
    }

    // ── LlmPre → agent.llm.pre ─────────────────────────────────────────────
    // NOTE: Claude Code does not currently provide this hook.
    // This case is a placeholder for future support.
    case 'LlmPre': {
      emitEvent(makeLlmPre({
        sessionId: sessionId(p),
        model: String(p.model || 'unknown'),
        conversationLength: typeof p.conversation_length === 'number' ? p.conversation_length : 0,
        isFirstTurn: Boolean(p.is_first_turn),
      }));
      break;
    }

    // ── LlmPost → agent.llm.post ────────────────────────────────────────────
    // NOTE: Claude Code does not currently provide this hook.
    // This case is a placeholder for future support.
    case 'LlmPost': {
      emitEvent(makeLlmPost({
        sessionId: sessionId(p),
        tokensUsed: typeof p.tokens_used === 'number' ? p.tokens_used : 0,
        stopReason: String(p.stop_reason || 'unknown'),
      }));
      break;
    }

    // ── PreToolUse → agent.tool.pre + agent.skill.activated (Skill only) ─────────
    case 'PreToolUse': {
      const args = safeArgs(p.tool_input || p.input || p.args);
      const toolName = String(p.tool_name || p.tool || 'unknown');
      emitEvent(makeToolPre({
        callId: callId(p),
        tool: toolName,
        args,
        riskTag: normalizeRiskTag(toolName, args),
      }));

      // Emit agent.skill.activated if this is a Skill tool call
      // Claude Code skills are invoked via Skill tool with skill_name parameter
      if (toolName === 'Skill' && p.tool_input?.skill_name) {
        const skillName = String(p.tool_input.skill_name);
        const skillArgs = typeof p.tool_input.args === 'string' ? p.tool_input.args : undefined;
        // Determine trigger type based on how the skill was invoked
        let trigger = 'model-invoke';
        if (p.user_invoked === true || (skillArgs && skillArgs.startsWith('/'))) {
          trigger = 'user-invoke';
        }
        // Determine source
        const source = normalizeSkillSource(skillName);
        emitEvent(makeSkillActivated({
          skillName,
          source,
          trigger,
          args: skillArgs,
        }));
      }
      break;
    }

    // ── PostToolUse → agent.tool.post + agent.turn.step + agent.skill.deactivated (Skill only) ────────────
    case 'PostToolUse': {
      const output = p.tool_response || p.output || '';
      const summary = typeof output === 'string'
        ? output.slice(0, 200)
        : JSON.stringify(output).slice(0, 200);
      emitEvent(makeToolPost({
        callId: callId(p),
        ok: p.success !== false,
        durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : 0,
        summary,
      }));

      // Emit agent.turn.step after each tool call
      // iteration is derived from turn_id if available, otherwise defaults to 0
      const iteration = typeof p.turn_id === 'number' ? p.turn_id : 0;
      const toolName = String(p.tool_name || p.tool || 'unknown');
      emitEvent(makeTurnStep({
        sessionId: sessionId(p),
        iteration,
        toolNames: [toolName],
      }));

      // Emit agent.skill.deactivated after Skill tool completes
      // Skills are scoped to single invocation, deactivate after tool.post
      if (toolName === 'Skill' && p.tool_input?.skill_name) {
        const skillName = String(p.tool_input.skill_name);
        emitEvent(makeSkillDeactivated({
          skillName,
          reason: 'explicit',
        }));
      }
      break;
    }

    // ── PostToolUseFailure → agent.tool.failure ──────────────────────────────
    case 'PostToolUseFailure': {
      emitEvent(makeToolFailure({
        callId: callId(p),
        error: String(p.error || p.message || 'unknown error'),
        signalPattern: typeof p.signal_pattern === 'string' ? p.signal_pattern : undefined,
        isInterrupt: typeof p.is_interrupt === 'boolean' ? p.is_interrupt : undefined,
      }));
      break;
    }

    // ── PermissionRequest → agent.approval.request ───────────────────────────
    case 'PermissionRequest': {
      emitEvent(makeApprovalRequest({
        callId: callId(p),
        prompt: String(p.prompt || p.message || ''),
        ttlMs: typeof p.ttl_ms === 'number' ? p.ttl_ms : 30000,
        permissionSuggestions: Array.isArray(p.permission_suggestions) ? p.permission_suggestions : undefined,
      }));
      break;
    }

    // ── PermissionDenied → agent.approval.denied ─────────────────────────────
    case 'PermissionDenied': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.approval.denied',
        callId: callId(p),
        reason: String(p.reason || p.message || 'denied'),
        retry: p.retry !== false,
      }));
      break;
    }

    // ── SubagentStart → agent.subagent.started ───────────────────────────────
    case 'SubagentStart': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.subagent.started',
        agentId: String(p.subagent_id || p.agent_id || generateId()),
        parentAgentId: String(p.parent_agent_id || stableAdapterId(workspace)),
        subagentType: String(p.subagent_type || p.type || 'subagent'),
      }));
      break;
    }

    // ── SubagentStop → agent.subagent.ended ──────────────────────────────────
    case 'SubagentStop': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.subagent.ended',
        agentId: String(p.subagent_id || p.agent_id || generateId()),
        reason: String(p.reason || p.end_reason || 'stopped'),
        transcriptPath: typeof p.transcript_path === 'string' ? p.transcript_path : undefined,
      }));
      break;
    }

    // ── TaskCreated → agent.task.created ─────────────────────────────────────
    case 'TaskCreated': {
      emitEvent(makeTaskCreated({
        taskId: String(p.task_id || p.id || generateId()),
        subject: String(p.subject || p.title || p.description || 'task'),
        description: typeof p.description === 'string' ? p.description : undefined,
        teammateName: typeof p.teammate_name === 'string' ? p.teammate_name : undefined,
        teamName: typeof p.team_name === 'string' ? p.team_name : undefined,
      }));
      break;
    }

    // ── TaskCompleted → agent.task.completed ──────────────────────────────────
    case 'TaskCompleted': {
      const status = ['completed', 'failed', 'cancelled'].includes(p.status)
        ? p.status
        : 'completed';
      emitEvent(makeTaskCompleted({
        taskId: String(p.task_id || p.id || generateId()),
        subject: String(p.subject || p.title || 'task'),
        status,
      }));
      break;
    }

    // ── TeammateIdle → agent.teammate.idle ───────────────────────────────────
    case 'TeammateIdle': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.teammate.idle',
        teammateName: String(p.teammate_name || p.name || 'unknown'),
        teamName: typeof p.team_name === 'string' ? p.team_name : undefined,
      }));
      break;
    }

    // ── Stop → agent.turn.end ────────────────────────────────────────────────
    case 'Stop': {
      emitEvent(makeTurnEnd({
        sessionId: sessionId(p),
        lastAssistantMessage: typeof p.last_assistant_message === 'string'
          ? p.last_assistant_message.slice(0, 500)
          : undefined,
      }));
      break;
    }

    // ── StopFailure → agent.turn.failure ────────────────────────────────────
    case 'StopFailure': {
      emitEvent(makeTurnFailure({
        sessionId: sessionId(p),
        errorType: normalizeErrorType(p.error_type || p.type),
        errorMessage: String(p.error_message || p.message || p.error || 'unknown'),
      }));
      break;
    }

    // ── Notification → agent.notification ───────────────────────────────────
    case 'Notification': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.notification',
        notificationType: normalizeNotificationType(p.notification_type || p.type),
        message: String(p.message || p.body || ''),
        title: typeof p.title === 'string' ? p.title : undefined,
      }));
      break;
    }

    // ── InstructionsLoaded → agent.instructions.loaded ───────────────────────
    case 'InstructionsLoaded': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.instructions.loaded',
        filePath: String(p.file_path || p.path || ''),
        memoryType: String(p.memory_type || p.type || 'project'),
        loadReason: normalizeLoadReason(p.load_reason || p.reason),
      }));
      break;
    }

    // ── ConfigChange → agent.config.changed ──────────────────────────────────
    case 'ConfigChange': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.config.changed',
        configSource: normalizeConfigSource(p.config_source || p.source),
        changedValues: p.changed_values || p.changes || undefined,
      }));
      break;
    }

    // ── CwdChanged → agent.cwd.changed ───────────────────────────────────────
    case 'CwdChanged': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.cwd.changed',
        oldCwd: String(p.old_cwd || p.from || ''),
        newCwd: String(p.new_cwd || p.to || workspace),
      }));
      break;
    }

    // ── FileChanged → agent.file.watched ─────────────────────────────────────
    case 'FileChanged': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.file.watched',
        filePath: String(p.file_path || p.path || ''),
        changeType: normalizeChangeType(p.change_type || p.type),
      }));
      break;
    }

    // ── WorktreeCreate → agent.worktree.created ──────────────────────────────
    case 'WorktreeCreate': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.worktree.created',
        worktreePath: String(p.worktree_path || p.path || ''),
        branch: typeof p.branch === 'string' ? p.branch : undefined,
      }));
      break;
    }

    // ── WorktreeRemove → agent.worktree.removed ──────────────────────────────
    case 'WorktreeRemove': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.worktree.removed',
        worktreePath: String(p.worktree_path || p.path || ''),
      }));
      break;
    }

    // ── PreCompact → agent.compact.pre ───────────────────────────────────────
    case 'PreCompact': {
      emitEvent(makeCompactPre({
        sessionId: sessionId(p),
        trigger: p.trigger === 'manual' ? 'manual' : 'auto',
        messageCount: typeof p.message_count === 'number' ? p.message_count : 0,
        tokenCount: typeof p.token_count === 'number' ? p.token_count : 0,
      }));
      break;
    }

    // ── PostCompact → agent.compact.post ─────────────────────────────────────
    case 'PostCompact': {
      emitEvent(makeCompactPost({
        sessionId: sessionId(p),
        compactedCount: typeof p.compacted_count === 'number' ? p.compacted_count : 0,
        tokensBefore: typeof p.tokens_before === 'number' ? p.tokens_before : 0,
        tokensAfter: typeof p.tokens_after === 'number' ? p.tokens_after : 0,
      }));
      break;
    }

    // ── Elicitation → agent.elicitation.request ──────────────────────────────
    case 'Elicitation': {
      emitEvent(ParaEventSchema.parse({
        type: 'agent.elicitation.request',
        serverName: String(p.server_name || p.serverName || 'unknown'),
        requestId: String(p.request_id || p.requestId || generateId()),
        formSchema: p.form_schema || p.schema || {},
      }));
      break;
    }

    // ── ElicitationResult → agent.elicitation.result ─────────────────────────
    case 'ElicitationResult': {
      const action = ['accept', 'decline', 'cancel'].includes(p.action) ? p.action : 'cancel';
      emitEvent(ParaEventSchema.parse({
        type: 'agent.elicitation.result',
        serverName: String(p.server_name || p.serverName || 'unknown'),
        requestId: String(p.request_id || p.requestId || generateId()),
        action,
        content: p.content !== undefined ? p.content : undefined,
      }));
      break;
    }

    default: {
      process.stderr.write(`[para-emit] unknown CC hook: ${hookName}\n`);
    }
  }
}

/** Heuristic risk classification (mirrors adapters-core/normalize.ts). */
function normalizeRiskTag(toolName, args) {
  const name = toolName.toLowerCase();
  if (['read', 'glob', 'grep', 'ls'].includes(name)) return 'low';
  if (['edit', 'write', 'notebookedit'].includes(name)) return 'mid';
  if (name === 'bash') {
    const argsStr = typeof args === 'string' ? args : JSON.stringify(args ?? '');
    if (/\brm\b|\bcurl\b|\bsudo\b|\bwget\b|\bchmod\b|\bchown\b/.test(argsStr)) return 'high';
    return 'mid';
  }
  return 'mid';
}

// ─── Evolution script delegation ─────────────────────────────────────────────────
/**
 * Delegate to Evolution scripts for events that have business logic.
 * This runs Evolution hooks in the background, non-blocking.
 *
 * Evolution scripts:
 * - SessionStart → session-start.mjs (sync pull, context injection, MCP pre-warm)
 * - SessionEnd → session-end.mjs (evolution push, cleanup)
 * - Stop → session-stop.mjs (mark session complete)
 * - PreToolUse → pre-bash-suggest.mjs (Bash only) + pre-web-cache.mjs (WebFetch only)
 * - PostToolUse → post-bash-journal.mjs (Bash/Edit/Write) + post-web-save.mjs (WebFetch/WebSearch)
 * - PostToolUseFailure → post-tool-failure.mjs (Bash/Edit/Write)
 * - SubagentStart → subagent-start.mjs
 */

function delegateToEvolution(hookName, payload) {
  try {
    const pluginRoot = join(__dirname, '..');
    const scriptsDir = join(pluginRoot, 'scripts');
    let scriptName = null;

    switch (hookName) {
      case 'SessionStart':
        scriptName = 'session-start.mjs';
        break;
      case 'SessionEnd':
        scriptName = 'session-end.mjs';
        break;
      case 'Stop':
        scriptName = 'session-stop.mjs';
        break;
      case 'SubagentStart':
        scriptName = 'subagent-start.mjs';
        break;
      case 'PostToolUseFailure':
        scriptName = 'post-tool-failure.mjs';
        break;
      case 'PreToolUse': {
        const toolName = String(payload.tool_name || payload.tool || '');
        if (toolName === 'Bash') {
          scriptName = 'pre-bash-suggest.mjs';
        } else if (toolName === 'WebFetch') {
          scriptName = 'pre-web-cache.mjs';
        }
        break;
      }
      case 'PostToolUse': {
        const toolName = String(payload.tool_name || payload.tool || '');
        if (['Bash', 'Edit', 'Write'].includes(toolName)) {
          scriptName = 'post-bash-journal.mjs';
        } else if (['WebFetch', 'WebSearch'].includes(toolName)) {
          scriptName = 'post-web-save.mjs';
        }
        break;
      }
      default:
        return; // No Evolution script for this event
    }

    if (!scriptName) return;

    const scriptPath = join(scriptsDir, scriptName);

    // Spawn Evolution script in background, non-blocking
    // Pass the original payload via stdin
    const child = spawn('node', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    // Write payload to stdin
    if (payload && Object.keys(payload).length > 0) {
      child.stdin.write(JSON.stringify(payload));
    }
    child.stdin.end();

    // Don't wait for completion - let it run in background
    child.unref();
  } catch (e) {
    // Non-fatal: Evolution delegation failure shouldn't break PARA
    process.stderr.write(`[para-emit] evolution delegation failed for ${hookName}: ${e.message}\n`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const hookName = process.argv[2];
  if (!hookName) {
    process.stderr.write('[para-emit] usage: node para-emit.mjs <CCHookName>\n');
    process.exit(0);
  }

  // Read stdin (CC passes the hook payload as JSON)
  let raw = '';
  try {
    for await (const chunk of process.stdin) {
      raw += chunk;
    }
  } catch {
    process.exit(0);
  }

  let payload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(`[para-emit] stdin JSON parse error: ${e.message}\n`);
      process.exit(0);
    }
  }

  try {
    // First: translate to PARA events
    translate(hookName, payload);
    // Then: delegate to Evolution scripts (non-blocking)
    delegateToEvolution(hookName, payload);
  } catch (e) {
    process.stderr.write(`[para-emit] translation error for ${hookName}: ${e.message}\n`);
  }

  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[para-emit] unhandled error: ${e.message}\n`);
  process.exit(0);
});
