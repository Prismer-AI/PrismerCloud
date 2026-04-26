import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Contact - Prismer Cloud',
  description: 'Get in touch with the Prismer Cloud team for support, partnerships, or questions.',
};

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 transition-colors">
      <div className="max-w-3xl mx-auto px-6 py-20">
        <h1 className="text-4xl font-bold tracking-tight mb-8">Contact</h1>

        <div className="space-y-8 text-zinc-600 dark:text-zinc-300">
          <p className="text-lg text-zinc-800 dark:text-zinc-200">
            We read every message. Here is how to reach us depending on what you need.
          </p>

          <div className="grid gap-6">
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-6">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Technical Support</h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
                API issues, SDK bugs, integration questions, or anything that is not working as expected.
              </p>
              <a
                href="mailto:info@prismer.ai"
                className="text-purple-600 dark:text-purple-400 hover:text-purple-500 dark:hover:text-purple-300 text-sm font-mono"
              >
                info@prismer.ai
              </a>
            </div>

            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-6">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Business & Partnerships</h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
                Enterprise plans, custom integrations, partnership inquiries, or investor relations.
              </p>
              <a
                href="mailto:info@prismer.ai"
                className="text-purple-600 dark:text-purple-400 hover:text-purple-500 dark:hover:text-purple-300 text-sm font-mono"
              >
                info@prismer.ai
              </a>
            </div>

            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-6">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Security</h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
                Report a vulnerability or security concern. We take security seriously and respond within 24 hours.
              </p>
              <a
                href="mailto:info@prismer.ai"
                className="text-purple-600 dark:text-purple-400 hover:text-purple-500 dark:hover:text-purple-300 text-sm font-mono"
              >
                info@prismer.ai
              </a>
            </div>

            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-6">
              <h2 className="font-semibold text-zinc-900 dark:text-zinc-100 mb-2">Community</h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
                Join the conversation, share what you are building, or find other developers using Prismer.
              </p>
              <div className="flex gap-4 text-sm">
                <a
                  href="https://github.com/Prismer-AI"
                  className="text-purple-600 dark:text-purple-400 hover:text-purple-500 dark:hover:text-purple-300"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
                <a
                  href="https://discord.gg/prismer"
                  className="text-purple-600 dark:text-purple-400 hover:text-purple-500 dark:hover:text-purple-300"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Discord
                </a>
              </div>
            </div>
          </div>

          <div className="pt-4 text-sm text-zinc-500">
            <p>Response time: Technical support within 24h. Business inquiries within 48h.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
