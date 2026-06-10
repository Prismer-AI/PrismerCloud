'use client';

/**
 * release201/10 §8.7 — Minimal admin UI for IMTaskCriteriaTemplate CRUD.
 *
 * Lists global + workspace templates. Edits via /api/im/criteria-templates.
 * Permission gating already enforced server-side (workspace owner / admin);
 * this page is just a thin shell for ops + advanced workspace owners.
 */

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, Save } from 'lucide-react';

interface CriteriaTemplate {
  id: string;
  workspaceId: string | null;
  capability: string;
  name: string;
  description: string | null;
  criteria: Array<{
    verifyMode: 'qualitative' | 'quantitative' | 'agent-self-check' | 'manual';
    expectation: string;
    verifierAgentId?: string | null;
    required?: boolean;
    weight?: number;
  }>;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export default function CriteriaTemplatesAdminPage() {
  const [rows, setRows] = useState<CriteriaTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<CriteriaTemplate | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/im/criteria-templates', { credentials: 'include' });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: CriteriaTemplate[] };
      if (body.ok) setRows(body.data ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function remove(id: string) {
    if (!window.confirm(`Delete template ${id}?`)) return;
    await fetch(`/api/im/criteria-templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    void reload();
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Acceptance Criteria Templates</h1>
          <p className="mt-1 text-sm text-zinc-600">
            Manage global (built-in) and workspace-level acceptance criteria templates. New tasks created with a
            matching capability automatically apply the default template.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-50"
            onClick={() => void reload()}
          >
            <RefreshCw className="h-4 w-4" /> Reload
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-sm text-white hover:bg-violet-700"
            onClick={() => setCreating(true)}
          >
            <Plus className="h-4 w-4" /> New template
          </button>
        </div>
      </header>

      {loading && rows.length === 0 ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-zinc-500">
              <th className="py-2 pr-2">Scope</th>
              <th className="py-2 pr-2">Capability</th>
              <th className="py-2 pr-2">Name</th>
              <th className="py-2 pr-2">Criteria</th>
              <th className="py-2 pr-2">Default</th>
              <th className="py-2 pr-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-b hover:bg-zinc-50">
                <td className="py-2 pr-2 text-xs">{t.workspaceId ? t.workspaceId.slice(0, 8) : <em>global</em>}</td>
                <td className="py-2 pr-2 font-mono text-xs">{t.capability}</td>
                <td className="py-2 pr-2">{t.name}</td>
                <td className="py-2 pr-2 text-xs text-zinc-600">{t.criteria.length}</td>
                <td className="py-2 pr-2">{t.isDefault ? '✓' : ''}</td>
                <td className="py-2 pr-2 flex items-center gap-2">
                  <button className="text-xs text-violet-700 hover:underline" onClick={() => setEditing(t)}>
                    Edit
                  </button>
                  <button
                    className="text-rose-600 hover:text-rose-700"
                    onClick={() => void remove(t.id)}
                    title="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-6 text-center text-sm italic text-zinc-500">
                  No templates yet. Click &quot;New template&quot; to add one.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}

      {creating ? (
        <TemplateEditor
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void reload();
          }}
        />
      ) : null}
      {editing ? (
        <TemplateEditor
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

interface TemplateEditorProps {
  existing?: CriteriaTemplate;
  onClose: () => void;
  onSaved: () => void;
}

function TemplateEditor({ existing, onClose, onSaved }: TemplateEditorProps) {
  const [name, setName] = useState(existing?.name ?? '');
  const [capability, setCapability] = useState(existing?.capability ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);
  const [criteriaJson, setCriteriaJson] = useState(
    existing
      ? JSON.stringify(existing.criteria, null, 2)
      : '[\n  {"verifyMode":"manual","expectation":"","verifierAgentId":null,"required":true,"weight":1}\n]',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setError(null);
    let criteria: unknown;
    try {
      criteria = JSON.parse(criteriaJson);
    } catch (err) {
      setError(`criteria JSON invalid: ${(err as Error).message}`);
      return;
    }
    if (!Array.isArray(criteria) || criteria.length === 0) {
      setError('criteria must be a non-empty array');
      return;
    }
    setSaving(true);
    const url = existing
      ? `/api/im/criteria-templates/${encodeURIComponent(existing.id)}`
      : '/api/im/criteria-templates';
    const method = existing ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, capability, description, isDefault, criteria }),
    });
    setSaving(false);
    if (!res.ok) {
      setError(`Save failed (${res.status})`);
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-lg">
        <h2 className="mb-3 text-lg font-bold">{existing ? 'Edit template' : 'New template'}</h2>
        <div className="grid gap-3">
          <label className="grid gap-1 text-xs">
            <span className="font-medium">Name</span>
            <input
              className="rounded-md border px-2 py-1 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="font-medium">Capability</span>
            <input
              className="rounded-md border px-2 py-1 text-sm"
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
              placeholder="general | skill-tryout | ..."
            />
          </label>
          <label className="grid gap-1 text-xs">
            <span className="font-medium">Description</span>
            <textarea
              className="rounded-md border px-2 py-1 text-sm"
              rows={2}
              value={description ?? ''}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="inline-flex items-center gap-2 text-xs">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            <span className="font-medium">Default for capability</span>
          </label>
          <label className="grid gap-1 text-xs">
            <span className="font-medium">Criteria (JSON array)</span>
            <textarea
              className="rounded-md border px-2 py-1 font-mono text-xs"
              rows={10}
              value={criteriaJson}
              onChange={(e) => setCriteriaJson(e.target.value)}
            />
          </label>
          {error ? <p className="text-xs text-rose-600">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button className="rounded-md border px-3 py-1.5 text-sm" onClick={onClose}>
              Cancel
            </button>
            <button
              className="inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-sm text-white"
              onClick={() => void save()}
              disabled={saving}
            >
              <Save className="h-4 w-4" /> Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
