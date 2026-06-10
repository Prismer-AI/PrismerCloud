'use client';

/**
 * release201/10 rev 2 §8.6 — TaskCriteriaEditor
 *
 * Shared editor for the "Acceptance criteria" list on:
 *   - new-task-dialog (pre-create draft list, written on submit)
 *   - task-detail-drawer (post-create live list, mutates via API)
 *
 * The component is dumb about API calls — it owns the in-memory criteria
 * draft and emits onChange. The container decides whether to PATCH on
 * each change or batch on submit.
 *
 * rev 2 changes:
 *   - DROP `kind` (boolean/numeric/text-match)
 *   - DROP `verifierConfig` (cloud does NOT pre-bake verifier methods)
 *   - REPLACE `verifierKind` (3 class) → `verifyMode` (4 class)
 *   - REPLACE `description` → `expectation` (markdown — what done looks like)
 *   - ADD `verifierAgentId` (workspace agents selector; null = default to creator)
 */

import { useId, useState } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

export type CriterionVerifyMode = 'qualitative' | 'quantitative' | 'agent-self-check' | 'manual';

export interface CriterionDraft {
  // id is optional in editor — drawer mode passes the server id, dialog mode lets server assign
  id?: string;
  verifyMode: CriterionVerifyMode;
  expectation: string;
  verifierAgentId?: string | null;
  required?: boolean;
  weight?: number;
}

export interface WorkspaceAgentOption {
  id: string;
  displayName: string;
}

export interface TaskCriteriaEditorProps {
  isDark: boolean;
  value: CriterionDraft[];
  onChange: (next: CriterionDraft[]) => void;
  /** Show the "Use template" select header (dialog mode). */
  templateSelector?: React.ReactNode;
  /** Hide the per-row controls (read-only preview). */
  readOnly?: boolean;
  /** Small label above the list. */
  title?: string;
  /** Optional workspace agents list for the verifier-agent picker. */
  workspaceAgents?: WorkspaceAgentOption[];
}

const VERIFY_MODE_OPTIONS: { value: CriterionVerifyMode; label: string; hint: string }[] = [
  {
    value: 'qualitative',
    label: 'Qualitative',
    hint: 'Verifier agent picks a method at runtime (Playwright / LLM-judge / human eyeball).',
  },
  {
    value: 'quantitative',
    label: 'Quantitative',
    hint: 'Verifier agent runs a real measurement and compares against a threshold.',
  },
  {
    value: 'agent-self-check',
    label: 'Agent self-check',
    hint: 'Assignee self-evaluates before status=review. No external verifier.',
  },
  {
    value: 'manual',
    label: 'Manual',
    hint: 'Human reviewer ticks the box in the ApprovalCard.',
  },
];

