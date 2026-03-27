'use client';

import { useState } from 'react';
import { FileText, Loader2, Zap, Link, Search, PanelLeftClose, ChevronDown, ChevronRight, Settings } from 'lucide-react';
import { Strategy } from '@/types';
import { useTheme } from '@/contexts/theme-context';
import { GradientCard } from './gradient-card';

type ReturnFormat = 'hqcc' | 'raw' | 'both';

interface Preset {
  label: string;
  url: string;
  strategy: Strategy;
}

interface ConfigurationPanelProps {
  url: string;
  setUrl: (url: string) => void;
  strategy: Strategy;
  setStrategy: (strategy: Strategy) => void;
  isProcessing: boolean;
  loadingProgress: number;
  hasResult: boolean;
  onSubmit: () => void;
  onCollapse: () => void;
  onApplyPreset: (preset: Preset) => void;
  presets: Preset[];
  returnFormat?: ReturnFormat;
  setReturnFormat?: (format: ReturnFormat) => void;
  topK?: number;
  setTopK?: (topK: number) => void;
  useAutoprompt?: boolean;
  setUseAutoprompt?: (v: boolean) => void;
}

// Helper to detect if input is a valid URL
function isValidUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function ConfigurationPanel({
  url,
  setUrl,
  strategy,
  setStrategy,
  isProcessing,
  loadingProgress,
  hasResult,
  onSubmit,
  onCollapse,
  onApplyPreset,
  presets,
  returnFormat,
  setReturnFormat,
  topK,
  setTopK,
  useAutoprompt,
  setUseAutoprompt,
}: ConfigurationPanelProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const inputIsUrl = isValidUrl(url);
  const isQuery = url.trim() !== '' && !inputIsUrl;
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <GradientCard gradientFrom="#41086D" gradientTo="#5622E5" isDark={isDark}>
      <div className={`relative z-20 backdrop-blur-xl border rounded-2xl sm:rounded-3xl p-4 sm:p-6 shadow-2xl transition-all duration-500 ease-out group-hover:translate-x-[-6px] ${
        isDark 
          ? 'bg-zinc-900/50 border-white/10 group-hover:bg-zinc-900/70 group-hover:border-white/20 group-hover:shadow-[0_0_40px_rgba(124,58,237,0.15)]' 
          : 'bg-white/80 border-violet-200/50 group-hover:bg-white/90 group-hover:border-violet-300/50 group-hover:shadow-[0_0_40px_rgba(124,58,237,0.1)]'
      }`}>
        {/* Header with Collapse Button */}
        <div className="flex items-center justify-between mb-4 sm:mb-6">
          <h2 className={`text-xs sm:text-sm font-bold uppercase tracking-wider flex items-center gap-2 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-violet-500 shadow-[0_0_10px_rgba(139,92,246,0.5)]"></span>
            Configuration
          </h2>
          {(hasResult || isProcessing) && (
            <button
              onClick={onCollapse}
              className={`hidden xl:flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all text-[10px] ${
                isDark 
                  ? 'bg-zinc-800/50 border border-white/5 text-zinc-500 hover:text-white hover:bg-zinc-800 hover:border-white/10'
                  : 'bg-zinc-100 border border-zinc-200 text-zinc-500 hover:text-zinc-900 hover:bg-zinc-200'
              }`}
              title="Collapse Panel"
            >
              <PanelLeftClose className="w-3.5 h-3.5" />
              <span>Collapse</span>
            </button>
          )}
        </div>

        <div className="space-y-4 sm:space-y-6 relative">
          {/* URL Input */}
          <div>
            <label className={`text-[10px] sm:text-xs font-semibold ml-1 mb-1.5 sm:mb-2 block flex items-center gap-2 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
              <span>TARGET RESOURCE</span>
              {/* Input Type Indicator */}
              {url.trim() && (
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium transition-all ${
                  inputIsUrl 
                    ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' 
                    : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                }`}>
                  {inputIsUrl ? <Link className="w-2.5 h-2.5" /> : <Search className="w-2.5 h-2.5" />}
                  {inputIsUrl ? 'URL' : 'Query'}
                </span>
              )}
            </label>
            <div className="relative group/input">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="Enter a URL or search query..."
                className={`w-full rounded-lg sm:rounded-xl p-3 sm:p-4 pr-8 sm:pr-10 font-mono text-xs sm:text-sm focus:outline-none focus:border-violet-500 focus:ring-1 focus:ring-violet-500/50 transition-all shadow-inner ${
                  isDark 
                    ? 'bg-black/50 border border-white/10 text-white placeholder-zinc-600'
                    : 'bg-zinc-50 border border-zinc-200 text-zinc-900 placeholder-zinc-400'
                }`}
              />
              {url && (
                <button
                  onClick={() => setUrl('')}
                  className={`absolute right-3 sm:right-4 top-3 sm:top-4 transition-colors ${isDark ? 'text-zinc-600 hover:text-white' : 'text-zinc-400 hover:text-zinc-900'}`}
                >
                  ×
                </button>
              )}
            </div>

            {/* Presets Chips */}
            <div className="flex flex-wrap gap-1.5 sm:gap-2 mt-2 sm:mt-3">
              {presets.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => onApplyPreset(preset)}
                  className={`px-2 sm:px-3 py-1 sm:py-1.5 rounded-md sm:rounded-lg text-[10px] sm:text-xs transition-all cursor-pointer flex items-center gap-1 sm:gap-1.5 ${
                    isDark 
                      ? 'bg-white/5 border border-white/5 hover:border-violet-500/30 hover:bg-violet-500/10 text-zinc-400 hover:text-violet-300'
                      : 'bg-zinc-100 border border-zinc-200 hover:border-violet-400/50 hover:bg-violet-50 text-zinc-600 hover:text-violet-600'
                  }`}
                >
                  <FileText className="w-2.5 h-2.5 sm:w-3 sm:h-3 opacity-50" /> 
                  <span className="truncate max-w-[80px] sm:max-w-none">{preset.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Strategy Selector */}
          <div>
            <label className={`text-[10px] sm:text-xs font-semibold ml-1 mb-1.5 sm:mb-2 block ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
              INGESTION STRATEGY
            </label>
            <div className="relative">
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as Strategy)}
                className={`w-full rounded-lg sm:rounded-xl p-3 sm:p-4 text-xs sm:text-sm focus:outline-none focus:border-violet-500 transition-colors appearance-none cursor-pointer ${
                  isDark 
                    ? 'bg-black/50 border border-white/10 text-white'
                    : 'bg-zinc-50 border border-zinc-200 text-zinc-900'
                }`}
              >
                {Object.values(Strategy).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <div className={`absolute right-3 sm:right-4 top-3.5 sm:top-4.5 pointer-events-none ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                <svg
                  width="10"
                  height="6"
                  viewBox="0 0 10 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M1 1L5 5L9 1" />
                </svg>
              </div>
            </div>
          </div>

          {/* Advanced Options */}
          <div>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={`flex items-center gap-1.5 text-[10px] sm:text-xs font-medium transition-colors ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'}`}
            >
              {showAdvanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <Settings className="w-3.5 h-3.5" />
              Advanced Options
            </button>
            <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${showAdvanced ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="overflow-hidden">
                <div className={`mt-3 space-y-4 p-3 rounded-xl border ${isDark ? 'bg-black/30 border-white/5' : 'bg-zinc-50 border-zinc-200'}`}>
                  {/* Return format toggle */}
                  {setReturnFormat && (
                    <div>
                      <label className={`text-[10px] font-semibold mb-1.5 block ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>RETURN FORMAT</label>
                      <div className="flex gap-1">
                        {([
                          { id: 'hqcc' as ReturnFormat, label: 'HQCC', desc: 'Compressed' },
                          { id: 'raw' as ReturnFormat, label: 'Raw', desc: 'Original' },
                          { id: 'both' as ReturnFormat, label: 'Both', desc: 'HQCC + Raw' },
                        ]).map((opt) => (
                          <button
                            key={opt.id}
                            onClick={() => setReturnFormat(opt.id)}
                            className={`flex flex-col items-start px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-medium transition-all ${
                              returnFormat === opt.id
                                ? isDark ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-violet-100 text-violet-700 border border-violet-300'
                                : isDark ? 'text-zinc-500 hover:text-zinc-300 border border-transparent' : 'text-zinc-500 hover:text-zinc-700 border border-transparent'
                            }`}
                          >
                            {opt.label}
                            <span className={`text-[9px] ${returnFormat === opt.id ? 'opacity-70' : 'opacity-50'}`}>{opt.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Query-mode options — only visible when input is a query */}
                  {isQuery && setTopK && (
                    <div>
                      <label className={`text-[10px] font-semibold mb-1.5 block ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                        SEARCH RESULTS (topK): {topK}
                      </label>
                      <input
                        type="range"
                        min={1}
                        max={30}
                        value={topK}
                        onChange={(e) => setTopK(Number(e.target.value))}
                        className="w-full accent-violet-500"
                      />
                      <div className={`flex justify-between text-[9px] mt-0.5 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                        <span>1</span>
                        <span>15</span>
                        <span>30</span>
                      </div>
                    </div>
                  )}

                  {isQuery && setUseAutoprompt && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useAutoprompt}
                        onChange={(e) => setUseAutoprompt(e.target.checked)}
                        className="rounded border-zinc-600 accent-violet-500"
                      />
                      <span className={`text-[10px] sm:text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                        Use Autoprompt <span className="opacity-60">(enhance query)</span>
                      </span>
                    </label>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Submit Button with Progress */}
          <button
            onClick={onSubmit}
            disabled={isProcessing}
            className={`w-full h-11 sm:h-14 rounded-lg sm:rounded-xl font-bold text-sm sm:text-base text-white shadow-[0_4px_20px_rgba(0,0,0,0.3)] hover:shadow-[0_0_30px_rgba(124,58,237,0.3)] transition-all flex items-center justify-center gap-2 group/btn relative overflow-hidden ${
              isDark ? 'bg-zinc-800 border border-white/5' : 'bg-zinc-900 border border-zinc-700'
            }`}
          >
            {/* Progress Fill Background */}
            <div
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-violet-600 via-violet-500 to-cyan-500 transition-all duration-300 ease-linear"
              style={{ width: isProcessing ? `${loadingProgress}%` : '0%' }}
            />

            {/* Idle Background (Hover Effect) */}
            <div
              className={`absolute inset-0 bg-gradient-to-r from-violet-600 via-violet-500 to-cyan-500 opacity-0 group-hover/btn:opacity-100 transition-opacity ${isProcessing ? 'hidden' : ''}`}
            />

            {/* Button Content */}
            <div className="relative z-10 flex items-center gap-2">
              {isProcessing ? (
                <>
                  <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" />
                  <span className="text-xs sm:text-sm">Agent Ingesting... {Math.round(loadingProgress)}%</span>
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 sm:w-5 sm:h-5 group-hover/btn:translate-x-0.5 transition-transform" />
                  <span className="text-xs sm:text-sm">RUN AGENT INGEST</span>
                </>
              )}
            </div>
          </button>
        </div>
      </div>
    </GradientCard>
  );
}




