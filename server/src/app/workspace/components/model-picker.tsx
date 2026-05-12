'use client';

/**
 * ModelPicker — fetches the curated model list from /api/models and renders a
 * styled `<select>` dropdown for model selection.
 *
 * States:
 *   Loading → disabled "Loading models…" option
 *   Error   → disabled "Models unavailable" + fallback to hardcoded pair
 *   Empty   → disabled "No models available" + fallback
 *   OK      → normal select with curated model list
 */

import { useEffect, useState } from 'react';

export interface ModelOption {
  id: string;
  name: string;
}

interface ModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  /** When true, adds a "Custom…" option with a text input for free-form model IDs. */
  allowCustom?: boolean;
  className?: string;
  disabled?: boolean;
}

const FALLBACK_MODELS: ModelOption[] = [
  { id: 'us-kimi-k2.6', name: 'Kimi K2.6' },
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
];

export function ModelPicker({
  value,
  onChange,
  allowCustom = false,
  className = '',
  disabled = false,
}: ModelPickerProps) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customValue, setCustomValue] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/models')
      .then((res) => (res.ok ? res.json() : Promise.reject(String(res.status))))
      .then((body) => {
        if (cancelled) return;
        const items: ModelOption[] = (body.data ?? [])
          .filter((m: { id: unknown; owned_by?: unknown }) => m.id && typeof m.id === 'string')
          .map((m: { id: string }) => ({ id: m.id, name: m.id }));
        setModels(items.length > 0 ? items : FALLBACK_MODELS);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
        setModels(FALLBACK_MODELS);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When custom is active sync the text input value upward.
  useEffect(() => {
    if (showCustomInput && customValue) onChange(customValue);
  }, [customValue, showCustomInput, onChange]);

  const isCustomSelected = showCustomInput || (value && !models.some((m) => m.id === value));

  function handleSelect(e: React.ChangeEvent<HTMLSelectElement>) {
    const selected = e.target.value;
    if (selected === '__custom__') {
      setShowCustomInput(true);
      if (customValue) onChange(customValue);
    } else {
      setShowCustomInput(false);
      onChange(selected);
    }
  }

  const resolvedValue = showCustomInput ? '__custom__' : value;

  return (
    <div className={`grid gap-1 ${className}`}>
      {allowCustom && isCustomSelected && !showCustomInput ? (
        // Existing value is a custom (non-listed) model — show input directly
        <input
          className={`h-10 rounded-2xl border px-3 text-sm outline-none disabled:opacity-50 ${
            disabled ? 'cursor-not-allowed' : ''
          }`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter model ID…"
          disabled={disabled}
        />
      ) : showCustomInput ? (
        <div className="grid gap-1">
          <div className="flex items-center gap-2">
            <select
              value="__custom__"
              onChange={handleSelect}
              disabled={disabled || loading}
              className={`h-10 flex-1 rounded-2xl border px-3 text-sm outline-none disabled:opacity-50 ${
                disabled ? 'cursor-not-allowed' : ''
              }`}
            >
              <option value="__custom__">Custom model…</option>
            </select>
          </div>
          <input
            className={`h-10 rounded-2xl border px-3 text-sm outline-none disabled:opacity-50 ${
              disabled ? 'cursor-not-allowed' : ''
            }`}
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            placeholder="Enter model ID…"
            disabled={disabled}
          />
        </div>
      ) : loading ? (
        <select
          disabled
          className={`h-10 rounded-2xl border px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        >
          <option>Loading models…</option>
        </select>
      ) : error && models.length === 0 ? (
        <select
          disabled
          className={`h-10 rounded-2xl border px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        >
          <option>Models unavailable</option>
        </select>
      ) : (
        <select
          value={resolvedValue}
          onChange={handleSelect}
          disabled={disabled}
          className={`h-10 rounded-2xl border px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        >
          {models.length === 0 ? (
            <option value="" disabled>
              No models available
            </option>
          ) : (
            models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))
          )}
          {allowCustom ? <option value="__custom__">Custom model…</option> : null}
        </select>
      )}
    </div>
  );
}
