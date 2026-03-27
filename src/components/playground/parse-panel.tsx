'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Play, Loader2, FileText, Globe, Zap, Eye, Sparkles, Clock, Image, Info, Code2, FileCheck, ChevronDown, ChevronRight, Settings } from 'lucide-react';
import { useApp } from '@/contexts/app-context';
import MarkdownRenderer from '@/components/ui/markdown-renderer';

type ParseMode = 'auto' | 'fast' | 'hires';
type InputMode = 'url' | 'file';
type ResultTab = 'markdown' | 'images' | 'metadata' | 'json';

const PARSE_PRESETS = [
  { label: 'arXiv Paper', url: 'https://arxiv.org/pdf/2401.00001.pdf' },
  { label: 'Attention Is All You Need', url: 'https://arxiv.org/pdf/1706.03762.pdf' },
  { label: 'Bitcoin Whitepaper', url: 'https://bitcoin.org/bitcoin.pdf' },
];

// Typed accessors for the parse API response
function getDoc(result: Record<string, unknown>): Record<string, unknown> {
  return (result.document as Record<string, unknown>) || {};
}
function getUsage(result: Record<string, unknown>): Record<string, unknown> {
  return (result.usage as Record<string, unknown>) || {};
}
function getCost(result: Record<string, unknown>): Record<string, unknown> {
  return (result.cost as Record<string, unknown>) || {};
}
function getImages(result: Record<string, unknown>): Record<string, unknown>[] {
  const doc = getDoc(result);
  return (doc.images as Record<string, unknown>[]) || [];
}
function getMetadata(result: Record<string, unknown>): Record<string, unknown> {
  return (getDoc(result).metadata as Record<string, unknown>) || {};
}

// Use proxy for parser/CDN image URLs so they load in-browser (avoids CORS / inaccessible CDN)
const PROXY_ORIGINS = ['cdn.prismer.ai', 'parser.prismer.dev', 'parser.prismer.app'];
function getImageDisplayUrl(rawUrl: string): string {
  if (!rawUrl || rawUrl.startsWith('data:')) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (PROXY_ORIGINS.some((o) => u.hostname === o || u.hostname.endsWith('.' + o)))
      return `/api/parse/image-proxy?url=${encodeURIComponent(rawUrl)}`;
  } catch {
    /* ignore */
  }
  return rawUrl;
}

function replaceParserImageUrlsInMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const displayUrl = getImageDisplayUrl(src.trim());
    return `![${alt}](${displayUrl})`;
  });
}