export function TaskCriteriaEditor({
  isDark,
  value,
  onChange,
  templateSelector,
  readOnly,
  title,
  workspaceAgents,
}: TaskCriteriaEditorProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set([0]));

  function toggle(idx: number) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function addCriterion() {
    onChange([
      ...value,
      {
        verifyMode: 'manual',
        expectation: '',
        verifierAgentId: null,
        required: true,
        weight: 1,
      },
    ]);
    setExpanded((s) => new Set([...Array.from(s), value.length]));
  }

  function update(idx: number, patch: Partial<CriterionDraft>) {
    onChange(value.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }

  function removeAt(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  const inputClass = `w-full rounded-md border px-2 py-1 text-xs outline-none focus:ring-1 ${
    isDark
      ? 'bg-zinc-900 border-white/10 text-zinc-100 focus:ring-violet-500/40'
      : 'bg-white border-zinc-300 text-zinc-900 focus:ring-violet-400'
  }`;
  const labelClass = `text-[11px] font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`;

  return (
    <div
      className={`rounded-2xl border p-3 ${isDark ? 'border-white/10 bg-white/[0.03]' : 'border-zinc-200 bg-zinc-50'}`}
    >
      {title ? (
        <div className={`mb-2 text-xs font-semibold ${isDark ? 'text-zinc-200' : 'text-zinc-800'}`}>{title}</div>
      ) : null}
      {templateSelector ? <div className="mb-2">{templateSelector}</div> : null}
      <div className="space-y-2">
        {value.map((c, idx) => {
          const isOpen = expanded.has(idx);
          return (
            <div
              key={idx}
              className={`rounded-lg border ${isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-200 bg-white'}`}
            >
              <div className="flex items-center gap-2 px-2 py-1.5">
                <button
                  type="button"
                  className="text-zinc-500 hover:text-zinc-900"
                  onClick={() => toggle(idx)}
                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                  data-testid={`criterion-toggle-${idx}`}
                >
                  {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
                <div className="flex-1 truncate text-xs">
                  {c.expectation || <span className="italic text-zinc-500">(empty expectation)</span>}
                  <span
                    className={`ml-2 inline-flex rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                      isDark ? 'bg-white/10 text-zinc-300' : 'bg-zinc-100 text-zinc-600'
                    }`}
                  >
                    {c.verifyMode}
                  </span>
                </div>
                {readOnly ? null : (
                  <button
                    type="button"
                    onClick={() => removeAt(idx)}
                    className="text-rose-500 hover:text-rose-600"
                    aria-label="Remove criterion"
                    data-testid={`criterion-remove-${idx}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {isOpen ? (
                <CriterionFields
                  c={c}
                  idx={idx}
                  inputClass={inputClass}
                  labelClass={labelClass}
                  readOnly={readOnly}
                  onUpdate={(patch) => update(idx, patch)}
                  workspaceAgents={workspaceAgents}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {readOnly ? null : (
        <button
          type="button"
          onClick={addCriterion}
          className={`mt-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
            isDark
              ? 'border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]'
              : 'border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50'
          }`}
          data-testid="criterion-add"
        >
          <Plus className="h-3.5 w-3.5" /> Add criterion
        </button>
      )}
    </div>
  );
}

interface CriterionFieldsProps {
  c: CriterionDraft;
  idx: number;
  inputClass: string;
  labelClass: string;
  readOnly?: boolean;
  onUpdate: (patch: Partial<CriterionDraft>) => void;
  workspaceAgents?: WorkspaceAgentOption[];
}

function CriterionFields({
  c,
  idx,
  inputClass,
  labelClass,
  readOnly,
  onUpdate,
  workspaceAgents,
}: CriterionFieldsProps) {
  const ids = {
    expectation: useId(),
    mode: useId(),
    verifier: useId(),
  };

  const activeMode = VERIFY_MODE_OPTIONS.find((m) => m.value === c.verifyMode);

  return (
    <div className="grid gap-2 px-3 pb-3 pt-1">
      <label className="grid gap-1" htmlFor={ids.expectation}>
        <span className={labelClass}>Expectation (markdown — what done looks like)</span>
        <textarea
          id={ids.expectation}
          className={`${inputClass} min-h-[60px] resize-y`}
          value={c.expectation}
          onChange={(e) => onUpdate({ expectation: e.target.value })}
          readOnly={readOnly}
          data-testid={`criterion-expectation-${idx}`}
          placeholder="e.g. p99 latency < 50ms over 1000 random queries"
        />
      </label>
      <div className="grid gap-2">
        <label className="grid gap-1" htmlFor={ids.mode}>
          <span className={labelClass}>Verify mode</span>
          <select
            id={ids.mode}
            className={inputClass}
            value={c.verifyMode}
            onChange={(e) => onUpdate({ verifyMode: e.target.value as CriterionVerifyMode })}
            disabled={readOnly}
            data-testid={`criterion-mode-${idx}`}
          >
            {VERIFY_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {activeMode ? <span className={`text-[10px] ${labelClass}`}>{activeMode.hint}</span> : null}
        </label>
        {c.verifyMode === 'qualitative' || c.verifyMode === 'quantitative' ? (
          <label className="grid gap-1" htmlFor={ids.verifier}>
            <span className={labelClass}>Verifier agent (default = task creator)</span>
            {workspaceAgents && workspaceAgents.length > 0 ? (
              <select
                id={ids.verifier}
                className={inputClass}
                value={c.verifierAgentId ?? ''}
                onChange={(e) => onUpdate({ verifierAgentId: e.target.value || null })}
                disabled={readOnly}
                data-testid={`criterion-verifier-${idx}`}
              >
                <option value="">— default to creator —</option>
                {workspaceAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName} ({a.id})
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={ids.verifier}
                type="text"
                className={inputClass}
                value={c.verifierAgentId ?? ''}
                onChange={(e) => onUpdate({ verifierAgentId: e.target.value || null })}
                readOnly={readOnly}
                placeholder="agent_xxx (leave empty for creator default)"
              />
            )}
          </label>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <label className="inline-flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={c.required !== false}
            onChange={(e) => onUpdate({ required: e.target.checked })}
            disabled={readOnly}
            data-testid={`criterion-required-${idx}`}
          />
          <span className={labelClass}>Required</span>
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs">
          <span className={labelClass}>Weight (v2.1 reserve)</span>
          <input
            type="number"
            className={`${inputClass} max-w-[60px]`}
            min={0}
            step={1}
            value={c.weight ?? 1}
            onChange={(e) => onUpdate({ weight: Number(e.target.value) })}
            readOnly={readOnly}
            disabled
          />
        </label>
      </div>
    </div>
  );
}
