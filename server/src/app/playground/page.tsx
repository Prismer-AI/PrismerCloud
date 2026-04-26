'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Copy,
  Download,
  FileText,
  Loader2,
  Play,
  Sparkles,
  Code2,
  Database,
  FileJson,
  FileType,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Globe,
  Zap,
  PanelLeftOpen,
  PanelLeftClose,
  Settings,
  Link,
  Search,
  X,
  AlertCircle,
} from 'lucide-react';
import { Strategy, TaskResult, Activity, SourceResult } from '@/types';
import { api } from '@/lib/api';
import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';
import { SyntaxHighlighter } from '@/components/ui/syntax-highlighter';
import UniqueLoading from '@/components/ui/morph-loading';
import MarkdownRenderer from '@/components/ui/markdown-renderer';
import {
  ConfigurationPanel,
  ApiPreviewPanel,
  ApiTabs,
  ParsePanel,
  IMPanel,
  type PlaygroundApi,
} from '@/components/playground';

const PRESETS = [
  { label: 'Efficient-VQGAN Paper', url: 'https://arxiv.org/html/2310.05400v1', strategy: Strategy.ACADEMIC },
  {
    label: 'Financial Report',
    url: 'https://investors.nvidia.com/financials/quarterly-results/FY24-Q3.pdf',
    strategy: Strategy.FINANCE,
  },
  {
    label: 'Legal Contract',
    url: 'https://www.sec.gov/Archives/edgar/data/1318605/tsla-10k_2023.htm',
    strategy: Strategy.LEGAL,
  },
];

type CodeLanguage = 'curl' | 'python' | 'typescript' | 'go';
type ResultTab = 'hqcc' | 'raw' | 'meta';

function PlaygroundContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { addActivity, addToast, activeApiKey, login, isAuthenticated, isAuthLoading } = useApp();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const oauthHandledRef = useRef(false);
  const [showAuthPrompt, setShowAuthPrompt] = useState(false); // Show registration prompt after processing
  const [activeApi, setActiveApi] = useState<PlaygroundApi>('context');

  // Input State
  const [url, setUrl] = useState('https://www.figure.ai/news/helix');
  const [strategy, setStrategy] = useState<Strategy>(Strategy.AUTO);
  const [codeLang, setCodeLang] = useState<CodeLanguage>('python');
  const [returnFormat, setReturnFormat] = useState<'hqcc' | 'raw' | 'both'>('hqcc');
  const [topK, setTopK] = useState(10);
  const [useAutoprompt, setUseAutoprompt] = useState(true);

  // Processing State
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [activeTab, setActiveTab] = useState<ResultTab>('hqcc');
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [activeSourceIndex, setActiveSourceIndex] = useState(0);
  const [isCompressingSource, setIsCompressingSource] = useState(false);
  const [compressedSourceIds, setCompressedSourceIds] = useState<Set<string>>(new Set(['source_0'])); // First source is always compressed
  const [streamingContent, setStreamingContent] = useState<string>(''); // For streaming HQCC output
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false); // Control left panel collapse
  const [showCreditsBanner, setShowCreditsBanner] = useState(false); // Show insufficient credits banner

  // OAuth Callback Handling - /playground is the OAuth redirect URI
  useEffect(() => {
    // Prevent duplicate handling
    if (oauthHandledRef.current) return;

    const handleOAuthCallback = async () => {
      // Check for GitHub OAuth code in query params
      const code = searchParams.get('code');
      if (code) {
        oauthHandledRef.current = true;
        console.log('[OAuth][Playground] GitHub code detected:', code);
        try {
          const res = await fetch('/api/auth/github/callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
          });
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.error?.msg || 'GitHub authentication failed');
          }
          login(data.user, data.token);
          addToast('GitHub authentication successful!', 'success');
          // Redirect to saved target (e.g. /dashboard?tab=keys) or default
          const savedRedirect = sessionStorage.getItem('prismer_oauth_redirect');
          sessionStorage.removeItem('prismer_oauth_redirect');
          router.replace(savedRedirect || '/playground');
        } catch (error: any) {
          console.error('GitHub OAuth error:', error);
          addToast(error.message || 'GitHub authentication failed', 'error');
          router.replace('/playground');
        }
        return;
      }

      // Check for Google OAuth access_token in URL hash
      if (typeof window !== 'undefined') {
        const hash = window.location.hash || '';
        if (hash.includes('access_token')) {
          oauthHandledRef.current = true;
          const params = new URLSearchParams(hash.replace(/^#/, ''));
          const accessToken = params.get('access_token');
          if (accessToken) {
            console.log('[OAuth][Playground] Google access_token detected:', accessToken.slice(0, 8) + '...');
            try {
              const res = await fetch('/api/auth/google/callback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ access_token: accessToken }),
              });
              const data = await res.json();
              if (!res.ok) {
                throw new Error(data.error?.msg || 'Google authentication failed');
              }
              login(data.user, data.token);
              addToast('Google authentication successful!', 'success');
              const savedRedirect = sessionStorage.getItem('prismer_oauth_redirect');
              sessionStorage.removeItem('prismer_oauth_redirect');
              if (savedRedirect) {
                router.replace(savedRedirect);
              } else {
                window.history.replaceState(null, '', '/playground');
              }
            } catch (error: any) {
              console.error('Google OAuth error:', error);
              addToast(error.message || 'Google authentication failed', 'error');
              window.history.replaceState(null, '', '/playground');
            }
          }
        }
      }
    };

    handleOAuthCallback();
  }, [searchParams, router, login, addToast]);

  // Auto-Run Logic from URL params (only for non-OAuth URLs)
  useEffect(() => {
    // Skip if this is an OAuth callback
    if (searchParams.get('code')) return;

    const urlParam = searchParams.get('url');
    if (urlParam) {
      setUrl(urlParam);
      // Auto-run after a small delay
      const timer = setTimeout(() => {
        handleSubmit(urlParam);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [searchParams]);

  const handleSubmit = async (overrideUrl?: string) => {
    const targetInput = overrideUrl || url;
    if (!targetInput.trim()) {
      addToast('Please enter a URL or search query', 'error');
      return;
    }

    if (isProcessing) return;

    setIsProcessing(true);
    setResult(null);
    setLoadingProgress(0);
    setStreamingContent('');
    setIsPanelCollapsed(true); // Auto-collapse panel when processing starts

    const interval = setInterval(() => {
      setLoadingProgress((prev) => {
        if (prev >= 90) return prev;
        return prev + Math.random() * 10;
      });
    }, 200);

    try {
      // Use streaming callback to update content in real-time
      const data = await api.submitTask(
        targetInput,
        strategy,
        (content, done) => {
          setStreamingContent(content);
          if (done) {
            setLoadingProgress(100);
          }
        },
        { format: returnFormat, topK, useAutoprompt },
      );

      clearInterval(interval);
      setLoadingProgress(100);
      setResult(data);
      setStreamingContent(''); // Clear streaming content once result is set
      setActiveSourceIndex(0); // Reset source index

      // Mark compressed sources:
      // - First source (index 0) is always compressed by initial API call
      // - Cached sources (from Context Server) are already compressed
      if (data.sources) {
        const compressedIds = data.sources
          .filter((s, idx) => idx === 0 || s.cached) // First source OR cached sources
          .map((s) => s.id);
        setCompressedSourceIds(new Set(compressedIds));
      } else {
        // Single source result (URL input) - mark as compressed
        setCompressedSourceIds(new Set(['source_0']));
      }

      addToast('Context extraction successful', 'success');
      addActivity({
        id: Math.random().toString(36).substr(2, 9),
        url: targetInput,
        strategy: strategy,
        status: 'Completed',
        time: 'Just now',
        cost: (Math.random() * 0.05).toFixed(3),
      });

      // Show auth prompt for non-authenticated users after successful processing
      if (!isAuthenticated) {
        setShowAuthPrompt(true);
      }
    } catch (error: any) {
      clearInterval(interval);
      const msg = error?.message || '';
      if (msg.includes('INSUFFICIENT_CREDITS') || msg.includes('credits')) {
        addToast('Insufficient credits. Top up in Dashboard > Billing to continue.', 'error');
        setShowCreditsBanner(true);
      } else {
        addToast('Failed to process context', 'error');
      }
    } finally {
      setTimeout(() => {
        setIsProcessing(false);
        setStreamingContent('');
      }, 500);
    }
  };

  const applyPreset = (preset: (typeof PRESETS)[0]) => {
    setUrl(preset.url);
    setStrategy(preset.strategy);
    addToast(`Loaded preset: ${preset.label}`, 'info');
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    addToast('Copied to clipboard', 'success');
  };

  // Compress a single source on demand
  const compressSource = async (sourceIndex: number) => {
    if (!result?.sources || isCompressingSource) return;

    const source = result.sources[sourceIndex];
    if (!source || compressedSourceIds.has(source.id)) return;

    setIsCompressingSource(true);

    try {
      const compressRes = await fetch('/api/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: source.raw,
          url: source.url,
          title: source.title,
          strategy: strategy,
          imageLinks: source.imageLinks || [],
        }),
      });

      if (!compressRes.ok) {
        throw new Error('Compression failed');
      }

      const compressData = await compressRes.json();

      // Update the source with compressed content
      const updatedSources = [...result.sources];
      updatedSources[sourceIndex] = {
        ...source,
        hqcc: compressData.hqcc,
      };

      setResult({
        ...result,
        sources: updatedSources,
      });

      // Mark as compressed
      setCompressedSourceIds((prev) => new Set([...prev, source.id]));

      // Background deposit (fire-and-forget) - Only for authenticated users
      if (isAuthenticated) {
        // Get auth token from localStorage
        const authData = JSON.parse(localStorage.getItem('prismer_auth') || '{}');
        const token = authData.token;

        if (token) {
          fetch('/api/context/deposit', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              raw_link: source.url,
              hqcc_content: compressData.hqcc,
              intr_content: source.raw,
              meta: {
                strategy,
                source: 'exa_search',
                model: compressData.model,
                processed_at: new Date().toISOString(),
              },
            }),
          }).catch((err) => console.error('Background deposit failed:', err));
        }
      } else {
        console.log('[compressSource] Skipping deposit - user not authenticated');
      }

      addToast('Source compressed successfully', 'success');
    } catch (error) {
      addToast('Failed to compress source', 'error');
    } finally {
      setIsCompressingSource(false);
    }
  };

  // Handle source switch with auto-compression
  const handleSourceSwitch = (newIndex: number) => {
    if (newIndex === activeSourceIndex) return;

    setActiveSourceIndex(newIndex);

    // Check if this source needs compression
    const source = result?.sources?.[newIndex];
    // Skip compression if: already compressed OR cached from Context Server
    if (source && !compressedSourceIds.has(source.id) && !source.cached) {
      // Auto-compress after a brief delay
      setTimeout(() => compressSource(newIndex), 100);
    }
  };

  return (
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-4 sm:py-8 min-h-[calc(100vh-64px)]">
      {/* Auth Prompt Modal - Fixed at top of viewport for non-authenticated users */}
      {showAuthPrompt && !isAuthenticated && (
        <div className="fixed inset-x-0 top-0 z-[100] flex justify-center pt-20 sm:pt-24 px-4 animate-in fade-in duration-300">
          {/* Backdrop */}
          <div
            className={`fixed inset-0 backdrop-blur-sm ${isDark ? 'bg-zinc-950/60' : 'bg-zinc-500/30'}`}
            onClick={() => setShowAuthPrompt(false)}
          />
          {/* Modal Card */}
          <div
            className={`relative border rounded-2xl p-5 sm:p-6 max-w-md w-full shadow-2xl animate-in slide-in-from-top-4 duration-500 ${isDark ? 'bg-zinc-900 border-white/10' : 'bg-white border-zinc-200'}`}
          >
            <button
              onClick={() => setShowAuthPrompt(false)}
              className={`absolute top-3 right-3 p-1.5 rounded-lg transition-colors ${isDark ? 'text-zinc-500 hover:text-white hover:bg-white/10' : 'text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100'}`}
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-violet-400" />
              </div>
              <div>
                <h3 className={`text-lg font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>Great Result!</h3>
                <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Ready to integrate this into your app?
                </p>
              </div>
            </div>

            <p className={`text-sm mb-6 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
              Create a free account to get your API key and start using Prismer Cloud&apos;s context extraction in your
              applications.
            </p>

            <div className="flex gap-3">
              <button
                onClick={() => setShowAuthPrompt(false)}
                className={`flex-1 px-4 py-2.5 rounded-lg border text-sm font-medium transition-all ${isDark ? 'border-white/10 text-zinc-400 hover:text-white hover:bg-white/5' : 'border-zinc-300 text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'}`}
              >
                Maybe Later
              </button>
              <a
                href="/auth"
                className="flex-1 px-4 py-2.5 rounded-lg bg-gradient-to-r from-violet-600 to-cyan-500 text-white text-sm font-semibold text-center hover:opacity-90 transition-opacity"
              >
                Get Free API Key
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Insufficient Credits Banner */}
      {showCreditsBanner && (
        <div
          className={`mb-4 p-3 sm:p-4 rounded-xl border flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-2 duration-300 ${isDark ? 'bg-amber-500/10 border-amber-500/20 text-amber-300' : 'bg-amber-50 border-amber-200 text-amber-800'}`}
        >
          <div className="flex items-center gap-2 text-sm">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>Insufficient credits to process this request.</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href="/dashboard#billing"
              className={`text-xs sm:text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${isDark ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-200' : 'bg-amber-200 hover:bg-amber-300 text-amber-900'}`}
            >
              Top Up Credits
            </a>
            <button
              onClick={() => setShowCreditsBanner(false)}
              className={`p-1 rounded-lg transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-amber-200'}`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start sm:items-center justify-between mb-6 sm:mb-8">
        <div>
          <h1
            className={`text-xl sm:text-2xl md:text-3xl font-bold mb-1 sm:mb-2 ${isDark ? 'text-white' : 'text-zinc-900'}`}
          >
            {activeApi === 'context'
              ? 'Context Playground'
              : activeApi === 'parse'
                ? 'Parse Playground'
                : 'IM Playground'}
          </h1>
          <p className={`text-xs sm:text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            {activeApi === 'context'
              ? 'Test ingestion strategies and preview HQCC outputs'
              : activeApi === 'parse'
                ? 'Extract text from PDFs and images'
                : 'Register users and send messages'}
          </p>
        </div>
      </div>

      <ApiTabs activeApi={activeApi} onChange={setActiveApi} isDark={isDark} />

      {activeApi === 'parse' && <ParsePanel isDark={isDark} />}
      {activeApi === 'im' && <IMPanel isDark={isDark} />}

      {activeApi === 'context' && (
        <div
          className={`grid grid-cols-1 gap-4 sm:gap-6 lg:gap-8 relative transition-all duration-500 ease-out ${
            isPanelCollapsed ? 'xl:grid-cols-[64px_minmax(0,1fr)]' : 'xl:grid-cols-12'
          }`}
          style={{ alignItems: 'start' }}
        >
          {/* LEFT COLUMN (Input & Code) - Collapsible */}
          <div
            className={`z-20 transition-all duration-500 ease-out ${
              isPanelCollapsed ? 'xl:self-start' : 'xl:col-span-5 space-y-4 sm:space-y-6 xl:self-start'
            }`}
          >
            {/* Collapsed State - Floating Toggle Buttons */}
            {isPanelCollapsed && (
              <div
                className={`hidden xl:flex flex-col items-center gap-3 py-4 backdrop-blur-xl border rounded-2xl animate-in slide-in-from-left-4 fade-in duration-300 sticky top-24 ${isDark ? 'bg-zinc-900/90 border-white/10' : 'bg-white/90 border-zinc-200'}`}
              >
                <button
                  onClick={() => setIsPanelCollapsed(false)}
                  className={`w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500/20 to-cyan-500/20 border border-violet-500/30 flex items-center justify-center hover:border-violet-500/50 hover:from-violet-500/30 hover:to-cyan-500/30 transition-all shadow-lg group ${isDark ? 'text-violet-400 hover:text-white' : 'text-violet-600 hover:text-violet-800'}`}
                  title="Expand Panel"
                >
                  <PanelLeftOpen className="w-5 h-5 group-hover:scale-110 transition-transform" />
                </button>
                <div className="w-8 h-px bg-white/10"></div>
                <button
                  onClick={() => setIsPanelCollapsed(false)}
                  className="w-10 h-10 rounded-xl bg-zinc-800/80 border border-white/10 flex items-center justify-center text-zinc-400 hover:text-white hover:border-white/20 hover:bg-zinc-700/80 transition-all"
                  title="Configure"
                >
                  <Settings className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setIsPanelCollapsed(false)}
                  className="w-10 h-10 rounded-xl bg-zinc-800/80 border border-white/10 flex items-center justify-center text-zinc-400 hover:text-white hover:border-white/20 hover:bg-zinc-700/80 transition-all"
                  title="API Preview"
                >
                  <Code2 className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Expanded State - Full Panel */}
            <div
              className={`space-y-4 sm:space-y-6 transition-all duration-500 ease-out ${
                isPanelCollapsed ? 'xl:hidden xl:opacity-0 xl:scale-95' : 'xl:opacity-100 xl:scale-100 sticky top-28'
              }`}
            >
              {/* Configuration Panel */}
              <ConfigurationPanel
                url={url}
                setUrl={setUrl}
                strategy={strategy}
                setStrategy={setStrategy}
                isProcessing={isProcessing}
                loadingProgress={loadingProgress}
                hasResult={!!result}
                onSubmit={() => handleSubmit()}
                onCollapse={() => setIsPanelCollapsed(true)}
                onApplyPreset={applyPreset}
                presets={PRESETS}
                returnFormat={returnFormat}
                setReturnFormat={setReturnFormat}
                topK={topK}
                setTopK={setTopK}
                useAutoprompt={useAutoprompt}
                setUseAutoprompt={setUseAutoprompt}
              />

              {/* API Preview Panel */}
              <ApiPreviewPanel
                url={url}
                strategy={strategy}
                codeLang={codeLang}
                setCodeLang={setCodeLang}
                isAuthenticated={isAuthenticated}
                activeApiKey={activeApiKey}
                onCopy={copyToClipboard}
              />
            </div>
          </div>

          {/* RIGHT COLUMN (Results) */}
          <div
            className={`relative min-h-[400px] sm:min-h-[500px] lg:min-h-[600px] transition-all duration-500 w-full min-w-0 ${
              isPanelCollapsed ? '' : 'xl:col-span-7'
            }`}
          >
            {!result && !isProcessing && (
              <div
                className={`absolute inset-0 flex flex-col items-center justify-center border-2 border-dashed rounded-2xl sm:rounded-3xl opacity-50 p-4 ${isDark ? 'border-zinc-800' : 'border-zinc-300'}`}
              >
                <div
                  className={`w-16 h-16 sm:w-20 sm:h-20 md:w-24 md:h-24 rounded-full flex items-center justify-center mb-4 sm:mb-6 ${isDark ? 'bg-zinc-900' : 'bg-zinc-100'}`}
                >
                  <Database
                    className={`w-7 h-7 sm:w-8 sm:h-8 md:w-10 md:h-10 ${isDark ? 'text-zinc-700' : 'text-zinc-400'}`}
                  />
                </div>
                <p className={`font-medium text-sm sm:text-base ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}>
                  Ready to Process
                </p>
                <p className={`text-xs sm:text-sm text-center ${isDark ? 'text-zinc-600' : 'text-zinc-500'}`}>
                  Context results will appear here
                </p>
              </div>
            )}

            {/* Processing Loading State - Fixed at top */}
            {isProcessing && (
              <div
                className={`h-full rounded-2xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col ${isDark ? 'bg-zinc-900 border border-white/5' : 'bg-white border border-zinc-200'}`}
              >
                {/* Fixed Loading Header */}
                <div
                  className={`sticky top-0 z-10 px-6 py-8 ${isDark ? 'bg-zinc-900 border-b border-white/5' : 'bg-white border-b border-zinc-200'}`}
                >
                  <div className="flex items-center gap-4">
                    <UniqueLoading variant="morph" size="md" />
                    <div>
                      <h3 className={`text-base font-semibold ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                        Processing Content
                      </h3>
                      <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                        Searching and extracting context...
                      </p>
                    </div>
                  </div>
                  {/* Progress bar */}
                  <div className={`mt-4 h-1 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}>
                    <div
                      className="h-full bg-gradient-to-r from-violet-500 to-cyan-500 transition-all duration-300"
                      style={{ width: `${loadingProgress}%` }}
                    />
                  </div>
                </div>

                {/* Streaming Content Area */}
                <div className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8">
                  {streamingContent ? (
                    <div
                      className={`prose max-w-none animate-in fade-in duration-300 ${isDark ? 'prose-invert prose-zinc' : 'prose-zinc'}`}
                    >
                      <MarkdownRenderer content={streamingContent} />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-center py-12">
                      <div
                        className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 animate-pulse ${isDark ? 'bg-zinc-800' : 'bg-zinc-100'}`}
                      >
                        <Zap className="w-6 h-6 text-violet-400" />
                      </div>
                      <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}>Waiting for content...</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Results Container */}
            {result && (
              <div
                className={`h-full rounded-2xl sm:rounded-3xl shadow-2xl overflow-hidden flex flex-col animate-in slide-in-from-left-8 fade-in duration-500 ease-out fill-mode-forwards origin-left ${isDark ? 'bg-zinc-900 border border-white/5' : 'bg-white border border-zinc-200'}`}
              >
                {/* Source Switcher - Only show for Query inputs with multiple sources (ABOVE tabs) */}
                {result.inputType === 'query' && result.sources && result.sources.length > 1 && (
                  <div
                    className={`px-3 sm:px-4 py-2 flex items-center gap-2 sm:gap-3 ${isDark ? 'bg-zinc-950/80 border-b border-white/5' : 'bg-zinc-50 border-b border-zinc-200'}`}
                  >
                    <div className={`flex items-center gap-1.5 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                      <Globe className="w-3.5 h-3.5" />
                      <span className="text-[10px] sm:text-xs font-medium uppercase tracking-wider">Sources</span>
                    </div>
                    <div className="flex items-center gap-1 flex-1 overflow-x-auto scrollbar-none">
                      {result.sources.map((source, idx) => {
                        const isCompressed = compressedSourceIds.has(source.id);
                        const isCached = source.cached;
                        const isActive = activeSourceIndex === idx;
                        const isCompressing = isCompressingSource && isActive;

                        return (
                          <button
                            key={source.id}
                            onClick={() => handleSourceSwitch(idx)}
                            disabled={isCompressingSource}
                            className={`px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-[10px] sm:text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 ${
                              isActive
                                ? 'bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/50'
                                : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                            } ${isCompressingSource && !isActive ? 'opacity-50 cursor-not-allowed' : ''}`}
                            title={`${source.url}${isCached ? ' (cached)' : ''}`}
                          >
                            <span
                              className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold ${
                                isCached
                                  ? 'bg-cyan-500/20 text-cyan-400 ring-1 ring-cyan-500/30'
                                  : isCompressed
                                    ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30'
                                    : 'bg-zinc-700'
                              }`}
                            >
                              {isCompressing ? (
                                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                              ) : isCached ? (
                                <Database className="w-2.5 h-2.5" />
                              ) : isCompressed ? (
                                <CheckCircle2 className="w-2.5 h-2.5" />
                              ) : (
                                idx + 1
                              )}
                            </span>
                            <span className="max-w-[120px] sm:max-w-[180px] truncate">{source.title}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-1 text-zinc-500">
                      <button
                        onClick={() => handleSourceSwitch(Math.max(0, activeSourceIndex - 1))}
                        disabled={activeSourceIndex === 0 || isCompressingSource}
                        className="p-1 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <span className="text-[10px] sm:text-xs font-mono">
                        {activeSourceIndex + 1}/{result.sources.length}
                      </span>
                      <button
                        onClick={() =>
                          handleSourceSwitch(Math.min((result.sources?.length || 1) - 1, activeSourceIndex + 1))
                        }
                        disabled={activeSourceIndex === (result.sources?.length || 1) - 1 || isCompressingSource}
                        className="p-1 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Tabs Header */}
                <div
                  className={`flex flex-col sm:flex-row sm:items-center justify-between px-2 pt-2 gap-2 sm:gap-0 ${isDark ? 'bg-black/20 border-b border-white/5' : 'bg-zinc-100/50 border-b border-zinc-200'}`}
                >
                  <div className="flex gap-0.5 sm:gap-1 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
                    <button
                      onClick={() => setActiveTab('hqcc')}
                      className={`px-2 sm:px-4 py-2 sm:py-3 rounded-t-lg text-[10px] sm:text-xs font-bold uppercase tracking-wider flex items-center gap-1 sm:gap-2 transition-all whitespace-nowrap
                      ${
                        activeTab === 'hqcc'
                          ? isDark
                            ? 'bg-zinc-900 text-white border-t border-x border-white/5 shadow-[-1px_-1px_0_rgba(255,255,255,0.05)]'
                            : 'bg-white text-zinc-900 border-t border-x border-zinc-200 shadow-sm'
                          : isDark
                            ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                            : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/50'
                      }`}
                    >
                      <FileType className="w-3 h-3 sm:w-4 sm:h-4" /> <span className="hidden xs:inline">HQCC</span>
                      <span className="xs:hidden">HQ</span>
                    </button>
                    <button
                      onClick={() => setActiveTab('raw')}
                      className={`px-2 sm:px-4 py-2 sm:py-3 rounded-t-lg text-[10px] sm:text-xs font-bold uppercase tracking-wider flex items-center gap-1 sm:gap-2 transition-all whitespace-nowrap
                      ${
                        activeTab === 'raw'
                          ? isDark
                            ? 'bg-zinc-900 text-white border-t border-x border-white/5 shadow-[-1px_-1px_0_rgba(255,255,255,0.05)]'
                            : 'bg-white text-zinc-900 border-t border-x border-zinc-200 shadow-sm'
                          : isDark
                            ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                            : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/50'
                      }`}
                    >
                      <FileText className="w-3 h-3 sm:w-4 sm:h-4" /> Raw
                    </button>
                    <button
                      onClick={() => setActiveTab('meta')}
                      className={`px-2 sm:px-4 py-2 sm:py-3 rounded-t-lg text-[10px] sm:text-xs font-bold uppercase tracking-wider flex items-center gap-1 sm:gap-2 transition-all whitespace-nowrap
                      ${
                        activeTab === 'meta'
                          ? isDark
                            ? 'bg-zinc-900 text-white border-t border-x border-white/5 shadow-[-1px_-1px_0_rgba(255,255,255,0.05)]'
                            : 'bg-white text-zinc-900 border-t border-x border-zinc-200 shadow-sm'
                          : isDark
                            ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                            : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/50'
                      }`}
                    >
                      <FileJson className="w-3 h-3 sm:w-4 sm:h-4" /> Meta
                    </button>
                  </div>
                  <div className="flex items-center gap-2 sm:gap-3 pr-2 sm:pr-4 pb-1">
                    {/* Status Badge */}
                    <div className="hidden sm:flex items-center gap-1.5 px-2 sm:px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[9px] sm:text-[10px] font-bold uppercase tracking-wide">
                      <CheckCircle2 className="w-2.5 h-2.5 sm:w-3 sm:h-3" />{' '}
                      <span className="hidden md:inline">Processed in</span>{' '}
                      {((result.json as { processing_time_ms?: number })?.processing_time_ms || 0) / 1000}s
                    </div>
                    <div className={`hidden sm:block h-4 w-px ${isDark ? 'bg-white/10' : 'bg-zinc-300'}`}></div>
                    <button
                      onClick={() => {
                        const currentSource = result.sources?.[activeSourceIndex];
                        const content =
                          activeTab === 'hqcc'
                            ? currentSource?.hqcc || result.hqcc
                            : activeTab === 'raw'
                              ? currentSource?.raw || result.raw
                              : JSON.stringify(result.json, null, 2);
                        copyToClipboard(content);
                      }}
                      className={`transition-colors p-1 ${isDark ? 'text-zinc-500 hover:text-white' : 'text-zinc-400 hover:text-zinc-900'}`}
                      title="Copy Content"
                    >
                      <Copy className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    </button>
                    <button
                      onClick={() => {
                        const currentSource = result.sources?.[activeSourceIndex];
                        let content = '';
                        let filename = '';
                        let mimeType = 'text/plain';

                        if (activeTab === 'hqcc') {
                          content = currentSource?.hqcc || result.hqcc;
                          filename = `hqcc-${Date.now()}.md`;
                          mimeType = 'text/markdown';
                        } else if (activeTab === 'raw') {
                          content = currentSource?.raw || result.raw;
                          filename = `raw-${Date.now()}.txt`;
                        } else {
                          content = JSON.stringify(result.json, null, 2);
                          filename = `meta-${Date.now()}.json`;
                          mimeType = 'application/json';
                        }

                        const blob = new Blob([content], { type: mimeType });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = filename;
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);

                        addToast('Result downloaded', 'success');
                      }}
                      className={`transition-colors p-1 ${isDark ? 'text-zinc-500 hover:text-white' : 'text-zinc-400 hover:text-zinc-900'}`}
                      title="Download Result"
                    >
                      <Download className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    </button>
                  </div>
                </div>

                {/* Result Stats Header Bar + Savings */}
                {(() => {
                  const json = result.json as Record<string, unknown>;
                  const cost = json.cost as Record<string, unknown> | undefined;
                  const savings = json.savings as
                    | {
                        originalTokens?: number;
                        compressedTokens?: number;
                        tokensSaved?: number;
                        moneySaved?: number;
                        compressionRatio?: string;
                      }
                    | undefined;
                  const processingMs = (json.processing_time_ms as number) || 0;
                  const isCached = !!(json.cached || cost?.cached);
                  const credits = (cost?.credits as number) || (cost?.credits_used as number) || 0;
                  const hqccLen = (result.sources?.[activeSourceIndex]?.hqcc || result.hqcc || '').length;
                  const rawLen = (result.sources?.[activeSourceIndex]?.raw || result.raw || '').length;
                  const compressionPct = rawLen > 0 ? Math.round((1 - hqccLen / rawLen) * 100) : 0;
                  const mode = (json.mode as string) || result.inputType || 'url';

                  return (
                    <>
                      {/* Savings Bar — immediate value display */}
                      {savings && savings.tokensSaved && savings.tokensSaved > 0 && (
                        <div
                          className={`px-4 py-2.5 flex items-center gap-3 ${isDark ? 'bg-emerald-500/5 border-b border-emerald-500/10' : 'bg-emerald-50 border-b border-emerald-100'}`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span
                                className={`text-xs font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}
                              >
                                {savings.originalTokens?.toLocaleString()} →{' '}
                                {savings.compressedTokens?.toLocaleString()} tokens ({savings.compressionRatio})
                              </span>
                              <span
                                className={`text-xs font-bold px-1.5 py-0.5 rounded ${isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-800'}`}
                              >
                                Saved ${savings.moneySaved?.toFixed(4)}
                              </span>
                            </div>
                            {/* Compression progress bar */}
                            <div
                              className={`h-1.5 rounded-full overflow-hidden ${isDark ? 'bg-zinc-800' : 'bg-zinc-200'}`}
                            >
                              <div
                                className="h-full bg-gradient-to-r from-emerald-500 to-cyan-500 rounded-full transition-all duration-500"
                                style={{
                                  width: `${savings.originalTokens ? Math.round(((savings.originalTokens - (savings.tokensSaved || 0)) / savings.originalTokens) * 100) : 100}%`,
                                }}
                              />
                            </div>
                          </div>
                        </div>
                      )}
                      <div
                        className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[10px] sm:text-xs ${isDark ? 'bg-zinc-950/50 border-b border-white/5' : 'bg-zinc-50/80 border-b border-zinc-200'}`}
                      >
                        {/* Cache badge */}
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-medium ${
                            isCached
                              ? isDark
                                ? 'bg-cyan-500/10 text-cyan-400'
                                : 'bg-cyan-100 text-cyan-700'
                              : isDark
                                ? 'bg-emerald-500/10 text-emerald-400'
                                : 'bg-emerald-100 text-emerald-700'
                          }`}
                        >
                          {isCached ? (
                            <>
                              <Database className="w-3 h-3" /> Cache HIT
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-3 h-3" /> Processed
                            </>
                          )}
                        </span>
                        {/* Mode */}
                        <span className={isDark ? 'text-zinc-500' : 'text-zinc-500'}>{mode}</span>
                        {/* Processing time */}
                        <span className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
                          {(processingMs / 1000).toFixed(1)}s
                        </span>
                        {/* Compression ratio */}
                        {compressionPct > 0 && (
                          <span className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
                            {compressionPct}% compressed
                          </span>
                        )}
                        {/* Cost */}
                        {credits > 0 && (
                          <span
                            className={`px-2 py-0.5 rounded-md ${isDark ? 'bg-amber-500/10 text-amber-400' : 'bg-amber-100 text-amber-700'}`}
                          >
                            {credits.toFixed(1)} credits
                          </span>
                        )}
                      </div>
                    </>
                  );
                })()}

                {/* Content Area */}
                <div
                  className={`flex-1 overflow-hidden relative flex flex-col lg:flex-row ${isDark ? 'bg-zinc-900' : 'bg-white'}`}
                >
                  {/* Compression Loading Overlay - Fixed at top */}
                  {isCompressingSource && (
                    <div className="absolute inset-0 z-50 bg-zinc-900/98 backdrop-blur-sm animate-in fade-in duration-200">
                      {/* Fixed Loading Header at Top */}
                      <div className="sticky top-0 px-6 py-6 bg-zinc-900 border-b border-white/5">
                        <div className="flex items-center gap-4">
                          <UniqueLoading variant="morph" size="md" />
                          <div className="flex-1 min-w-0">
                            <h3 className="text-base font-semibold text-white">Compressing Source</h3>
                            <p className="text-sm text-zinc-400 truncate">
                              {result.sources?.[activeSourceIndex]?.title}
                            </p>
                          </div>
                        </div>
                        {/* Animated progress line */}
                        <div className="mt-4 h-0.5 bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className="h-full w-full bg-gradient-to-r from-violet-500 via-cyan-500 to-violet-500 animate-pulse"
                            style={{ animation: 'shimmer 2s ease-in-out infinite' }}
                          />
                        </div>
                      </div>
                      {/* Content area - shows partial streaming if available */}
                      <div className="flex-1 overflow-auto p-6">
                        <p className="text-zinc-500 text-sm text-center">Extracting high-quality context with AI...</p>
                      </div>
                    </div>
                  )}

                  {activeTab === 'hqcc' && (
                    <>
                      {/* Source Info Banner - Only for Query inputs with multiple sources */}
                      {result.inputType === 'query' && result.sources && result.sources.length > 1 && (
                        <div
                          className={`absolute top-0 left-0 right-0 z-10 px-4 py-2 ${isDark ? 'bg-gradient-to-b from-zinc-900 via-zinc-900/95 to-transparent' : 'bg-gradient-to-b from-white via-white/95 to-transparent'}`}
                        >
                          <a
                            href={result.sources[activeSourceIndex]?.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-violet-400 hover:text-violet-300 flex items-center gap-1.5 transition-colors"
                          >
                            <Globe className="w-3 h-3" />
                            <span className="truncate">{result.sources[activeSourceIndex]?.url}</span>
                          </a>
                        </div>
                      )}
                      {/* Main Content */}
                      <div
                        className={`flex-1 overflow-auto p-4 sm:p-6 lg:p-8 ${result.inputType === 'query' && result.sources && result.sources.length > 1 ? 'pt-10' : ''}`}
                      >
                        <div className={`prose max-w-none ${isDark ? 'prose-invert prose-zinc' : 'prose-zinc'}`}>
                          {isProcessing && streamingContent ? (
                            <MarkdownRenderer content={streamingContent} />
                          ) : (
                            <MarkdownRenderer content={result.sources?.[activeSourceIndex]?.hqcc || result.hqcc} />
                          )}
                        </div>
                      </div>

                      {/* Floating TOC - Hidden by default, appears on hover */}
                      <div className="group/toc absolute right-0 top-0 bottom-0 z-20 hidden xl:flex">
                        {/* Hover trigger area */}
                        <div className="w-8 h-full flex items-start justify-center pt-4 cursor-pointer">
                          <div
                            className={`w-1 h-16 rounded-full group-hover/toc:opacity-0 transition-opacity ${isDark ? 'bg-white/10' : 'bg-zinc-300'}`}
                          />
                        </div>
                        {/* TOC Panel */}
                        <div
                          className={`w-56 border-l backdrop-blur-sm overflow-y-auto 
                        translate-x-full group-hover/toc:translate-x-0 transition-transform duration-300 ease-out shadow-2xl ${isDark ? 'border-white/10 bg-zinc-950/95' : 'border-zinc-200 bg-white/95'}`}
                        >
                          <div className="p-4 sticky top-0">
                            <h4
                              className={`text-[10px] font-bold uppercase tracking-wider mb-3 flex items-center gap-2 ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}
                            >
                              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M4 6h16M4 12h16M4 18h7"
                                />
                              </svg>
                              On This Page
                            </h4>
                            <nav className="space-y-1">
                              {(() => {
                                const toc: { level: number; title: string; slug: string }[] = [];
                                const slugify = (text: string) =>
                                  text
                                    .toLowerCase()
                                    .replace(/[^a-z0-9]+/g, '-')
                                    .replace(/(^-|-$)/g, '');

                                // Use active source content
                                const currentContent = result.sources?.[activeSourceIndex]?.hqcc || result.hqcc;
                                currentContent.split('\n').forEach((line) => {
                                  if (line.startsWith('# ') && !line.startsWith('## ')) {
                                    const title = line.replace('# ', '');
                                    toc.push({ level: 1, title, slug: slugify(title) });
                                  } else if (line.startsWith('## ')) {
                                    const title = line.replace('## ', '');
                                    toc.push({ level: 2, title, slug: slugify(title) });
                                  } else if (line.startsWith('### ')) {
                                    const title = line.replace('### ', '');
                                    toc.push({ level: 3, title, slug: slugify(title) });
                                  }
                                });

                                return toc.map((item, idx) => (
                                  <a
                                    key={idx}
                                    href={`#${item.slug}`}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      document
                                        .getElementById(item.slug)
                                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                                    }}
                                    className={`block text-xs transition-colors hover:text-white truncate ${
                                      item.level === 1
                                        ? 'text-zinc-300 font-medium py-1.5'
                                        : item.level === 2
                                          ? 'text-zinc-500 pl-3 py-1 hover:text-violet-400'
                                          : 'text-zinc-600 pl-6 py-0.5 hover:text-violet-400'
                                    }`}
                                    title={item.title}
                                  >
                                    {item.title}
                                  </a>
                                ));
                              })()}
                            </nav>
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {activeTab === 'raw' && (
                    <div className="flex-1 overflow-auto p-8">
                      <pre className="font-mono text-xs text-zinc-400 whitespace-pre-wrap leading-relaxed">
                        {result.sources?.[activeSourceIndex]?.raw || result.raw}
                      </pre>
                    </div>
                  )}

                  {activeTab === 'meta' && (
                    <div className="flex-1 overflow-auto p-8">
                      <pre className="font-mono text-xs text-zinc-300 whitespace-pre leading-relaxed">
                        <SyntaxHighlighter code={JSON.stringify(result.json, null, 2)} language="json" />
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PlaygroundPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[calc(100vh-64px)] items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
        </div>
      }
    >
      <PlaygroundContent />
    </Suspense>
  );
}
