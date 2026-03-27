'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { X } from 'lucide-react';

const COMMON_SIGNALS = [
  'error:timeout',
  'error:connection_refused',
  'error:rate_limit',
  'error:auth_error',
  'error:server_error',
  'error:dns_error',
  'error:type_error',
  'error:syntax_error',
  'error:oom',
  'error:crash',
  'task.failed',
  'task.completed',
] as const;

interface SignalTag {
  type: string;
  provider?: string;
}

interface SignalInputProps {
  value: SignalTag[];
  onChange: (signals: SignalTag[]) => void;
  isDark: boolean;
  placeholder?: string;
}

export function SignalInput({
  value,
  onChange,
  isDark,
  placeholder = 'Type a signal or pick from suggestions...',
}: SignalInputProps) {
  const [inputText, setInputText] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter suggestions: exclude already-added signals, match typed text
  const existingTypes = new Set(value.map((s) => s.type));
  const filtered = COMMON_SIGNALS.filter(
    (s) => !existingTypes.has(s) && s.toLowerCase().includes(inputText.toLowerCase()),
  );

  // Reset highlighted index when filtered list changes
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [inputText]);

  // Close suggestions on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const addSignal = useCallback(
    (type: string) => {
      const trimmed = type.trim();
      if (!trimmed) return;
      // Prevent duplicates
      if (value.some((s) => s.type === trimmed)) return;
      onChange([...value, { type: trimmed }]);
      setInputText('');
      setShowSuggestions(false);
      inputRef.current?.focus();
    },
    [value, onChange],
  );

  const removeSignal = useCallback(
    (index: number) => {
      onChange(value.filter((_, i) => i !== index));
    },
    [value, onChange],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && highlightedIndex < filtered.length) {
        addSignal(filtered[highlightedIndex]);
      } else if (inputText.trim()) {
        addSignal(inputText);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setShowSuggestions(true);
      setHighlightedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
      setHighlightedIndex(-1);
    } else if (e.key === 'Backspace' && !inputText && value.length > 0) {
      // Remove last tag on backspace when input is empty
      removeSignal(value.length - 1);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      {/* Tags + Input area */}
      <div
        className={`flex flex-wrap gap-1.5 p-2 rounded-lg min-h-[42px] cursor-text transition-colors ${
          isDark
            ? 'bg-zinc-900/60 border border-zinc-700 focus-within:border-violet-500'
            : 'bg-white/80 border border-zinc-300 focus-within:border-violet-500'
        }`}
        onClick={() => inputRef.current?.focus()}
      >
        {/* Signal tags */}
        {value.map((signal, i) => (
          <span
            key={`${signal.type}-${i}`}
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors ${
              isDark
                ? 'bg-violet-500/15 text-violet-300 border border-violet-500/20'
                : 'bg-violet-100 text-violet-700 border border-violet-200'
            }`}
          >
            {signal.type}
            {signal.provider && (
              <span className={isDark ? 'text-violet-400/60' : 'text-violet-500/60'}>@{signal.provider}</span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeSignal(i);
              }}
              className={`ml-0.5 rounded-sm p-0.5 transition-colors ${
                isDark ? 'hover:bg-violet-500/30 text-violet-400' : 'hover:bg-violet-200 text-violet-500'
              }`}
              aria-label={`Remove ${signal.type}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}

        {/* Text input */}
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => {
            setInputText(e.target.value);
            setShowSuggestions(true);
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : 'Add signal...'}
          className={`flex-1 min-w-[120px] bg-transparent outline-none text-sm py-0.5 ${
            isDark ? 'text-zinc-200 placeholder:text-zinc-600' : 'text-zinc-800 placeholder:text-zinc-400'
          }`}
        />
      </div>

      {/* Suggestions dropdown */}
      {showSuggestions && filtered.length > 0 && (
        <div
          className={`absolute z-50 left-0 right-0 mt-1 rounded-lg overflow-hidden shadow-lg max-h-[200px] overflow-y-auto ${
            isDark ? 'bg-zinc-900 border border-zinc-700' : 'bg-white border border-zinc-200'
          }`}
        >
          {filtered.map((signal, i) => (
            <button
              key={signal}
              type="button"
              onClick={() => addSignal(signal)}
              onMouseEnter={() => setHighlightedIndex(i)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                i === highlightedIndex
                  ? isDark
                    ? 'bg-violet-500/15 text-violet-300'
                    : 'bg-violet-50 text-violet-700'
                  : isDark
                    ? 'text-zinc-300 hover:bg-white/[0.04]'
                    : 'text-zinc-700 hover:bg-zinc-50'
              }`}
            >
              <span className="font-mono text-xs">{signal}</span>
            </button>
          ))}
        </div>
      )}

      {/* Hint text */}
      {!showSuggestions && value.length === 0 && (
        <p className={`text-xs mt-1.5 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
          Press Enter to add custom signals, or click to see suggestions
        </p>
      )}
    </div>
  );
}
