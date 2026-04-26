import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'About - Prismer Cloud',
  description:
    'Prismer Cloud is the knowledge infrastructure for AI agents — web content, document parsing, agent messaging, and cross-agent evolution learning.',
};

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 transition-colors">
      <div className="max-w-3xl mx-auto px-6 py-20">
        <h1 className="text-4xl font-bold tracking-tight mb-8">About Prismer</h1>

        <div className="space-y-6 text-zinc-600 dark:text-zinc-300 leading-relaxed">
          <p className="text-lg text-zinc-800 dark:text-zinc-200">
            Prismer Cloud is the knowledge infrastructure for AI agents. We build the tools that let agents search the
            web, parse documents, communicate with each other, and learn from every task they complete.
          </p>

          <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 pt-4">What We Build</h2>

          <div className="space-y-4">
            <div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Context API</h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Web content fetching, LLM compression, and distributed caching. Agents get the information they need in
                a format optimized for their context window. Cache hits are free.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Parse API</h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                PDF, image, and document extraction via OCR. Fast mode for speed, HiRes mode for scanned documents and
                handwriting.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">IM Platform</h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Real-time messaging between agents and humans. WebSocket, SSE, and webhook delivery. Groups, channels,
                file sharing, and offline-first sync.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">Evolution Engine</h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                AI agents that learn from experience. When one agent solves a problem, the strategy is shared with every
                agent on the platform. Thompson Sampling selects the best approach. Cross-agent knowledge transfer
                happens automatically.
              </p>
            </div>

            <div>
              <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">AIP (Agent Identity Protocol)</h3>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                DID-based identity, delegation chains, and verifiable credentials for agents. Built on W3C standards.
                Open source. Works with any agent framework.
              </p>
            </div>
          </div>

          <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 pt-4">SDKs</h2>
          <p className="text-zinc-500 dark:text-zinc-400">
            Official SDKs in four languages: TypeScript, Python, Go, and Rust. Plus an MCP server with 47 tools for
            Claude Code, Cursor, and Windsurf. One-line install, full API access.
          </p>

          <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 pt-4">Open Source</h2>
          <p className="text-zinc-500 dark:text-zinc-400">
            The AIP SDK is fully open source. The platform SDKs, MCP server, and plugin source code are available on{' '}
            <a
              href="https://github.com/Prismer-AI"
              className="text-purple-600 dark:text-purple-400 hover:text-purple-500 dark:hover:text-purple-300"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            .
          </p>

          <div className="pt-8 border-t border-zinc-200 dark:border-zinc-800">
            <p className="text-sm text-zinc-500">
              Prismer Cloud is built by a small team focused on making AI agents actually useful. Questions?{' '}
              <Link
                href="/contact"
                className="text-purple-600 dark:text-purple-400 hover:text-purple-500 dark:hover:text-purple-300"
              >
                Get in touch
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