export function ParsePanel({ isDark }: { isDark: boolean }) {
  const { activeApiKey, token, addToast } = useApp();

  const [inputMode, setInputMode] = useState<InputMode>('url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [parseMode, setParseMode] = useState<ParseMode>('fast');
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [resultTab, setResultTab] = useState<ResultTab>('markdown');
  const [processingTime, setProcessingTime] = useState(0);

  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [outputFormat, setOutputFormat] = useState<'markdown' | 'json'>('markdown');
  const [imageMode, setImageMode] = useState<'embedded' | 's3'>('embedded');
  const [includeDetection, setIncludeDetection] = useState(false);

  // Async polling state
  const [asyncStatus, setAsyncStatus] = useState<string | null>(null);
  const [asyncProgress, setAsyncProgress] = useState(0);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const getAuthHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {};
    const authToken = activeApiKey?.key || token;
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    return headers;
  }, [activeApiKey, token]);

  // Poll async task status
  const pollStatus = useCallback(async (taskId: string, startTime: number) => {
    const authHeaders = getAuthHeaders();
    setAsyncStatus('processing');

    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/parse/status/${taskId}`, { headers: authHeaders });
        const data = await res.json();

        if (data.success && data.status === 'completed') {
          // Stop polling
          if (pollingRef.current) clearInterval(pollingRef.current);
          pollingRef.current = null;
          setAsyncStatus(null);

          // Fetch result
          const resultRes = await fetch(`/api/parse/result/${taskId}`, { headers: authHeaders });
          const resultData = await resultRes.json();
          setProcessingTime(Date.now() - startTime);
          setResult(resultData);
          setIsProcessing(false);
        } else if (data.success) {
          setAsyncProgress(data.progress || 0);
          setAsyncStatus(data.status || 'processing');
        } else if (data.status === 'failed') {
          if (pollingRef.current) clearInterval(pollingRef.current);
          pollingRef.current = null;
          setAsyncStatus(null);
          setIsProcessing(false);
          addToast(data.error?.message || 'Parse failed', 'error');
        }
      } catch {
        // Keep polling on network error
      }
    }, 2000);
  }, [getAuthHeaders, addToast]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const handleParse = async () => {
    if (inputMode === 'url' && !url.trim()) {
      addToast('Please enter a URL', 'error');
      return;
    }
    if (inputMode === 'file' && !file) {
      addToast('Please select a file', 'error');
      return;
    }

    // Stop any existing polling
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }

    setIsProcessing(true);
    setResult(null);
    setResultTab('markdown');
    setAsyncStatus(null);
    setAsyncProgress(0);
    const startTime = Date.now();

    try {
      const headers: Record<string, string> = {};
      const authToken = activeApiKey?.key || token;
      if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

      let body: FormData | string;
      if (inputMode === 'file' && file) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('mode', parseMode);
        if (outputFormat !== 'markdown') formData.append('output', outputFormat);
        if (imageMode !== 'embedded') formData.append('image_mode', imageMode);
        if (includeDetection) formData.append('include_detection', 'true');
        body = formData;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
          url: url.trim(),
          mode: parseMode,
          ...(outputFormat !== 'markdown' && { output: outputFormat }),
          ...(imageMode !== 'embedded' && { image_mode: imageMode }),
          ...(includeDetection && { include_detection: true }),
        });
      }

      const res = await fetch('/api/parse', {
        method: 'POST',
        headers,
        body,
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error?.message || 'Parse failed');
      }

      // Check if async (HiRes mode returns async task)
      if (data.async && data.taskId) {
        setAsyncStatus('submitted');
        setAsyncProgress(0);
        pollStatus(data.taskId, startTime);
        // Don't setIsProcessing(false) — polling will handle it
        return;
      }

      setProcessingTime(Date.now() - startTime);
      setResult(data);
      setIsProcessing(false);
    } catch (err: unknown) {
      addToast(err instanceof Error ? err.message : 'Parse request failed', 'error');
      setIsProcessing(false);
    }
  };

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const droppedFile = e.dataTransfer.files[0];
    if (droppedFile) setFile(droppedFile);
  };

  const cardClass = `rounded-2xl border p-5 ${isDark ? 'bg-zinc-900/30 border-white/10' : 'bg-white border-zinc-200 shadow-sm'}`;
  const inputClass = `w-full px-3 py-2.5 rounded-xl text-sm font-mono ${
    isDark
      ? 'bg-zinc-950 border border-white/10 text-white placeholder:text-zinc-600 focus:border-violet-500/50'
      : 'bg-zinc-50 border border-zinc-200 text-zinc-900 placeholder:text-zinc-400 focus:border-violet-400'
  } outline-none transition-colors`;

  // Tabs available for current result
  const availableTabs: { id: ResultTab; label: string; icon: typeof FileText }[] = [
    { id: 'markdown', label: 'Markdown', icon: FileText },
  ];
  if (result) {
    const images = getImages(result);
    if (images.length > 0) availableTabs.push({ id: 'images', label: `Images (${images.length})`, icon: Image });
    availableTabs.push({ id: 'metadata', label: 'Metadata', icon: Info });
    availableTabs.push({ id: 'json', label: 'Raw JSON', icon: Code2 });
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
      {/* Left — Input */}
      <div className={`${cardClass} space-y-4`}>
        <div className="flex items-center gap-2 mb-2">
          <FileText className={`w-5 h-5 ${isDark ? 'text-violet-400' : 'text-violet-600'}`} />
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Document Input</h3>
        </div>

        {/* Input mode toggle */}
        <div className="flex gap-1">
          {(['url', 'file'] as InputMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setInputMode(mode)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                inputMode === mode
                  ? isDark ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-violet-100 text-violet-700 border border-violet-300'
                  : isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'
              }`}
            >
              {mode === 'url' ? <Globe className="w-3.5 h-3.5" /> : <FileText className="w-3.5 h-3.5" />}
              {mode === 'url' ? 'URL' : 'File Upload'}
            </button>
          ))}
        </div>

        {/* URL input */}
        {inputMode === 'url' && (
          <>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://arxiv.org/pdf/2401.00001.pdf"
              className={inputClass}
            />
            <div className="flex flex-wrap gap-1.5">
              {PARSE_PRESETS.map((preset) => (
                <button
                  key={preset.url}
                  onClick={() => setUrl(preset.url)}
                  className={`px-2 py-1 rounded-md text-[11px] font-medium transition-all ${
                    url === preset.url
                      ? isDark ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-violet-100 text-violet-700 border border-violet-300'
                      : isDark ? 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-white/5' : 'bg-zinc-100 text-zinc-500 hover:text-zinc-700 border border-zinc-200'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </>
        )}

        {/* File drop zone */}
        {inputMode === 'file' && (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleFileDrop}
            className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 cursor-pointer transition-colors ${
              isDark
                ? 'border-white/10 hover:border-violet-500/30 bg-zinc-950/50'
                : 'border-zinc-300 hover:border-violet-400 bg-zinc-50'
            }`}
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.pdf,.png,.jpg,.jpeg,.webp,.tiff';
              input.onchange = (e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) setFile(f);
              };
              input.click();
            }}
          >
            {file ? (
              <p className={`text-sm ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{file.name}</p>
            ) : (
              <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>Drop PDF or image, or click to browse</p>
            )}
          </div>
        )}

        {/* Parse mode */}
        <div>
          <label className="text-xs text-zinc-500 mb-1.5 block">Parse Mode</label>
          <div className="flex gap-1">
            {([
              { id: 'auto' as ParseMode, label: 'Auto', desc: 'Smart detection', icon: Sparkles },
              { id: 'fast' as ParseMode, label: 'Fast', desc: '~15 pages/s', icon: Zap },
              { id: 'hires' as ParseMode, label: 'HiRes', desc: 'OCR ~16 pages/min', icon: Eye },
            ]).map((m) => {
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  onClick={() => setParseMode(m.id)}
                  className={`flex flex-col items-start px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                    parseMode === m.id
                      ? isDark ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-emerald-100 text-emerald-700 border border-emerald-300'
                      : isDark ? 'text-zinc-500 hover:text-zinc-300 border border-transparent' : 'text-zinc-500 hover:text-zinc-700 border border-transparent'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Icon className="w-3.5 h-3.5" />
                    {m.label}
                  </span>
                  <span className={`text-[10px] mt-0.5 ${parseMode === m.id ? 'opacity-70' : 'opacity-50'}`}>{m.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Advanced options accordion */}
        <div>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'}`}
          >
            {showAdvanced ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <Settings className="w-3.5 h-3.5" />
            Advanced Options
          </button>
          <div className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${showAdvanced ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
            <div className="overflow-hidden">
              <div className={`mt-3 space-y-3 p-3 rounded-xl border ${isDark ? 'bg-zinc-950/50 border-white/5' : 'bg-zinc-50 border-zinc-200'}`}>
                {/* Output format */}
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">Output Format</label>
                  <div className="flex gap-1">
                    {(['markdown', 'json'] as const).map((fmt) => (
                      <button
                        key={fmt}
                        onClick={() => setOutputFormat(fmt)}
                        className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                          outputFormat === fmt
                            ? isDark ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-violet-100 text-violet-700 border border-violet-300'
                            : isDark ? 'text-zinc-500 hover:text-zinc-300 border border-transparent' : 'text-zinc-500 hover:text-zinc-700 border border-transparent'
                        }`}
                      >
                        {fmt}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Image mode */}
                <div>
                  <label className="text-xs text-zinc-500 mb-1 block">Image Mode</label>
                  <div className="flex gap-1">
                    {([
                      { id: 'embedded' as const, label: 'Embedded', desc: 'Base64 inline' },
                      { id: 's3' as const, label: 'S3 URL', desc: 'External links' },
                    ]).map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => setImageMode(opt.id)}
                        className={`flex flex-col items-start px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                          imageMode === opt.id
                            ? isDark ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30' : 'bg-violet-100 text-violet-700 border border-violet-300'
                            : isDark ? 'text-zinc-500 hover:text-zinc-300 border border-transparent' : 'text-zinc-500 hover:text-zinc-700 border border-transparent'
                        }`}
                      >
                        {opt.label}
                        <span className={`text-[10px] ${imageMode === opt.id ? 'opacity-70' : 'opacity-50'}`}>{opt.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {/* Include detection (HiRes only) */}
                <label className={`flex items-center gap-2 cursor-pointer ${parseMode !== 'hires' ? 'opacity-40 pointer-events-none' : ''}`}>
                  <input
                    type="checkbox"
                    checked={includeDetection}
                    onChange={(e) => setIncludeDetection(e.target.checked)}
                    className="rounded border-zinc-600"
                  />
                  <span className="text-xs text-zinc-500">Include Detection Data <span className="text-[10px] opacity-60">(HiRes only)</span></span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* Submit */}
        <button
          onClick={handleParse}
          disabled={isProcessing}
          className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all ${
            isProcessing
              ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed'
              : 'bg-gradient-to-r from-violet-600 to-cyan-500 text-white hover:opacity-90'
          }`}
        >
          {isProcessing ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> {asyncStatus ? 'Processing (HiRes)...' : 'Parsing...'}</>
          ) : (
            <><Play className="w-4 h-4" /> Parse Document</>
          )}
        </button>
      </div>

      {/* Right — Results */}
      <div className={cardClass}>
        {/* Header with stats */}
        <div className="flex items-center justify-between mb-4">
          <h3 className={`text-sm font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Result</h3>
        </div>

        {/* Stats bar — only when result exists */}
        {result && (
          <div className={`flex flex-wrap items-center gap-2 mb-4 p-3 rounded-xl text-xs ${isDark ? 'bg-zinc-950/50 border border-white/5' : 'bg-zinc-50 border border-zinc-200'}`}>
            <span className={`flex items-center gap-1 px-2 py-0.5 rounded-md ${isDark ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-100 text-emerald-700'}`}>
              <FileCheck className="w-3 h-3" />
              {(result.mode as string) || 'fast'}
            </span>
            <span className={`flex items-center gap-1 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              <Clock className="w-3 h-3" />
              {(processingTime / 1000).toFixed(1)}s
            </span>
            {(getDoc(result).pageCount as number) > 0 && (
              <span className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
                {getDoc(result).pageCount as number} pages
              </span>
            )}
            {getImages(result).length > 0 && (
              <span className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
                {getImages(result).length} images
              </span>
            )}
            {(getUsage(result).outputTokens as number) > 0 && (
              <span className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
                {((getUsage(result).outputTokens as number) / 1000).toFixed(1)}k tokens
              </span>
            )}
            {(getCost(result).total_credits as number) > 0 && (
              <span className={`px-2 py-0.5 rounded-md ${isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-100 text-amber-700'}`}>
                {(getCost(result).total_credits as number).toFixed(1)} credits
              </span>
            )}
          </div>
        )}

        {/* Tabs */}
        {result && (
          <div className="flex gap-1 mb-4">
            {availableTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setResultTab(tab.id)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    resultTab === tab.id
                      ? isDark ? 'bg-violet-500/20 text-violet-300' : 'bg-violet-100 text-violet-700'
                      : isDark ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700'
                  }`}
                >
                  <Icon className="w-3 h-3" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Empty state */}
        {!result && !isProcessing && (
          <div className={`flex flex-col items-center justify-center py-16 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
            <FileText className="w-10 h-10 mb-3 opacity-50" />
            <p className="text-sm">Parse a document to see results</p>
          </div>
        )}

        {/* Loading state */}
        {isProcessing && (
          <div className="flex flex-col items-center justify-center py-12 px-4">
            <Loader2 className="w-8 h-8 animate-spin text-violet-500 mb-3" />
            {asyncStatus ? (
              <>
                <p className={`text-sm font-medium mb-1 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  HiRes Processing...
                </p>
                <p className={`text-xs mb-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  Status: {asyncStatus} {asyncProgress > 0 && `(${asyncProgress}%)`}
                </p>
                {/* Progress bar */}
                <div className={`w-full max-w-xs h-2 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
                  <div
                    className="h-full bg-gradient-to-r from-violet-500 to-cyan-500 transition-all duration-500 rounded-full"
                    style={{ width: `${Math.max(asyncProgress, 5)}%` }}
                  />
                </div>
                <p className={`text-[10px] mt-2 ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                  Polling /api/parse/status every 2s...
                </p>
              </>
            ) : (
              <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>Processing document...</p>
            )}
          </div>
        )}

        {/* Result content */}
        {result && (
          <div className={`rounded-xl overflow-hidden border max-h-[600px] overflow-y-auto ${isDark ? 'bg-zinc-950 border-white/5' : 'bg-zinc-50 border-zinc-200'}`}>
            {/* Markdown tab */}
            {resultTab === 'markdown' && (
              <div className="p-4">
                <MarkdownRenderer
                  content={replaceParserImageUrlsInMarkdown(
                    (getDoc(result).markdown as string) || (getDoc(result).text as string) || 'No markdown content'
                  )}
                />
              </div>
            )}

            {/* Images tab */}
            {resultTab === 'images' && (
              <div className="p-4">
                {getImages(result).length > 0 ? (
                  <div className="grid grid-cols-2 gap-3">
                    {getImages(result).map((img, i) => {
                      const rawUrl = (img.url as string) || '';
                      const displayUrl = getImageDisplayUrl(rawUrl);
                      return (
                      <div key={i} className={`rounded-lg overflow-hidden border ${isDark ? 'border-white/10' : 'border-zinc-200'}`}>
                        {rawUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={displayUrl}
                            alt={(img.caption as string) || `Image ${i + 1}`}
                            className="w-full h-auto"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              const target = e.currentTarget;
                              target.style.display = 'none';
                              const fallback = target.nextElementSibling;
                              if (fallback) (fallback as HTMLElement).style.display = 'flex';
                            }}
                          />
                        ) : null}
                        {/* Fallback shown on load error or no URL */}
                        <div
                          className={`items-center justify-center h-24 ${isDark ? 'bg-zinc-800' : 'bg-zinc-100'}`}
                          style={{ display: rawUrl ? 'none' : 'flex' }}
                        >
                          {rawUrl ? (
                            <a
                              href={displayUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`text-[10px] underline px-2 text-center break-all ${isDark ? 'text-violet-400' : 'text-violet-600'}`}
                            >
                              Open image in new tab
                            </a>
                          ) : (
                            <Image className="w-6 h-6 opacity-30" />
                          )}
                        </div>
                        <div className={`px-2 py-1.5 text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          {img.caption ? (img.caption as string) : `Page ${(img.page as number) || i + 1}`}
                        </div>
                      </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className={`text-sm text-center py-8 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}>No images extracted</p>
                )}
              </div>
            )}

            {/* Metadata tab */}
            {resultTab === 'metadata' && (
              <div className="p-4 space-y-3">
                <MetaRow label="Request ID" value={result.requestId as string} isDark={isDark} mono />
                <MetaRow label="Mode" value={result.mode as string} isDark={isDark} />
                <MetaRow label="Pages" value={getDoc(result).pageCount as number} isDark={isDark} />
                <MetaRow label="Images" value={getImages(result).length} isDark={isDark} />
                <MetaRow label="Output Tokens" value={getUsage(result).outputTokens as number} isDark={isDark} />
                <MetaRow label="Output Chars" value={getUsage(result).outputChars as number} isDark={isDark} />
                <MetaRow label="Processing Time" value={`${(processingTime / 1000).toFixed(1)}s`} isDark={isDark} />
                {(getCost(result).total_credits as number) > 0 && (
                  <MetaRow label="Cost" value={`${(getCost(result).total_credits as number).toFixed(2)} credits`} isDark={isDark} />
                )}
                {/* Document metadata from parser */}
                {Object.entries(getMetadata(result)).map(([key, val]) => (
                  <MetaRow key={key} label={key} value={val != null ? String(val) : '—'} isDark={isDark} />
                ))}
              </div>
            )}

            {/* Raw JSON tab */}
            {resultTab === 'json' && (
              <pre className={`p-4 text-xs font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                {JSON.stringify(result, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaRow({ label, value, isDark, mono }: { label: string; value: string | number | undefined; isDark: boolean; mono?: boolean }) {
  if (value == null || value === '' || value === 0) return null;
  return (
    <div className="flex items-center justify-between text-xs">
      <span className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>{label}</span>
      <span className={`${mono ? 'font-mono' : ''} ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>{value}</span>
    </div>
  );
}
