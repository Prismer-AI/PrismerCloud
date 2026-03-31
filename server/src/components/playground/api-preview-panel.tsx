'use client';

import { useState, useEffect } from 'react';
import { Copy, Code2 } from 'lucide-react';
import { Strategy } from '@/types';
import { useTheme } from '@/contexts/theme-context';
import { SyntaxHighlighter } from '@/components/ui/syntax-highlighter';
import { GradientCard } from './gradient-card';

type CodeLanguage = 'curl' | 'python' | 'typescript' | 'go';

interface ApiKey {
  id: string;
  key: string;
  label: string;
}

interface ApiPreviewPanelProps {
  url: string;
  strategy: Strategy;
  codeLang: CodeLanguage;
  setCodeLang: (lang: CodeLanguage) => void;
  isAuthenticated: boolean;
  activeApiKey: ApiKey | null;
  onCopy: (text: string) => void;
}

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

function getApiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_BASE_URL || DEFAULT_API_BASE;
}

// Mask API key for display (show first 14 and last 4 chars)
function maskApiKey(key: string) {
  if (!key || key.length < 20) return 'sk-prismer-...';
  return `${key.slice(0, 14)}...${key.slice(-4)}`;
}

// Generate code with option for masked or real key
function getGeneratedCode(
  lang: CodeLanguage,
  targetUrl: string,
  strat: string,
  activeApiKey: ApiKey | null,
  forCopy: boolean = false,
  baseUrl: string = DEFAULT_API_BASE
) {
  const safeInput = targetUrl || 'https://example.com/article';
  const realKey = activeApiKey?.key || 'sk-prismer-YOUR_API_KEY';
  const displayKey = forCopy ? realKey : (activeApiKey ? maskApiKey(realKey) : 'sk-prismer-...');
  const endpoint = `${baseUrl}/api/context/load`;

  switch (lang) {
    case 'curl':
      return `curl -X POST "${endpoint}" \\
  -H "Authorization: Bearer ${displayKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "input": "${safeInput}"
  }'`;
    case 'python':
      return `from prismer import Prismer

client = Prismer(api_key="${displayKey}")

# Smart context loading — auto-detects URL, batch, or query
result = client.context.load("${safeInput}")

print(f"Cached: {result.cached}")
print(f"Mode: {result.mode}")
print(f"Content: {result.hqcc[:200]}...")

# Parse a document
doc = client.parse("${safeInput}", mode="fast")
print(f"Pages: {doc.page_count}")`;
    case 'typescript':
      return `import Prismer from '@prismer/sdk'

const client = new Prismer({ apiKey: '${displayKey}' })

// Smart context loading — auto-detects URL, batch, or query
const result = await client.context.load('${safeInput}')

console.log(\`Cached: \${result.cached}\`)
console.log(\`Mode: \${result.mode}\`)
console.log(\`Content: \${result.hqcc.slice(0, 200)}...\`)

// Parse a document
const doc = await client.parse('${safeInput}', { mode: 'fast' })
console.log(\`Pages: \${doc.pageCount}\`)`;
    case 'go':
      return `import "github.com/prismer/prismer-go"

client := prismer.New("${displayKey}")

// Smart context loading — auto-detects URL, batch, or query
result, err := client.Context.Load("${safeInput}")
if err != nil {
    log.Fatal(err)
}

fmt.Printf("Cached: %v\\n", result.Cached)
fmt.Printf("Mode: %s\\n", result.Mode)
fmt.Printf("Content: %s...\\n", result.HQCC[:200])

// Parse a document
doc, _ := client.Parse("${safeInput}", &prismer.ParseOpts{Mode: "fast"})
fmt.Printf("Pages: %d\\n", doc.PageCount)`;
    default:
      return '';
  }
}

