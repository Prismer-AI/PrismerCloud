'use client';

/**
 * /setup — Simplified API key setup page for CLI/Plugin onboarding
 *
 * This page is the target of `/prismer-setup` and `prismer setup`.
 * It detects if the user is logged in:
 *   - Yes → auto-create an API key and show it prominently
 *   - No → redirect to /auth with redirect back to /setup
 */

import { useState, useEffect, useCallback, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

export default function SetupPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#0a0a0a' }} />}>
      <SetupContent />
    </Suspense>
  );
}

function SetupContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const source = searchParams.get('utm_source') || 'direct';
  const callbackUrl = searchParams.get('callback'); // localhost callback from CLI
  const callbackState = searchParams.get('state'); // CSRF protection

  const [state, setState] = useState<'checking' | 'not-logged-in' | 'creating' | 'ready' | 'redirecting' | 'error'>(
    'checking',
  );
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Security: only allow localhost callbacks
  const isValidCallback =
    callbackUrl && callbackState && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(callbackUrl);

  // Extract Bearer token from localStorage auth data
  const extractToken = (): string | null => {
    const raw = localStorage.getItem('prismer_auth');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.token && (!parsed.expiresAt || parsed.expiresAt > Date.now())) {
          return parsed.token;
        }
      } catch {
        // If it's a plain string token (legacy), use directly
        if (raw.startsWith('ey')) return raw;
      }
    }
    const apiKey = localStorage.getItem('prismer_active_api_key');
    if (apiKey) {
      try {
        const parsed = JSON.parse(apiKey);
        if (parsed.key) return parsed.key;
      } catch {
        if (apiKey.startsWith('sk-prismer-')) return apiKey;
      }
    }
    return null;
  };

  // Check auth state on mount — also poll briefly after redirect from /auth
  useEffect(() => {
    const tryAuth = () => {
      const token = extractToken();
      if (!token) {
        setState('not-logged-in');
        return false;
      }
      createKey(token);
      return true;
    };

    if (tryAuth()) return;

    // After redirect from /auth, token may be written with a slight delay (React state + localStorage).
    // Poll a few times to catch it.
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (tryAuth() || attempts >= 10) {
        clearInterval(interval);
      }
    }, 500);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally run once on mount; createKey is stable via useCallback
  }, []);

  const createKey = useCallback(
    async (token: string) => {
      setState('creating');
      try {
        const res = await fetch('/api/keys', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            label: `setup-${source}-${new Date().toISOString().split('T')[0]}`,
          }),
        });

        if (!res.ok) {
          if (res.status === 401) {
            setState('not-logged-in');
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success && data.data?.key) {
          const newKey = data.data.key;

          // If CLI callback is waiting, redirect the key there
          if (isValidCallback && callbackUrl && callbackState) {
            setState('redirecting');
            const redirectUrl = `${callbackUrl}?key=${encodeURIComponent(newKey)}&state=${encodeURIComponent(callbackState)}`;
            window.location.href = redirectUrl;
            return;
          }

          // Otherwise show the key for manual copy
          setApiKey(newKey);
          setState('ready');
        } else {
          throw new Error(data.error?.message || 'Failed to create key');
        }
      } catch (e: any) {
        setError(e.message);
        setState('error');
      }
    },
    [source, isValidCallback, callbackUrl, callbackState],
  );

  const handleCopy = useCallback(() => {
    if (apiKey) {
      navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    }
  }, [apiKey]);

  const handleLogin = useCallback(() => {
    const returnUrl = '/setup' + window.location.search;
    router.push('/auth?redirect=' + encodeURIComponent(returnUrl));
  }, [router]);

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0a0a',
        color: '#e5e5e5',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: 520,
          width: '100%',
          padding: 40,
          textAlign: 'center',
        }}
      >
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8, color: '#fff' }}>Prismer Setup</h1>
        <p style={{ fontSize: 14, color: '#888', marginBottom: 32 }}>
          Get your API key for Claude Code, MCP tools, and cross-agent learning
        </p>

        {state === 'checking' && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  border: '3px solid #333',
                  borderTopColor: '#4ade80',
                  borderRadius: '50%',
                  margin: '0 auto',
                  animation: 'spin 0.8s linear infinite',
                }}
              />
            </div>
            <p style={{ color: '#888' }}>Detecting login status...</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}

        {state === 'redirecting' && (
          <div>
            <div style={{ fontSize: 40, marginBottom: 16, color: '#4ade80' }}>&#10003;</div>
            <p style={{ color: '#4ade80', fontWeight: 600, fontSize: 18, marginBottom: 8 }}>
              API key sent to your terminal!
            </p>
            <p style={{ color: '#aaa', marginBottom: 24 }}>
              Your agent is now connected to a network of evolving agents.
            </p>

            <div
              style={{
                background: '#111',
                border: '1px solid #222',
                borderRadius: 8,
                padding: 16,
                textAlign: 'left',
                fontSize: 13,
                lineHeight: 1.8,
                marginBottom: 24,
              }}
            >
              <p style={{ fontWeight: 600, color: '#ccc', marginBottom: 8 }}>What happens next:</p>
              <p>&#9679; Next session: top strategies auto-load</p>
              <p>&#9679; Each session: outcomes feed the network</p>
              <p>&#9679; Over time: your success rate improves</p>
            </div>

            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link
                href="/evolution"
                style={{
                  padding: '8px 16px',
                  borderRadius: 6,
                  background: '#1a1a2e',
                  border: '1px solid #333',
                  color: '#a78bfa',
                  textDecoration: 'none',
                  fontSize: 13,
                }}
              >
                Leaderboard
              </Link>
              <Link
                href="/community"
                style={{
                  padding: '8px 16px',
                  borderRadius: 6,
                  background: '#1a1a2e',
                  border: '1px solid #333',
                  color: '#a78bfa',
                  textDecoration: 'none',
                  fontSize: 13,
                }}
              >
                Community
              </Link>
              <Link
                href="/playground"
                style={{
                  padding: '8px 16px',
                  borderRadius: 6,
                  background: '#1a1a2e',
                  border: '1px solid #333',
                  color: '#a78bfa',
                  textDecoration: 'none',
                  fontSize: 13,
                }}
              >
                Playground
              </Link>
            </div>
          </div>
        )}

        {state === 'not-logged-in' && (
          <div>
            <p style={{ marginBottom: 20, color: '#ccc' }}>Sign in or create an account to get your API key.</p>
            <button
              onClick={handleLogin}
              style={{
                padding: '12px 32px',
                fontSize: 16,
                fontWeight: 600,
                background: '#fff',
                color: '#000',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              Sign in / Register
            </button>
            <p style={{ marginTop: 16, fontSize: 12, color: '#666' }}>
              Free account includes 100 credits to get started.
            </p>
          </div>
        )}

        {state === 'creating' && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  border: '3px solid #333',
                  borderTopColor: '#60a5fa',
                  borderRadius: '50%',
                  margin: '0 auto',
                  animation: 'spin 0.8s linear infinite',
                }}
              />
            </div>
            <p style={{ color: '#60a5fa', fontWeight: 600 }}>Logged in! Creating your API key...</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}

        {state === 'ready' && apiKey && (
          <div>
            <p style={{ marginBottom: 12, color: '#4ade80', fontWeight: 600 }}>Your API key is ready</p>
            <div
              onClick={handleCopy}
              style={{
                background: '#1a1a2e',
                border: '1px solid #333',
                borderRadius: 8,
                padding: '16px 20px',
                fontFamily: 'monospace',
                fontSize: 14,
                wordBreak: 'break-all',
                cursor: 'pointer',
                position: 'relative',
                marginBottom: 12,
              }}
            >
              {apiKey}
              <span
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 12,
                  fontSize: 12,
                  color: copied ? '#4ade80' : '#666',
                }}
              >
                {copied ? 'Copied!' : 'Click to copy'}
              </span>
            </div>

            <p style={{ fontSize: 13, color: '#888', marginBottom: 24 }}>
              Copy this key and paste it into your terminal when prompted.
              <br />
              <strong style={{ color: '#f59e0b' }}>This is the only time it will be shown.</strong>
            </p>

            <div
              style={{
                background: '#111',
                border: '1px solid #222',
                borderRadius: 8,
                padding: 16,
                textAlign: 'left',
                fontSize: 13,
                lineHeight: 1.8,
              }}
            >
              <p style={{ fontWeight: 600, color: '#ccc', marginBottom: 8 }}>Next steps:</p>
              <p>
                <code style={{ color: '#60a5fa' }}>/prismer-setup</code> — if using Claude Code plugin
              </p>
              <p>
                <code style={{ color: '#60a5fa' }}>prismer setup</code> — if using CLI
              </p>
            </div>

            <div
              style={{
                background: '#111',
                border: '1px solid #222',
                borderRadius: 8,
                padding: 16,
                textAlign: 'left',
                fontSize: 13,
                lineHeight: 1.8,
                marginTop: 12,
              }}
            >
              <p style={{ fontWeight: 600, color: '#ccc', marginBottom: 8 }}>Choose your path:</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div style={{ background: '#0a0a1a', border: '1px solid #1a1a3e', borderRadius: 6, padding: 12 }}>
                  <p style={{ fontWeight: 600, color: '#a78bfa', marginBottom: 4 }}>Plugin (Claude Code / MCP)</p>
                  <p style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>Auto-learning, zero integration</p>
                  <code style={{ color: '#60a5fa', fontSize: 11, wordBreak: 'break-all' }}>
                    npx @prismer/claude-code-plugin setup
                  </code>
                </div>
                <div style={{ background: '#0a0a1a', border: '1px solid #1a1a3e', borderRadius: 6, padding: 12 }}>
                  <p style={{ fontWeight: 600, color: '#22d3ee', marginBottom: 4 }}>API (Your Application)</p>
                  <p style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>Direct integration via SDK</p>
                  <Link href="/playground" style={{ color: '#60a5fa', fontSize: 12, textDecoration: 'underline' }}>
                    Try in Playground
                  </Link>
                  {' | '}
                  <Link href="/docs" style={{ color: '#60a5fa', fontSize: 12, textDecoration: 'underline' }}>
                    API Docs
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}

        {state === 'error' && (
          <div>
            <p style={{ color: '#ef4444', marginBottom: 12 }}>Failed to create API key: {error}</p>
            <button
              onClick={handleLogin}
              style={{
                padding: '10px 24px',
                fontSize: 14,
                background: '#333',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Try signing in again
            </button>
          </div>
        )}

        <p style={{ marginTop: 40, fontSize: 11, color: '#444' }}>Source: {source} | prismer.cloud</p>
      </div>
    </div>
  );
}
