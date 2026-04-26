'use client';

import { useState } from 'react';
import { Copy, Play, Loader2, Check, X, Key } from 'lucide-react';
import { useApp } from '@/contexts/app-context';
import Link from 'next/link';
import { CodeBlock } from '@/components/ui/code-block';

interface CodeSample {
  lang: string;
  label: string;
  source: string;
}

interface NamedExample {
  name: string;
  value: unknown;
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

interface Endpoint {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  description: string;
  protocol?: 'websocket' | 'sse' | 'webhook';
  parameters?: Parameter[];
  bodyFields?: Parameter[];
  exampleRequests?: NamedExample[];
  codeSamples?: CodeSample[];
}

interface ApiTesterProps {
  endpoint: Endpoint;
  activeLang: string;
  isDark?: boolean;
}

function codeBlockLang(lang: string): string {
  if (lang === 'bash') return 'bash';
  if (lang === 'go') return 'go';
  if (lang === 'python') return 'python';
  return 'typescript';
}

function completeCodeSample(source: string, lang: string): string {
  if (lang === 'bash') return source;
  const trimmed = source.trim();
  if (lang === 'typescript' && (trimmed.startsWith('import ') || trimmed.startsWith('const {'))) return source;
  if (lang === 'python' && (trimmed.startsWith('import ') || trimmed.startsWith('from '))) return source;
  if (lang === 'go' && (trimmed.startsWith('import ') || trimmed.startsWith('package '))) return source;
  return source;
}

export function ApiTester({ endpoint, activeLang, isDark = true }: ApiTesterProps) {
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
      const escapedBody = requestBody.replace(/\n/g, '').replace(/'/g, "'\\''");
      cmd += ` \\\n  -d '${escapedBody}'`;
    }
    return cmd;
  };

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(buildCurlCommand());
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 1500);
    } catch {
      setCopiedCurl(false);
    }
  };

  const executeRequest = async () => {
    setLoading(true);
    setResponse(null);
    const startTime = Date.now();

    const method = endpoint.method === 'WS' ? 'GET' : endpoint.method;
    const needsBody = method !== 'GET' && method !== 'DELETE';
    let body: unknown;
    if (needsBody) {
      try {
        body = JSON.parse(requestBody);
      } catch {
        setResponse({ error: 'Invalid JSON in request body' });
        setLoading(false);
        return;
      }
    }

    try {
      const res = await fetch(resolvedPath, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(effectiveApiKey ? { Authorization: `Bearer ${effectiveApiKey}` } : {}),
        },
        ...(needsBody ? { body: JSON.stringify(body) } : {}),
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

      <div
        className={`grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x ${isDark ? 'divide-white/5' : 'divide-zinc-200'}`}
      >
        <div className="p-4">
          <span className="text-xs font-medium text-zinc-500 uppercase">Request Body</span>
          <textarea
            value={requestBody}
            onChange={(e) => setRequestBody(e.target.value)}
            className={`mt-2 w-full h-40 p-3 rounded-lg font-mono text-xs resize-none focus:outline-none ${isDark ? 'bg-zinc-950 border border-white/5 text-zinc-300' : 'bg-white border border-zinc-200 text-zinc-700'}`}
            spellCheck={false}
          />
        </div>

        <div className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-500 uppercase">Response</span>
            {elapsed !== null && <span className="text-xs text-zinc-500">{elapsed}ms</span>}
          </div>
          <div
            className={`mt-2 w-full h-40 p-3 rounded-lg font-mono text-xs overflow-auto ${isDark ? 'bg-zinc-950 border border-white/5' : 'bg-white border border-zinc-200'}`}
          >
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
                <pre className={`whitespace-pre-wrap ${isDark ? 'text-zinc-300' : 'text-zinc-700'}`}>
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
