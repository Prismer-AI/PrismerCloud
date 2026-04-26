'use client';

import { useState, useEffect } from 'react';
import {
  Copy,
  Database,
  Code2,
  Play,
  ChevronRight,
  Loader2,
  Check,
  X,
  Key,
  Bot,
  MessageSquare,
  FileText,
  CreditCard,
  AlertCircle,
  Download,
  Radio,
  Upload,
  Terminal,
  Globe,
  Search,
  Dna,
  BookOpen,
  Brain,
  ListTodo,
  Fingerprint,
} from 'lucide-react';
import { useApp } from '@/contexts/app-context';
import { useTheme } from '@/contexts/theme-context';
import { VERSION } from '@/lib/version';
import Link from 'next/link';
import MarkdownRenderer from '@/components/ui/markdown-renderer';
import { CodeBlock } from '@/components/ui/code-block';

// ============================================================================
// Types (from OpenAPI spec)
// ============================================================================

interface CodeSample {
  lang: string;
  label: string;
  source: string;
}

interface InputMode {
  name: string;
  description?: string;
  input: string;
}

interface EventDef {
  event: string;
  description?: string;
  payload?: Record<string, unknown>;
}

interface Parameter {
  name: string;
  in: string;
  required: boolean;
  type: string;
  description: string;
  default?: unknown;
  enum?: string[];
}

interface NamedExample {
  name: string;
  value: unknown;
}

interface ProcessedEndpoint {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  section: string;
  tag: string;
  phaseNumber?: number;
  phaseTitle?: string;
  protocol?: 'websocket' | 'sse' | 'webhook';
  modes?: InputMode[];
  parameters?: Parameter[];
  bodyFields?: Parameter[];
  exampleRequests?: NamedExample[];
  exampleResponses?: NamedExample[];
  codeSamples?: CodeSample[];
  events?: { send?: EventDef[]; receive?: EventDef[] };
}

interface Phase {
  number: number;
  title: string;
  endpointIds: string[];
}

interface Section {
  id: string;
  title: string;
  description?: string;
  phases?: Phase[];
}

interface ProcessedSpec {
  info: { title: string; version: string; description: string };
  sections: Section[];
  endpoints: ProcessedEndpoint[];
}

// Language selector
type DocLanguage = 'typescript' | 'python' | 'go' | 'bash';
const DOC_LANGUAGES: { id: DocLanguage; label: string }[] = [
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'go', label: 'Go' },
  { id: 'bash', label: 'REST' },
];

interface DocSection {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
}

// Static sections that always appear
const STATIC_SECTIONS: DocSection[] = [{ id: 'developer', title: 'Developer Tools', icon: Bot }];

// Section icon mapping
const SECTION_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  context: Database,
  parse: FileText,
  im: MessageSquare,
  files: Upload,
  webhook: Globe,
  realtime: Radio,
  evolution: Dna,
  skills: BookOpen,
};

// Per-language setup preamble — prepended to code samples for completeness
const LANG_PREAMBLE: Record<string, { install: string; setup: string }> = {
  typescript: {
    install: 'npm install @prismer/sdk',
    setup: `import { PrismerClient } from '@prismer/sdk';

const client = new PrismerClient({
  apiKey: process.env.PRISMER_API_KEY,
});`,
  },
  python: {
    install: 'pip install prismer',
    setup: `from prismer import PrismerClient

client = PrismerClient(api_key=os.getenv("PRISMER_API_KEY"))`,
  },
  go: {
    install: 'go get github.com/Prismer-AI/Prismer/sdk/golang',
    setup: `import prismer "github.com/Prismer-AI/Prismer/sdk/golang"

client := prismer.NewClient(os.Getenv("PRISMER_API_KEY"))
ctx := context.Background()`,
  },
  bash: {
    install: '',
    setup: `# Base URL
BASE="https://prismer.cloud"
# API Key
API_KEY="sk-prismer-..."`,
  },
};

// ============================================================================
// Utility Functions
// ============================================================================

// Map code sample lang to CodeBlock language
function codeBlockLang(lang: string): string {
  if (lang === 'bash') return 'bash';
  if (lang === 'go') return 'go';
  if (lang === 'python') return 'python';
  return 'typescript';
}

// Auto-complete code samples: prepend import + init if the sample doesn't already include them
function completeCodeSample(source: string, lang: string): string {
  // bash/curl samples are self-contained
  if (lang === 'bash') return source;

  const trimmed = source.trim();

  // Already has imports — render as-is
  if (lang === 'typescript' && (trimmed.startsWith('import ') || trimmed.startsWith('const {'))) return source;
  if (lang === 'python' && (trimmed.startsWith('import ') || trimmed.startsWith('from '))) return source;
  if (lang === 'go' && (trimmed.startsWith('import ') || trimmed.startsWith('package '))) return source;

  // Prepend the preamble
  const preamble = LANG_PREAMBLE[lang];
  if (!preamble?.setup) return source;
  return preamble.setup + '\n\n' + source;
}

// ============================================================================
// Components
// ============================================================================

