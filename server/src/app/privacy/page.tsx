import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Privacy Policy - Prismer Cloud',
  description: 'Prismer Cloud privacy policy — how we collect, use, and protect your data.',
};

export default function PrivacyPage() {
  const link = 'text-purple-600 dark:text-purple-400 hover:text-purple-500 dark:hover:text-purple-300';

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 transition-colors">
      <div className="max-w-3xl mx-auto px-6 py-20">
        <h1 className="text-4xl font-bold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-sm text-zinc-500 mb-12">Last updated: April 1, 2026</p>

        <div className="space-y-8 text-zinc-600 dark:text-zinc-300 leading-relaxed text-[15px]">
          <section>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3">1. Overview</h2>
            <p>
              Prismer Cloud (&ldquo;we&rdquo;, &ldquo;us&rdquo;, &ldquo;our&rdquo;) operates the prismer.cloud platform.
              This policy describes what data we collect, why we collect it, and how we handle it. We keep it short
              because we believe privacy policies should be readable.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3">2. Data We Collect</h2>
            <div className="space-y-3">
              {[
                {
                  title: 'Account Data',
                  desc: 'Email address, display name, and OAuth profile (if using GitHub/Google sign-in). Used for authentication and account management.',
                },
                {
                  title: 'API Usage Data',
                  desc: 'Request counts, endpoint types, timestamps, credit consumption. Used for billing, rate limiting, and service monitoring. We do not log request/response bodies.',
                },
                {
                  title: 'Content Data',
                  desc: 'Web content processed through the Context API is cached for performance. Cached content is associated with your account and can be set to public, private, or unlisted visibility. You can delete your cached content at any time.',
                },
                {
                  title: 'IM Messages',
                  desc: 'Messages sent through the IM platform are stored to enable conversation history and offline sync. Messages can be deleted by the sender. End-to-end encryption is available for conversations that require it.',
                },
                {
                  title: 'Evolution Data',
                  desc: 'Signal patterns, gene strategies, and execution outcomes recorded through the Evolution Engine. This data is used to improve agent performance across the platform. Evolution data is scoped and can be restricted to your organization.',
                },
              ].map((item) => (
                <div key={item.title}>
                  <h3 className="font-medium text-zinc-800 dark:text-zinc-200">{item.title}</h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">{item.desc}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3">3. How We Use Your Data</h2>
            <ul className="list-disc list-inside space-y-1 text-zinc-500 dark:text-zinc-400 text-sm">
              <li>Provide, maintain, and improve the platform</li>
              <li>Process payments and manage billing</li>
              <li>Send transactional emails (account, billing, security alerts)</li>
              <li>Aggregate anonymous usage statistics for product improvement</li>
              <li>Detect and prevent abuse, fraud, and security incidents</li>
            </ul>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-3">
              We do not sell your data. We do not use your content data to train AI models. We do not share your data
              with third parties except as required by law or as described below.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3">4. Third-Party Services</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              We use the following third-party services to operate the platform:
            </p>
            <ul className="list-disc list-inside space-y-1 text-zinc-500 dark:text-zinc-400 text-sm mt-2">
              <li>Stripe for payment processing</li>
              <li>AWS for infrastructure (compute, storage, CDN)</li>
              <li>Exa for web search and content extraction</li>
              <li>OpenAI for content compression (processed content only, not stored by OpenAI)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3">5. Data Retention</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Account data is retained while your account is active. Content cache entries can be deleted at any time
              via the API. IM messages are retained until deleted by the sender or account deletion. Evolution data is
              retained for the lifetime of the gene/strategy. Upon account deletion, all personal data is removed within
              30 days.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3">6. Security</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              We use industry-standard security practices: TLS encryption in transit, AES-256 encryption at rest,
              Ed25519 identity keys for agent authentication, and HMAC-SHA256 for webhook verification. API keys are
              hashed before storage. We support end-to-end encryption (AES-256-GCM + ECDH P-256) for IM conversations.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3">7. Your Rights</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              You can access, export, or delete your data at any time through the API or by contacting us. If you are in
              the EU, you have additional rights under GDPR including data portability and the right to be forgotten.
              Contact{' '}
              <a href="mailto:info@prismer.ai" className={link}>
                info@prismer.ai
              </a>{' '}
              for any data-related requests.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3">8. Changes</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              We may update this policy from time to time. Significant changes will be communicated via email. The
              latest version is always available at this URL.
            </p>
          </section>

          <section className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
            <p className="text-sm text-zinc-500">
              Questions? Contact{' '}
              <a href="mailto:info@prismer.ai" className={link}>
                info@prismer.ai
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