export function ApiPreviewPanel({
  url,
  strategy,
  codeLang,
  setCodeLang,
  isAuthenticated,
  activeApiKey,
  onCopy,
}: ApiPreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const languages: CodeLanguage[] = ['python', 'curl', 'typescript', 'go'];
  
  // Track API base URL - use default during SSR, update on client
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE);
  
  useEffect(() => {
    // Update to correct URL after mount (client-side only)
    setApiBaseUrl(getApiBaseUrl());
  }, []);

  return (
    <GradientCard 
      gradientFrom="#123391" 
      gradientTo="#7285FF"
      disabled={!isAuthenticated}
      isDark={isDark}
    >
      <div className={`relative z-20 backdrop-blur-xl border rounded-2xl sm:rounded-3xl overflow-hidden shadow-xl flex flex-col min-h-[200px] sm:min-h-[300px] transition-all duration-500 ease-out group-hover:translate-x-[-6px] group-hover:shadow-[0_0_40px_rgba(59,130,246,0.15)] ${
        isDark 
          ? (!isAuthenticated ? 'bg-zinc-950/60 border-zinc-800/50' : 'bg-zinc-950/60 border-white/10 group-hover:border-white/20')
          : (!isAuthenticated ? 'bg-white/60 border-zinc-200/50' : 'bg-white/80 border-blue-200/50 group-hover:border-blue-300/50')
      }`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-3 sm:px-4 py-2 sm:py-3 ${isDark ? 'bg-white/5 border-b border-white/5' : 'bg-zinc-50/80 border-b border-zinc-200'}`}>
          <div className={`flex items-center gap-2 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            <Code2 className="w-3 h-3 sm:w-4 sm:h-4" />
            <span className="text-[10px] sm:text-xs font-bold uppercase tracking-wider hidden sm:inline">Live API Preview</span>
            <span className="text-[10px] font-bold uppercase tracking-wider sm:hidden">API</span>
            {!isAuthenticated && (
              <span className={`px-1.5 py-0.5 rounded text-[8px] font-medium ${isDark ? 'bg-zinc-800 text-zinc-500' : 'bg-zinc-200 text-zinc-500'}`}>LOCKED</span>
            )}
          </div>
          <div className="flex gap-0.5 sm:gap-1">
            {languages.map((lang) => (
              <button
                key={lang}
                onClick={() => setCodeLang(lang)}
                disabled={!isAuthenticated}
                className={`px-1.5 sm:px-2 py-0.5 sm:py-1 rounded text-[8px] sm:text-[10px] font-bold uppercase transition-all
                  ${codeLang === lang
                    ? 'bg-violet-500/20 text-violet-300 ring-1 ring-violet-500/50'
                    : (isDark ? 'text-zinc-600 hover:text-zinc-400 hover:bg-white/5' : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100')
                  }
                  ${!isAuthenticated ? 'cursor-not-allowed opacity-50' : ''}
                `}
              >
                {lang}
              </button>
            ))}
          </div>
        </div>

        {/* API Key Status */}
        {!isAuthenticated ? (
          <div className={`px-3 sm:px-4 py-2 sm:py-3 text-[10px] sm:text-xs flex items-center justify-between ${isDark ? 'border-b border-white/5 bg-zinc-900/50' : 'border-b border-zinc-200 bg-zinc-50/50'}`}>
            <div className={`flex items-center gap-2 ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isDark ? 'bg-zinc-600' : 'bg-zinc-400'}`}></span>
              <span>Sign in to unlock API access</span>
            </div>
            <a 
              href="/auth" 
              className="px-2 py-1 rounded-md bg-violet-500/20 text-violet-400 hover:bg-violet-500/30 hover:text-violet-300 text-[10px] font-semibold transition-all"
            >
              Get API Key →
            </a>
          </div>
        ) : (
          <div className={`px-3 sm:px-4 py-1.5 sm:py-2 text-[10px] sm:text-xs flex items-center gap-2 ${isDark ? 'border-b border-white/5' : 'border-b border-zinc-200'} ${
            activeApiKey ? 'bg-violet-500/5 text-violet-300' : 'bg-amber-500/5 text-amber-400'
          }`}>
            {activeApiKey ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse"></span>
                <span>Using: <code className="font-mono bg-violet-500/10 px-1 rounded">{activeApiKey.label}</code></span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                <span>No API key selected. <a href="/dashboard#api-keys" className="underline hover:text-amber-300">Activate one in Dashboard</a></span>
              </>
            )}
          </div>
        )}

        {/* Code Preview */}
        <div className="relative flex-1 group/code">
          {/* Copy button */}
          <div className={`absolute top-2 sm:top-4 right-2 sm:right-4 transition-opacity z-10 ${
            isAuthenticated ? 'opacity-100 sm:opacity-0 group-hover/code:opacity-100' : 'opacity-30'
          }`}>
            <button
              onClick={() => isAuthenticated && onCopy(getGeneratedCode(codeLang, url, strategy, activeApiKey, true, apiBaseUrl))}
              disabled={!isAuthenticated}
              className={`p-1.5 sm:p-2 rounded-md sm:rounded-lg transition-colors ${
                isDark 
                  ? 'bg-zinc-800 text-zinc-400' + (isAuthenticated ? ' hover:bg-zinc-700 hover:text-white cursor-pointer' : ' cursor-not-allowed')
                  : 'bg-zinc-200 text-zinc-600' + (isAuthenticated ? ' hover:bg-zinc-300 hover:text-zinc-900 cursor-pointer' : ' cursor-not-allowed')
              }`}
              title={isAuthenticated ? "Copy Code (with full API key)" : "Sign in to copy API code"}
            >
              <Copy className="w-3 h-3 sm:w-4 sm:h-4" />
            </button>
          </div>
          
          <pre className={`p-3 sm:p-6 font-mono text-[10px] sm:text-xs leading-relaxed overflow-x-auto custom-scrollbar ${
            isAuthenticated 
              ? (isDark ? 'text-zinc-400' : 'text-zinc-600')
              : (isDark ? 'text-zinc-600 select-none' : 'text-zinc-400 select-none')
          }`}>
            <SyntaxHighlighter code={getGeneratedCode(codeLang, url, strategy, activeApiKey, false, apiBaseUrl)} language={codeLang} />
          </pre>
          
          {/* Overlay for non-authenticated users */}
          {!isAuthenticated && (
            <div className={`absolute inset-0 flex items-center justify-center backdrop-blur-[1px] ${isDark ? 'bg-zinc-950/60' : 'bg-white/60'}`}>
              <a 
                href="/auth"
                className="px-4 py-2 rounded-lg bg-gradient-to-r from-violet-600 to-cyan-500 text-white text-sm font-semibold hover:opacity-90 transition-opacity shadow-lg"
              >
                Sign In to Unlock API
              </a>
            </div>
          )}
        </div>
      </div>
    </GradientCard>
  );
}