// Quick Start block — shows install command for active language
function QuickStartBlock({ activeLang, isDark }: { activeLang: DocLanguage; isDark: boolean }) {
  const preamble = LANG_PREAMBLE[activeLang];
  if (!preamble?.install) return null;

  const langLabel = DOC_LANGUAGES.find((l) => l.id === activeLang)?.label || activeLang;

  return (
    <div
      className={`mb-6 rounded-2xl overflow-hidden ${isDark ? 'border border-white/10 bg-zinc-900/30' : 'border border-zinc-200 bg-white shadow-sm'}`}
    >
      <div className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Terminal className="w-3.5 h-3.5 text-zinc-500" />
          <h4 className={`text-xs font-bold uppercase tracking-wider ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            Install {langLabel} SDK
          </h4>
        </div>
        <CodeBlock code={preamble.install} language="bash" isDark={isDark} />
      </div>
    </div>
  );
}

// Developer Tools Section - Skill.md preview and copy
function DeveloperToolsSection({ isDark }: { isDark: boolean }) {
  const { addToast } = useApp();
  const [skillContent, setSkillContent] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadDocs() {
      try {
        const res = await fetch('/api/docs/developer');
        const data = await res.json();
        if (data.success) {
          setSkillContent(data.docs.skill.content);
        }
      } catch (e) {
        console.error('Failed to load developer docs:', e);
      } finally {
        setLoading(false);
      }
    }
    loadDocs();
  }, []);

  const copyLink = async () => {
    const url = `${window.location.origin}/docs/Skill.md`;
    await navigator.clipboard.writeText(url);
    addToast('Skill.md link copied', 'success');
  };

  return (
    <div id="developer" className="scroll-mt-20">
      <h2 className={`text-2xl font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Developer Tools</h2>
      <p className={`mb-6 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
        Integrations and documentation for AI coding assistants and agent frameworks.
      </p>

      {/* Integration Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {/* MCP Server */}
        <div
          className={`rounded-2xl p-5 ${isDark ? 'bg-zinc-900/50 border border-white/10' : 'bg-white border border-zinc-200'}`}
        >
          <div className="flex items-center gap-3 mb-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center ${isDark ? 'bg-violet-500/15' : 'bg-violet-100'}`}
            >
              <Terminal className={`w-5 h-5 ${isDark ? 'text-violet-400' : 'text-violet-600'}`} />
            </div>
            <div>
              <h3 className={`font-semibold ${isDark ? 'text-white' : 'text-zinc-900'}`}>MCP Server</h3>
              <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>Claude Code / Cursor / Windsurf</p>
            </div>
          </div>
          <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            26 tools across 7 domains: Context (load, save), Parse, IM (discover, send, edit, delete), Evolution
            (analyze, record, create, distill, browse, import, report, achievements, sync, export), Memory (write, read,
            recall), Tasks (create), Skills (search, install, uninstall, installed, content).
          </p>
          <CodeBlock code="npx -y @prismer/mcp-server" language="bash" isDark={isDark} />
          <details className={`mt-3 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            <summary className="cursor-pointer hover:text-violet-400 transition-colors">
              .mcp.json configuration
            </summary>
            <CodeBlock
              code={`{
  "mcpServers": {
    "prismer": {
      "command": "npx",
      "args": ["-y", "@prismer/mcp-server"],
      "env": { "PRISMER_API_KEY": "sk-prismer-xxx" }
    }
  }
}`}
              language="json"
              isDark={isDark}
            />
          </details>
        </div>

        {/* OpenClaw Plugin */}
        <div
          className={`rounded-2xl p-5 ${isDark ? 'bg-zinc-900/50 border border-white/10' : 'bg-white border border-zinc-200'}`}
        >
          <div className="flex items-center gap-3 mb-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center ${isDark ? 'bg-emerald-500/15' : 'bg-emerald-100'}`}
            >
              <Globe className={`w-5 h-5 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`} />
            </div>
            <div>
              <h3 className={`font-semibold ${isDark ? 'text-white' : 'text-zinc-900'}`}>OpenClaw Channel</h3>
              <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>Agent Framework Plugin</p>
            </div>
          </div>
          <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            14 agent tools: context, parsing, messaging, discovery, evolution (analyze, record, report, distill, browse,
            import, create), memory, and recall. Auto-register + WebSocket inbound.
          </p>
          <CodeBlock code="openclaw plugins install @prismer/openclaw-channel" language="bash" isDark={isDark} />
          <details className={`mt-3 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
            <summary className="cursor-pointer hover:text-emerald-400 transition-colors">
              config.json configuration
            </summary>
            <CodeBlock
              code={`{
  "channels": {
    "prismer": {
      "accounts": {
        "default": {
          "apiKey": "sk-prismer-xxx",
          "agentName": "my-agent",
          "capabilities": ["chat", "search"]
        }
      }
    }
  }
}`}
              language="json"
              isDark={isDark}
            />
          </details>
        </div>
      </div>

      {/* SDKs */}
      <div
        className={`rounded-2xl p-5 mb-8 ${isDark ? 'bg-zinc-900/50 border border-white/10' : 'bg-white border border-zinc-200'}`}
      >
        <h3 className={`font-semibold mb-3 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Official SDKs</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { lang: 'TypeScript', pkg: '@prismer/sdk', install: 'npm i @prismer/sdk', color: 'text-blue-400' },
            { lang: 'Python', pkg: 'prismer', install: 'pip install prismer', color: 'text-yellow-400' },
            {
              lang: 'Go',
              pkg: 'prismer-sdk-go',
              install: 'go get github.com/Prismer-AI/Prismer/sdk/golang',
              color: 'text-cyan-400',
            },
            { lang: 'Rust', pkg: 'prismer-sdk', install: 'cargo add prismer-sdk', color: 'text-orange-400' },
          ].map((sdk) => (
            <div
              key={sdk.lang}
              className={`rounded-xl p-3 ${isDark ? 'bg-zinc-800/50 border border-white/5' : 'bg-zinc-50 border border-zinc-200'}`}
            >
              <p className={`text-sm font-medium mb-1 ${sdk.color}`}>{sdk.lang}</p>
              <code className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{sdk.install}</code>
            </div>
          ))}
        </div>
      </div>

      {/* Skill.md */}
      <h3 className={`font-semibold mb-3 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Skill.md</h3>
      <p className={`text-sm mb-4 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
        Drop this file into your project for AI-assisted API integration.
      </p>
      <div className="flex flex-wrap gap-3 mb-4">
        <button
          onClick={copyLink}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium transition-all bg-violet-600 text-white shadow-lg shadow-violet-500/25"
        >
          <Copy className="w-4 h-4" />
          Copy Skill.md Link
        </button>
      </div>

      {/* Document Preview */}
      <div
        className={`rounded-2xl overflow-hidden ${isDark ? 'border border-white/10 bg-zinc-900/50' : 'border border-zinc-200 bg-white'}`}
      >
        <div
          className={`px-4 py-3 ${isDark ? 'bg-zinc-800/50 border-b border-white/5' : 'bg-zinc-50 border-b border-zinc-200'}`}
        >
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-violet-400" />
            <span className={`font-mono text-sm ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Skill.md</span>
          </div>
        </div>
        <div className={`p-6 max-h-[500px] overflow-y-auto ${isDark ? 'prose-invert' : ''}`}>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
            </div>
          ) : (
            <MarkdownRenderer content={skillContent} className="prose prose-sm max-w-none" />
          )}
        </div>
      </div>
    </div>
  );
}

// API Tester / SDK Preview Component
function ApiTester({
  endpoint,
  activeLang,
  isDark = true,
}: {
  endpoint: ProcessedEndpoint;
  activeLang: DocLanguage;
  isDark?: boolean;
}) {
  const { isAuthenticated, activeApiKey } = useApp();
  const firstExample = endpoint.exampleRequests?.[0]?.value;
  const [requestBody, setRequestBody] = useState(firstExample ? JSON.stringify(firstExample, null, 2) : '{}');
  const [manualApiKey, setManualApiKey] = useState('');
  const [useManualKey, setUseManualKey] = useState(false);
  const [response, setResponse] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [copiedCurl, setCopiedCurl] = useState(false);

  // Path parameter substitution state
  const pathParams = (endpoint.parameters || []).filter((p) => p.in === 'path');
  const [pathValues, setPathValues] = useState<Record<string, string>>(() => {
    const defaults: Record<string, string> = {};
    pathParams.forEach((p) => {
      defaults[p.name] = p.default ? String(p.default) : '';
    });
    return defaults;
  });

  const effectiveApiKey = useManualKey ? manualApiKey : activeApiKey?.key || '';

  // Build resolved URL with path param substitution
  const resolvedPath = endpoint.path.replace(/\{(\w+)\}/g, (_, name) => pathValues[name] || `{${name}}`);

  const buildCurlCommand = () => {
    const method = endpoint.method === 'WS' ? 'GET' : endpoint.method;
    const url = `${typeof window !== 'undefined' ? window.location.origin : 'https://prismer.cloud'}${resolvedPath}`;
    let cmd = `curl -X ${method} '${url}'`;
    if (effectiveApiKey) cmd += ` \\\n  -H 'Authorization: Bearer ${effectiveApiKey}'`;
    if (method !== 'GET' && method !== 'DELETE') {
      cmd += ` \\\n  -H 'Content-Type: application/json'`;
      cmd += ` \\\n  -d '${requestBody.replace(/\n/g, '')}'`;
    }
    return cmd;
  };

  const copyCurl = () => {
    navigator.clipboard.writeText(buildCurlCommand());
    setCopiedCurl(true);
    setTimeout(() => setCopiedCurl(false), 1500);
  };

  const executeRequest = async () => {
    setLoading(true);
    setResponse(null);
    const startTime = Date.now();

    try {
      const body = JSON.parse(requestBody);
      const res = await fetch(resolvedPath, {
        method: endpoint.method === 'WS' ? 'GET' : endpoint.method,
        headers: {
          'Content-Type': 'application/json',
          ...(effectiveApiKey ? { Authorization: `Bearer ${effectiveApiKey}` } : {}),
        },
        ...(endpoint.method !== 'GET' && endpoint.method !== 'DELETE' ? { body: JSON.stringify(body) } : {}),
      });

      const data = await res.json();
      setElapsed(Date.now() - startTime);
      setResponse({ status: res.status, ok: res.ok, data });
    } catch (error: unknown) {
      setElapsed(Date.now() - startTime);
      setResponse({ error: error instanceof Error ? error.message : 'Request failed' });
    } finally {
      setLoading(false);
    }
  };

  // Don't show tester for WebSocket/SSE/webhook endpoints
  if (endpoint.protocol) return null;

  // SDK languages: show code sample instead of HTTP tester
  if (activeLang !== 'bash') {
    const codeSample = endpoint.codeSamples?.find((s) => s.lang === activeLang);
    if (!codeSample) {
      return (
        <div
          className={`mt-6 rounded-xl p-4 text-center text-xs ${isDark ? 'bg-zinc-900/30 border border-white/5 text-zinc-500' : 'bg-zinc-50 border border-zinc-200 text-zinc-400'}`}
        >
          No {activeLang} SDK sample — try{' '}
          {endpoint.codeSamples?.length ? endpoint.codeSamples.map((s) => s.label).join(', ') : 'REST mode for curl'}
        </div>
      );
    }

    return (
      <div
        className={`mt-6 rounded-xl overflow-hidden ${isDark ? 'border border-white/10 bg-zinc-900/50' : 'border border-zinc-200 bg-zinc-50'}`}
      >
        <div
          className={`px-4 py-3 flex items-center justify-between ${isDark ? 'border-b border-white/5' : 'border-b border-zinc-200'}`}
        >
          <h4 className={`text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
            SDK Usage — {activeLang === 'typescript' ? 'TypeScript' : activeLang === 'python' ? 'Python' : 'Go'}
          </h4>
          <span
            className={`text-xs px-2 py-0.5 rounded ${isDark ? 'bg-violet-500/10 text-violet-400' : 'bg-violet-100 text-violet-700'}`}
          >
            {codeSample.label}
          </span>
        </div>
        <div className="p-4">
          <CodeBlock
            code={completeCodeSample(codeSample.source, codeSample.lang)}
            language={codeBlockLang(codeSample.lang)}
            isDark={isDark}
          />
        </div>
      </div>
    );
  }

  // curl / bash: show interactive HTTP tester
  return (
    <div
      className={`mt-6 rounded-xl overflow-hidden ${isDark ? 'border border-white/10 bg-zinc-900/50' : 'border border-zinc-200 bg-zinc-50'}`}
    >
      <div className={`p-4 ${isDark ? 'border-b border-white/5' : 'border-b border-zinc-200'}`}>
        <div className="flex items-center justify-between mb-3">
          <h4 className={`text-sm font-medium ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Try it out</h4>
          <div className="flex items-center gap-2">
            <button
              onClick={copyCurl}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                isDark
                  ? 'bg-zinc-800 text-zinc-400 hover:text-white border border-white/10'
                  : 'bg-zinc-100 text-zinc-600 hover:text-zinc-900 border border-zinc-200'
              }`}
            >
              {copiedCurl ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              {copiedCurl ? 'Copied!' : 'curl'}
            </button>
            <button
              onClick={executeRequest}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 text-white text-xs font-medium rounded-lg transition-colors"
            >
              {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              Execute
            </button>
          </div>
        </div>

        {/* Path parameter substitution inputs */}
        {pathParams.length > 0 && (
          <div
            className={`mb-3 p-3 rounded-lg ${isDark ? 'bg-zinc-800/50 border border-white/5' : 'bg-zinc-50 border border-zinc-200'}`}
          >
            <div className="text-[10px] font-medium text-zinc-500 uppercase mb-2">Path Parameters</div>
            <div className="flex flex-wrap gap-2">
              {pathParams.map((p) => (
                <div key={p.name} className="flex items-center gap-1.5">
                  <label
                    className={`text-xs font-mono ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}
                  >{`{${p.name}}`}</label>
                  <input
                    type="text"
                    value={pathValues[p.name] || ''}
                    onChange={(e) => setPathValues((prev) => ({ ...prev, [p.name]: e.target.value }))}
                    placeholder={p.description || p.name}
                    className={`px-2 py-1 text-xs rounded font-mono focus:outline-none ${
                      isDark
                        ? 'bg-zinc-900 border border-white/10 text-zinc-300 placeholder:text-zinc-600'
                        : 'bg-white border border-zinc-300 text-zinc-700 placeholder:text-zinc-400'
                    }`}
                  />
                </div>
              ))}
            </div>
            <div className={`mt-2 text-[10px] font-mono ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
              → {resolvedPath}
            </div>
          </div>
        )}

        <div
          className={`text-xs flex items-center justify-between p-2 rounded-lg ${
            !isAuthenticated
              ? isDark
                ? 'bg-zinc-800/50 text-zinc-500'
                : 'bg-zinc-200 text-zinc-600'
              : activeApiKey
                ? 'bg-violet-500/10 text-violet-300 border border-violet-500/20'
                : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
          }`}
        >
          <div className="flex items-center gap-2">
            <Key className="w-3 h-3" />
            {!isAuthenticated ? (
              <span>
                <Link href="/auth" className="text-violet-400 hover:underline">
                  Sign in
                </Link>{' '}
                to use your API key
              </span>
            ) : activeApiKey ? (
              <span>
                Using: <code className="font-mono bg-violet-500/10 px-1.5 py-0.5 rounded">{activeApiKey.label}</code>
              </span>
            ) : (
              <span>
                No API key selected.{' '}
                <Link href="/dashboard#api-keys" className="underline">
                  Activate one
                </Link>
              </span>
            )}
          </div>
        </div>

        {(!isAuthenticated || !activeApiKey || useManualKey) && (
          <input
            type="password"
            placeholder="Enter API Key manually"
            value={manualApiKey}
            onChange={(e) => {
              setManualApiKey(e.target.value);
              setUseManualKey(true);
            }}
            className={`mt-2 w-full px-3 py-2 text-xs rounded-lg font-mono focus:outline-none ${
              isDark
                ? 'bg-zinc-800 border border-white/10 text-zinc-300'
                : 'bg-white border border-zinc-300 text-zinc-700'
            }`}
          />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-white/5">
        <div className="p-4">
          <span className="text-xs font-medium text-zinc-500 uppercase">Request Body</span>
          <textarea
            value={requestBody}
            onChange={(e) => setRequestBody(e.target.value)}
            className="mt-2 w-full h-40 p-3 bg-zinc-950 border border-white/5 rounded-lg font-mono text-xs text-zinc-300 resize-none focus:outline-none"
            spellCheck={false}
          />
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">Response</span>
            {elapsed !== null && <span className="text-xs text-zinc-500">{elapsed}ms</span>}
          </div>
          <div className="mt-2 w-full h-40 p-3 bg-zinc-950 border border-white/5 rounded-lg font-mono text-xs overflow-auto">
            {loading ? (
              <div className="flex items-center justify-center h-full text-zinc-500">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : response ? (
              <div>
                {'status' in response && (
                  <div className={`flex items-center gap-2 mb-2 ${response.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                    {response.ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                    <span>{String(response.status)}</span>
                  </div>
                )}
                <pre className="text-zinc-300 whitespace-pre-wrap">
                  {JSON.stringify(response.data || response.error, null, 2)}
                </pre>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full text-zinc-500">Click Execute to test</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Parameter table component — reused for query/path params and body fields
function ParamTable({
  params,
  title,
  isDark,
  showNesting = false,
}: {
  params: Parameter[];
  title: string;
  isDark: boolean;
  showNesting?: boolean;
}) {
  return (
    <div className="p-5 pt-0">
      <h4 className="text-xs font-bold uppercase tracking-wider mb-3 text-zinc-500">{title}</h4>
      <div
        className={`rounded-xl overflow-hidden ${isDark ? 'bg-zinc-950 border border-white/5' : 'bg-zinc-50 border border-zinc-200'}`}
      >
        <table className="w-full text-xs">
          <thead className={isDark ? 'bg-zinc-800/50' : 'bg-zinc-100'}>
            <tr>
              <th className="text-left px-3 py-2 font-medium text-zinc-400">Field</th>
              <th className="text-left px-3 py-2 font-medium text-zinc-400">Type</th>
              <th className="text-left px-3 py-2 font-medium text-zinc-400">Req</th>
              <th className="text-left px-3 py-2 font-medium text-zinc-400">Default</th>
              <th className="text-left px-3 py-2 font-medium text-zinc-400">Description</th>
            </tr>
          </thead>
          <tbody className={`divide-y ${isDark ? 'divide-white/5' : 'divide-zinc-200'}`}>
            {params.map((param, i) => {
              const nestDepth = showNesting ? param.name.split('.').length - 1 : 0;
              const displayName = showNesting && nestDepth > 0 ? param.name.split('.').pop()! : param.name;
              return (
                <tr key={i}>
                  <td className="px-3 py-2 font-mono text-emerald-400">
                    {nestDepth > 0 && (
                      <span className="text-zinc-600" style={{ paddingLeft: `${(nestDepth - 1) * 12}px` }}>
                        {'└ '}
                      </span>
                    )}
                    {displayName}
                  </td>
                  <td className="px-3 py-2 font-mono text-violet-400 whitespace-nowrap">
                    {param.type}
                    {param.enum ? <span className="text-zinc-500 font-normal"> ({param.enum.join(' | ')})</span> : null}
                  </td>
                  <td className="px-3 py-2">
                    {param.required ? (
                      <span className="text-amber-400 font-medium">Y</span>
                    ) : (
                      <span className="text-zinc-500">N</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-zinc-500">
                    {param.default !== undefined ? String(param.default) : '—'}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{param.description}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Cost lookup by operationId pattern
const ENDPOINT_COSTS: Record<string, string> = {
  contextLoad: '~8 cr/1K tok (new), free (cached)',
  contextSave: 'Free',
  parse: '2 cr/page (fast), 5 cr/page (hires)',
  imSendMessage: '0.001 cr',
  imSendDirectMessage: '0.001 cr',
  imWorkspaceInit: '0.01 cr',
  imWorkspaceInitGroup: '0.01 cr',
  imFilePresign: '0.5 cr/MB',
};

// Endpoint Card Component — data-driven from OpenAPI spec
function EndpointCard({
  endpoint,
  activeLang,
  isDark = true,
}: {
  endpoint: ProcessedEndpoint;
  activeLang: DocLanguage;
  isDark?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [activeExampleIdx, setActiveExampleIdx] = useState(0);

  // Find code sample for active language
  const codeSample = endpoint.codeSamples?.find((s) => s.lang === activeLang);

  // Cost badge
  const costLabel = ENDPOINT_COSTS[endpoint.operationId];

  // Method badge color
  const methodColor =
    endpoint.method === 'POST'
      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
      : endpoint.method === 'PATCH'
        ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
        : endpoint.method === 'DELETE'
          ? 'bg-red-500/10 text-red-400 border-red-500/20'
          : endpoint.method === 'WS'
            ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
            : 'bg-blue-500/10 text-blue-400 border-blue-500/20';

  // Determine max examples count for tab labels
  const maxExamples = Math.max(endpoint.exampleRequests?.length || 0, endpoint.exampleResponses?.length || 0);

  return (
    <div
      className={`rounded-2xl overflow-hidden ${isDark ? 'border border-white/10 bg-zinc-900/30' : 'border border-zinc-200 bg-white shadow-sm'}`}
    >
      {/* Header — always visible */}
      <div
        className={`p-5 cursor-pointer transition-colors ${isDark ? 'hover:bg-white/[0.02]' : 'hover:bg-zinc-50'}`}
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <span className={`px-2.5 py-1 font-mono text-xs font-bold border rounded ${methodColor}`}>
              {endpoint.method}
            </span>
            <h3 className={`font-mono text-sm ${isDark ? 'text-white' : 'text-zinc-900'}`}>{endpoint.path}</h3>
          </div>
          <ChevronRight
            className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
        <div className="flex items-center gap-2 mt-2">
          <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>{endpoint.summary}</p>
          {costLabel && (
            <span
              className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium ${
                costLabel === 'Free'
                  ? isDark
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                  : isDark
                    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                    : 'bg-amber-100 text-amber-700 border border-amber-200'
              }`}
            >
              <CreditCard className="w-3 h-3" />
              {costLabel}
            </span>
          )}
        </div>
      </div>

      {/* Code Sample — always visible, switches with language */}
      {codeSample ? (
        <div className="px-5 pb-4">
          <CodeBlock
            code={completeCodeSample(codeSample.source, codeSample.lang)}
            language={codeBlockLang(codeSample.lang)}
            isDark={isDark}
          />
        </div>
      ) : (
        <div
          className={`mx-5 mb-4 px-4 py-3 rounded-xl text-xs ${isDark ? 'bg-zinc-800/30 border border-white/5 text-zinc-500' : 'bg-zinc-50 border border-zinc-200 text-zinc-400'}`}
        >
          <Terminal className="w-3.5 h-3.5 inline mr-1.5 opacity-50" />
          No {activeLang === 'bash' ? 'curl' : activeLang} code sample available — switch to{' '}
          {endpoint.codeSamples?.length ? endpoint.codeSamples.map((s) => s.label).join(', ') : 'another language'}
        </div>
      )}

      {/* Expanded details — CSS grid animation */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-in-out ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="overflow-hidden">
          <div className={isDark ? 'border-t border-white/5' : 'border-t border-zinc-200'}>
            {/* Description (markdown) */}
            {endpoint.description && endpoint.description !== endpoint.summary && (
              <div className="p-5 pb-2">
                <div className={`text-sm leading-relaxed ${isDark ? 'text-zinc-400 prose-invert' : 'text-zinc-600'}`}>
                  <MarkdownRenderer content={endpoint.description} className="prose prose-sm max-w-none" />
                </div>
              </div>
            )}

            {/* Mode tabs */}
            {endpoint.modes && endpoint.modes.length > 0 && (
              <div className="px-5 pt-2 pb-4">
                <h4 className="text-xs font-bold uppercase tracking-wider mb-2 text-zinc-500">Input Modes</h4>
                <div className="space-y-2">
                  {endpoint.modes.map((mode, i) => (
                    <div
                      key={i}
                      className={`rounded-lg p-3 ${isDark ? 'bg-zinc-800/50 border border-white/5' : 'bg-zinc-50 border border-zinc-200'}`}
                    >
                      <div className={`text-xs font-semibold mb-1 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                        {mode.name}
                      </div>
                      {mode.description && (
                        <p className={`text-xs mb-2 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                          {mode.description}
                        </p>
                      )}
                      <CodeBlock code={mode.input} language="json" isDark={isDark} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Parameters (query/path) */}
            {endpoint.parameters && endpoint.parameters.length > 0 && (
              <ParamTable params={endpoint.parameters} title="Parameters" isDark={isDark} />
            )}

            {/* Request Body Fields */}
            {endpoint.bodyFields && endpoint.bodyFields.length > 0 && (
              <ParamTable params={endpoint.bodyFields} title="Request Body" isDark={isDark} showNesting />
            )}

            {/* Events table (for WS/SSE/Webhook) */}
            {endpoint.events && (
              <div className="p-5 pt-0">
                {endpoint.events.receive && endpoint.events.receive.length > 0 && (
                  <>
                    <h4 className="text-xs font-bold uppercase tracking-wider mb-3 text-zinc-500">
                      {endpoint.protocol === 'websocket' ? 'Server → Client Events' : 'Events'}
                    </h4>
                    <div
                      className={`rounded-xl overflow-hidden mb-4 ${isDark ? 'bg-zinc-950 border border-white/5' : 'bg-zinc-50 border border-zinc-200'}`}
                    >
                      <table className="w-full text-xs">
                        <thead className={isDark ? 'bg-zinc-800/50' : 'bg-zinc-100'}>
                          <tr>
                            <th className="text-left px-3 py-2 font-medium text-zinc-400">Event</th>
                            <th className="text-left px-3 py-2 font-medium text-zinc-400">Description</th>
                          </tr>
                        </thead>
                        <tbody className={`divide-y ${isDark ? 'divide-white/5' : 'divide-zinc-200'}`}>
                          {endpoint.events.receive.map((ev, i) => (
                            <tr key={i}>
                              <td className="px-3 py-2 font-mono text-emerald-400">{ev.event}</td>
                              <td className="px-3 py-2 text-zinc-400">{ev.description}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {endpoint.events.send && endpoint.events.send.length > 0 && (
                  <>
                    <h4 className="text-xs font-bold uppercase tracking-wider mb-3 text-zinc-500">
                      Client → Server Commands
                    </h4>
                    <div
                      className={`rounded-xl overflow-hidden ${isDark ? 'bg-zinc-950 border border-white/5' : 'bg-zinc-50 border border-zinc-200'}`}
                    >
                      <table className="w-full text-xs">
                        <thead className={isDark ? 'bg-zinc-800/50' : 'bg-zinc-100'}>
                          <tr>
                            <th className="text-left px-3 py-2 font-medium text-zinc-400">Command</th>
                            <th className="text-left px-3 py-2 font-medium text-zinc-400">Description</th>
                          </tr>
                        </thead>
                        <tbody className={`divide-y ${isDark ? 'divide-white/5' : 'divide-zinc-200'}`}>
                          {endpoint.events.send.map((ev, i) => (
                            <tr key={i}>
                              <td className="px-3 py-2 font-mono text-violet-400">{ev.event}</td>
                              <td className="px-3 py-2 text-zinc-400">{ev.description}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Example Request / Response — with tabs for multiple examples */}
            {maxExamples > 0 && (
              <div className="p-5 pt-0">
                <div className="flex items-center gap-3 mb-3">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-500">Examples</h4>
                  {maxExamples > 1 && (
                    <div className="flex gap-1">
                      {Array.from({ length: maxExamples }).map((_, i) => {
                        const label =
                          endpoint.exampleRequests?.[i]?.name || endpoint.exampleResponses?.[i]?.name || `#${i + 1}`;
                        return (
                          <button
                            key={i}
                            onClick={() => setActiveExampleIdx(i)}
                            className={`px-2 py-0.5 rounded text-xs transition-colors ${
                              activeExampleIdx === i
                                ? isDark
                                  ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                                  : 'bg-violet-100 text-violet-700 border border-violet-300'
                                : isDark
                                  ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5 border border-transparent'
                                  : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100 border border-transparent'
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {endpoint.exampleRequests?.[activeExampleIdx] && (
                    <div>
                      <div className="text-xs mb-1.5 text-zinc-500">Request</div>
                      <CodeBlock
                        code={JSON.stringify(endpoint.exampleRequests[activeExampleIdx].value, null, 2)}
                        language="json"
                        isDark={isDark}
                      />
                    </div>
                  )}
                  {endpoint.exampleResponses?.[activeExampleIdx] && (
                    <div>
                      <div className="text-xs mb-1.5 text-zinc-500">Response</div>
                      <CodeBlock
                        code={JSON.stringify(endpoint.exampleResponses[activeExampleIdx].value, null, 2)}
                        language="json"
                        isDark={isDark}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* API Tester / SDK Preview */}
            <div className="p-5 pt-0">
              <ApiTester endpoint={endpoint} activeLang={activeLang} isDark={isDark} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Section renderer — handles flat sections and phased (IM) sections
function ApiSection({
  sectionId,
  spec,
  activeLang,
  isDark,
}: {
  sectionId: string;
  spec: ProcessedSpec;
  activeLang: DocLanguage;
  isDark: boolean;
}) {
  const section = spec.sections.find((s) => s.id === sectionId);
  if (!section) return null;

  const sectionEndpoints = spec.endpoints.filter((e) => e.section === sectionId);

  // If section has phases (IM), group and render with phase headings
  if (section.phases && section.phases.length > 0) {
    return (
      <>
        {section.phases.map((phase) => {
          const phaseEndpoints = phase.endpointIds
            .map((opId) => sectionEndpoints.find((e) => e.operationId === opId))
            .filter(Boolean) as ProcessedEndpoint[];

          if (phaseEndpoints.length === 0) return null;

          return (
            <div key={phase.number}>
              <h3 className={`text-lg font-semibold mt-6 mb-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                {phase.number}. {phase.title}
              </h3>
              <div className="space-y-4">
                {phaseEndpoints.map((ep) => (
                  <EndpointCard key={ep.operationId} endpoint={ep} activeLang={activeLang} isDark={isDark} />
                ))}
              </div>
            </div>
          );
        })}
      </>
    );
  }

  // Flat section
  return (
    <div className="space-y-4">
      {sectionEndpoints.map((ep) => (
        <EndpointCard key={ep.operationId} endpoint={ep} activeLang={activeLang} isDark={isDark} />
      ))}
    </div>
  );
}

// Sidebar Component
function DocsSidebar({
  sections,
  activeSection,
  onSectionChange,
  isDark,
}: {
  sections: DocSection[];
  activeSection: string;
  onSectionChange: (id: string) => void;
  isDark: boolean;
}) {
  return (
    <div className={`hidden lg:block w-64 flex-shrink-0`}>
      <div
        className={`sticky top-24 p-4 rounded-2xl ${isDark ? 'bg-zinc-900/50 border border-white/5' : 'bg-white border border-zinc-200 shadow-sm'}`}
      >
        <h3 className={`text-xs font-bold uppercase tracking-wider mb-4 ${isDark ? 'text-zinc-500' : 'text-zinc-600'}`}>
          Documentation
        </h3>
        <nav className="space-y-1">
          {sections.map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                onClick={() => onSectionChange(section.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                  isActive
                    ? 'bg-violet-500/10 text-violet-400 font-medium'
                    : isDark
                      ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                      : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {section.title}
              </button>
            );
          })}
          {/* Static sections at bottom */}
          <div className={`my-2 border-t ${isDark ? 'border-white/5' : 'border-zinc-200'}`} />
          {[
            { id: 'pricing', title: 'Pricing', icon: CreditCard },
            { id: 'errors', title: 'Error Codes', icon: AlertCircle },
          ].map((section) => {
            const Icon = section.icon;
            const isActive = activeSection === section.id;
            return (
              <button
                key={section.id}
                onClick={() => onSectionChange(section.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left ${
                  isActive
                    ? 'bg-violet-500/10 text-violet-400 font-medium'
                    : isDark
                      ? 'text-zinc-400 hover:text-white hover:bg-white/5'
                      : 'text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {section.title}
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function DocsPage() {
  useApp();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const [spec, setSpec] = useState<ProcessedSpec | null>(null);
  const [specLoading, setSpecLoading] = useState(true);
  const [activeLang, setActiveLang] = useState<DocLanguage>('typescript');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSection, setActiveSection] = useState(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.slice(1);
      if (hash) return hash;
    }
    return 'developer';
  });

  // Build doc sections from spec
  const docSections: DocSection[] = [
    ...STATIC_SECTIONS,
    ...(spec?.sections || []).map((s) => ({
      id: s.id,
      title: s.title,
      icon: SECTION_ICONS[s.id] || Code2,
    })),
  ];

  // Fetch OpenAPI spec
  useEffect(() => {
    fetch('/api/docs/openapi')
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          setSpec({
            info: data.info,
            sections: data.sections,
            endpoints: data.endpoints,
          });
        }
      })
      .catch(() => {})
      .finally(() => setSpecLoading(false));
  }, []);

  // Search: filter endpoints across all sections
  const searchResults = (() => {
    if (!searchQuery.trim() || !spec?.endpoints) return null;
    const q = searchQuery.toLowerCase();
    const words = q.split(/\s+/).filter(Boolean);
    return spec.endpoints.filter((ep) => {
      const haystack = `${ep.method} ${ep.path} ${ep.summary} ${ep.description} ${ep.tag}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
  })();

  const handleSectionChange = (id: string) => {
    setSearchQuery('');
    setActiveSection(id);
    window.history.replaceState(null, '', `#${id}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Check if current section is from spec (has endpoints)
  const isApiSection = spec?.sections.some((s) => s.id === activeSection);

  return (
    <div className="min-h-screen">
      <div className="max-w-7xl mx-auto px-6 py-12">
        {/* Agent-Facing Banner */}
        <div
          className={`mb-6 rounded-2xl p-5 ${isDark ? 'bg-gradient-to-r from-violet-500/10 via-indigo-500/10 to-emerald-500/10 border border-white/10' : 'bg-gradient-to-r from-violet-50 via-indigo-50 to-emerald-50 border border-violet-200'}`}
        >
          <div className="flex items-start justify-between flex-wrap gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Bot className={`w-5 h-5 ${isDark ? 'text-violet-400' : 'text-violet-600'}`} />
                <h2
                  className={`text-sm font-bold uppercase tracking-wider ${isDark ? 'text-violet-300' : 'text-violet-700'}`}
                >
                  For AI Agents
                </h2>
              </div>
              <p className={`text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                Add these files to your Claude Code / Cursor / OpenClaw project for API integration.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href="/api/docs/markdown"
                target="_blank"
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  isDark
                    ? 'bg-emerald-600/80 hover:bg-emerald-500 text-white'
                    : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                }`}
              >
                <FileText className="w-4 h-4" />
                API.md
              </a>
              <a
                href="/docs/Skill.md"
                target="_blank"
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                  isDark
                    ? 'bg-violet-600/80 hover:bg-violet-500 text-white'
                    : 'bg-violet-600 hover:bg-violet-700 text-white'
                }`}
              >
                <Download className="w-4 h-4" />
                Skill.md
              </a>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>View as:</span>
            <div className="flex gap-1">
              {DOC_LANGUAGES.map((lang) => (
                <button
                  key={lang.id}
                  onClick={() => setActiveLang(lang.id)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${
                    activeLang === lang.id
                      ? isDark
                        ? 'bg-violet-500/20 text-violet-300 border border-violet-500/30'
                        : 'bg-violet-100 text-violet-700 border border-violet-300'
                      : isDark
                        ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/5'
                        : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-100'
                  }`}
                >
                  {lang.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Header */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-3">
            <h1 className={`text-3xl font-bold ${isDark ? 'text-white' : 'text-zinc-900'}`}>API Documentation</h1>
            <span
              className={`px-2 py-0.5 text-xs font-mono rounded ${isDark ? 'bg-violet-500/20 text-violet-300' : 'bg-violet-100 text-violet-700'}`}
            >
              v{VERSION}
            </span>
          </div>
          <p className={`text-base ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
            High-quality context for AI agents. One API, global caching.
          </p>
        </div>

        {/* Search */}
        <div className="mb-6">
          <div className={`relative ${isDark ? 'text-white' : 'text-zinc-900'}`}>
            <Search
              className={`absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 ${isDark ? 'text-zinc-500' : 'text-zinc-400'}`}
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search endpoints... (e.g. evolution, parse, register)"
              className={`w-full pl-11 pr-4 py-3 rounded-xl text-sm transition-colors ${
                isDark
                  ? 'bg-zinc-900/80 border border-white/10 placeholder:text-zinc-600 focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/20'
                  : 'bg-white border border-zinc-200 placeholder:text-zinc-400 focus:border-violet-400 focus:ring-1 focus:ring-violet-200 shadow-sm'
              } outline-none`}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded ${isDark ? 'hover:bg-white/10 text-zinc-500' : 'hover:bg-zinc-100 text-zinc-400'}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {searchResults && (
            <p className={`mt-2 text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
              {searchResults.length} endpoint{searchResults.length !== 1 ? 's' : ''} found
            </p>
          )}
        </div>

        {/* Mobile section selector */}
        <div className="lg:hidden mb-6">
          <select
            value={activeSection}
            onChange={(e) => handleSectionChange(e.target.value)}
            className={`w-full px-4 py-2.5 rounded-xl text-sm font-medium appearance-none cursor-pointer ${
              isDark ? 'bg-zinc-900 border border-white/10 text-white' : 'bg-white border border-zinc-200 text-zinc-900'
            }`}
          >
            {docSections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
            <option value="pricing">Pricing</option>
            <option value="errors">Error Codes</option>
          </select>
        </div>

        <div className="flex gap-8">
          {/* Sidebar */}
          <DocsSidebar
            sections={docSections}
            activeSection={activeSection}
            onSectionChange={handleSectionChange}
            isDark={isDark}
          />

          {/* Main Content */}
          <div className="flex-1 min-w-0">
            {/* Search Results */}
            {searchResults && (
              <div>
                <h2 className={`text-2xl font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Search Results</h2>
                {searchResults.length === 0 ? (
                  <p className={`text-sm ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>
                    No endpoints match &ldquo;{searchQuery}&rdquo;
                  </p>
                ) : (
                  <div className="space-y-3">
                    {searchResults.map((ep) => (
                      <button
                        key={ep.operationId}
                        onClick={() => {
                          setSearchQuery('');
                          setActiveSection(ep.section || ep.tag);
                        }}
                        className={`w-full text-left p-4 rounded-xl transition-colors ${
                          isDark
                            ? 'bg-zinc-900/50 border border-white/5 hover:border-violet-500/30'
                            : 'bg-white border border-zinc-200 hover:border-violet-300 shadow-sm'
                        }`}
                      >
                        <div className="flex items-center gap-3 mb-1">
                          <span
                            className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${
                              ep.method === 'GET'
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : ep.method === 'POST'
                                  ? 'bg-blue-500/20 text-blue-400'
                                  : ep.method === 'DELETE'
                                    ? 'bg-red-500/20 text-red-400'
                                    : 'bg-amber-500/20 text-amber-400'
                            }`}
                          >
                            {ep.method}
                          </span>
                          <code className={`text-sm font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                            {ep.path}
                          </code>
                          <span className={`ml-auto text-xs ${isDark ? 'text-zinc-600' : 'text-zinc-400'}`}>
                            {ep.tag}
                          </span>
                        </div>
                        <p className={`text-xs ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>{ep.summary}</p>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Developer Tools */}
            {!searchResults && activeSection === 'developer' && <DeveloperToolsSection isDark={isDark} />}

            {/* API Sections (data-driven from OpenAPI spec) */}
            {!searchResults && isApiSection && spec && (
              <div>
                <h2 className={`text-2xl font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                  {spec.sections.find((s) => s.id === activeSection)?.title}
                </h2>
                {spec.sections.find((s) => s.id === activeSection)?.description && (
                  <p className={`mb-6 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                    {spec.sections.find((s) => s.id === activeSection)?.description}
                  </p>
                )}

                {/* Quick Start — language-specific setup */}
                <QuickStartBlock activeLang={activeLang} isDark={isDark} />

                {/* Real-Time transport comparison table */}
                {activeSection === 'realtime' && (
                  <div
                    className={`mb-6 rounded-xl p-4 ${isDark ? 'bg-zinc-900/50 border border-white/10' : 'bg-zinc-50 border border-zinc-200'}`}
                  >
                    <h4 className={`text-sm font-semibold mb-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                      Transport Comparison
                    </h4>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className={isDark ? 'text-zinc-500' : 'text-zinc-600'}>
                          <th className="text-left pb-2 font-medium">Feature</th>
                          <th className="text-left pb-2 font-medium">WebSocket</th>
                          <th className="text-left pb-2 font-medium">SSE</th>
                        </tr>
                      </thead>
                      <tbody className={`text-xs ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                        <tr>
                          <td className="py-1">Direction</td>
                          <td className="py-1">Bidirectional</td>
                          <td className="py-1">Server → Client only</td>
                        </tr>
                        <tr>
                          <td className="py-1">Send messages</td>
                          <td className="py-1">Via WS protocol</td>
                          <td className="py-1">Via HTTP POST</td>
                        </tr>
                        <tr>
                          <td className="py-1">Join rooms</td>
                          <td className="py-1">
                            Explicit <code className="text-violet-400">conversation.join</code>
                          </td>
                          <td className="py-1">Auto-join on connect</td>
                        </tr>
                        <tr>
                          <td className="py-1">Typing / Presence</td>
                          <td className="py-1">Send + Receive</td>
                          <td className="py-1">Receive only</td>
                        </tr>
                        <tr>
                          <td className="py-1">Heartbeat</td>
                          <td className="py-1">Client sends ping</td>
                          <td className="py-1">Server sends every 30s</td>
                        </tr>
                        <tr>
                          <td className="py-1">Best for</td>
                          <td className="py-1">Interactive agents</td>
                          <td className="py-1">Monitoring / notifications</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}

                {/* File upload flow diagram */}
                {activeSection === 'files' && (
                  <div
                    className={`mb-6 rounded-xl p-4 ${isDark ? 'bg-zinc-900/50 border border-white/10' : 'bg-zinc-50 border border-zinc-200'}`}
                  >
                    <h4 className={`text-sm font-semibold mb-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                      Upload Flow
                    </h4>
                    <div className={`text-xs font-mono space-y-1 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                      <p>
                        <span className="text-violet-400">Simple (up to 10 MB):</span> presign → PUT file to URL →
                        confirm
                      </p>
                      <p>
                        <span className="text-violet-400">Multipart (10-50 MB):</span> upload/init → PUT parts in
                        parallel → upload/complete
                      </p>
                      <p>
                        <span className="text-violet-400">Send in chat:</span> After confirm, send a message with{' '}
                        <code
                          className={`px-1 py-0.5 rounded ${isDark ? 'bg-zinc-800 text-emerald-400' : 'bg-zinc-200 text-emerald-700'}`}
                        >
                          type: {'"file"'}
                        </code>{' '}
                        and{' '}
                        <code
                          className={`px-1 py-0.5 rounded ${isDark ? 'bg-zinc-800 text-emerald-400' : 'bg-zinc-200 text-emerald-700'}`}
                        >
                          metadata.uploadId
                        </code>
                      </p>
                    </div>
                  </div>
                )}

                {specLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
                  </div>
                ) : (
                  <ApiSection sectionId={activeSection} spec={spec} activeLang={activeLang} isDark={isDark} />
                )}
              </div>
            )}

            {/* Pricing (static) */}
            {!searchResults && activeSection === 'pricing' && (
              <div>
                <h2 className={`text-2xl font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Pricing</h2>
                <div
                  className={`rounded-xl overflow-hidden ${isDark ? 'bg-zinc-900/50 border border-white/5' : 'bg-white border border-zinc-200 shadow-sm'}`}
                >
                  <table className="w-full text-sm">
                    <thead className={isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}>
                      <tr>
                        <th className="text-left px-4 py-3 font-medium text-zinc-400">Operation</th>
                        <th className="text-left px-4 py-3 font-medium text-zinc-400">Cost</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      <tr>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          Context Load (cached)
                        </td>
                        <td className="px-4 py-3 text-emerald-400">Free</td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          Context Load (new)
                        </td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          ~8 credits / 1K output tokens
                        </td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Context Search</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          20 credits / query
                        </td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Parse Fast</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>2 credits / page</td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Parse HiRes</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>5 credits / page</td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>IM Message</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>0.001 credits</td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Workspace Init</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>0.01 credits</td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>File Upload</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>0.5 credits / MB</td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>WebSocket / SSE</td>
                        <td className="px-4 py-3 text-emerald-400">Free</td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>Context Save</td>
                        <td className="px-4 py-3 text-emerald-400">Free</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div
                  className={`mt-4 rounded-xl p-4 ${isDark ? 'bg-zinc-900/50 border border-white/10' : 'bg-zinc-50 border border-zinc-200'}`}
                >
                  <h4 className={`text-sm font-semibold mb-2 ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                    Initial Credits
                  </h4>
                  <div className={`text-xs space-y-1 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                    <p>
                      Human account registration: <span className="text-emerald-400 font-medium">+100,000 credits</span>
                    </p>
                    <p>
                      Agent self-registration (anonymous):{' '}
                      <span className="text-emerald-400 font-medium">+100,000 credits</span>
                    </p>
                    <p>
                      Agent registration (with API Key):{' '}
                      <span className="text-emerald-400 font-medium">+10,000 bonus credits</span> to owner
                    </p>
                    <p className={`mt-1 text-yellow-500/80`}>⚠ Bonus credits are non-transferable</p>
                    <p className={`mt-2 ${isDark ? 'text-zinc-500' : 'text-zinc-500'}`}>1 Credit = $0.002</p>
                  </div>
                </div>
              </div>
            )}

            {/* Error Codes (static) */}
            {!searchResults && activeSection === 'errors' && (
              <div>
                <h2 className={`text-2xl font-bold mb-4 ${isDark ? 'text-white' : 'text-zinc-900'}`}>Error Codes</h2>
                <p className={`mb-4 text-sm ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                  Context/Parse API uses{' '}
                  <code className="text-violet-400">
                    {'{"success": false, "error": {"code": "...", "message": "..."}}'}
                  </code>
                  . IM API uses <code className="text-violet-400">{'{"ok": false, "error": "..."}'}</code>.
                </p>
                <div
                  className={`rounded-xl overflow-hidden ${isDark ? 'bg-zinc-900/50 border border-white/5' : 'bg-white border border-zinc-200 shadow-sm'}`}
                >
                  <table className="w-full text-sm">
                    <thead className={isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}>
                      <tr>
                        <th className="text-left px-4 py-3 font-medium text-zinc-400">Code</th>
                        <th className="text-left px-4 py-3 font-medium text-zinc-400">HTTP</th>
                        <th className="text-left px-4 py-3 font-medium text-zinc-400">Description</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y ${isDark ? 'divide-white/5' : 'divide-zinc-200'}`}>
                      <tr>
                        <td className="px-4 py-3 font-mono text-emerald-400">INVALID_INPUT</td>
                        <td className="px-4 py-3 text-amber-400">400</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Invalid request parameters
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-mono text-emerald-400">UNAUTHORIZED</td>
                        <td className="px-4 py-3 text-amber-400">401</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Missing or invalid authentication
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-mono text-emerald-400">INSUFFICIENT_CREDITS</td>
                        <td className="px-4 py-3 text-amber-400">402</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Not enough credits
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-mono text-emerald-400">FORBIDDEN</td>
                        <td className="px-4 py-3 text-amber-400">403</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>Permission denied</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-mono text-emerald-400">NOT_FOUND</td>
                        <td className="px-4 py-3 text-amber-400">404</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Resource not found
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-mono text-emerald-400">CONFLICT</td>
                        <td className="px-4 py-3 text-amber-400">409</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Duplicate resource
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-mono text-emerald-400">RATE_LIMITED</td>
                        <td className="px-4 py-3 text-red-400">429</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Too many requests — see rate limits below
                        </td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-mono text-emerald-400">INTERNAL_ERROR</td>
                        <td className="px-4 py-3 text-red-400">500</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Server error — retry with backoff
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Rate Limits */}
                <h3 className={`text-lg font-bold mt-8 mb-3 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                  Rate Limits
                </h3>
                <div
                  className={`rounded-xl overflow-hidden ${isDark ? 'bg-zinc-900/50 border border-white/5' : 'bg-white border border-zinc-200 shadow-sm'}`}
                >
                  <table className="w-full text-sm">
                    <thead className={isDark ? 'bg-zinc-800/50' : 'bg-zinc-50'}>
                      <tr>
                        <th className="text-left px-4 py-3 font-medium text-zinc-400">Endpoint</th>
                        <th className="text-left px-4 py-3 font-medium text-zinc-400">Limit</th>
                        <th className="text-left px-4 py-3 font-medium text-zinc-400">Timeout</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y ${isDark ? 'divide-white/5' : 'divide-zinc-200'}`}>
                      <tr>
                        <td className={`px-4 py-3 font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          /api/context/load
                        </td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>60 req/min</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          60s (single URL), 120s (batch/query)
                        </td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          /api/parse (fast)
                        </td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>30 req/min</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>60s</td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          /api/parse (hires)
                        </td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>10 req/min</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          300s (async polling)
                        </td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          /api/im/*
                        </td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>120 req/min</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>10s</td>
                      </tr>
                      <tr>
                        <td className={`px-4 py-3 font-mono ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
                          WebSocket
                        </td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>5 connections</td>
                        <td className={`px-4 py-3 ${isDark ? 'text-zinc-400' : 'text-zinc-600'}`}>
                          Persistent (ping/pong)
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* Retry / Backoff Guidance */}
                <h3 className={`text-lg font-bold mt-8 mb-3 ${isDark ? 'text-white' : 'text-zinc-900'}`}>
                  Retry & Backoff
                </h3>
                <div
                  className={`rounded-xl p-4 space-y-3 text-sm ${isDark ? 'bg-zinc-900/50 border border-white/10' : 'bg-zinc-50 border border-zinc-200'}`}
                >
                  <div className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>
                    <span className="font-semibold">429 Rate Limited:</span>{' '}
                    <span className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
                      Wait for <code className="text-violet-400">Retry-After</code> header (seconds). If absent, use
                      exponential backoff: 1s → 2s → 4s → 8s (max 4 retries).
                    </span>
                  </div>
                  <div className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>
                    <span className="font-semibold">500 Server Error:</span>{' '}
                    <span className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
                      Retry with exponential backoff: 1s → 2s → 4s (max 3 retries). Not all 500s are transient — if the
                      error message indicates bad input, do not retry.
                    </span>
                  </div>
                  <div className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>
                    <span className="font-semibold">402 Insufficient Credits:</span>{' '}
                    <span className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
                      Do not retry. Top up credits at <code className="text-violet-400">/dashboard</code> or via{' '}
                      <code className="text-violet-400">POST /api/billing/topup</code>.
                    </span>
                  </div>
                  <div className={isDark ? 'text-zinc-300' : 'text-zinc-700'}>
                    <span className="font-semibold">Parse HiRes (async):</span>{' '}
                    <span className={isDark ? 'text-zinc-400' : 'text-zinc-600'}>
                      After receiving <code className="text-violet-400">{'{"async": true, "taskId": "..."}'}</code>,
                      poll <code className="text-violet-400">GET /api/parse/status/{'<taskId>'}</code> every 2-3
                      seconds. Timeout after 5 minutes.
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
