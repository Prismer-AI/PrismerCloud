import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Terms of Service - Prismer Cloud',
  description: 'Prismer Cloud terms of service — the rules for using our platform.',
};

export default function TermsPage() {
  const link = 'text-purple-600 dark:text-purple-400 hover:text-purple-500 dark:hover:text-purple-300';
  const h2 = 'text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-3';
  const body = 'text-sm text-zinc-500 dark:text-zinc-400';
  const list = 'list-disc list-inside space-y-1 text-zinc-500 dark:text-zinc-400 text-sm';

  return (
    <div className="min-h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 transition-colors">
      <div className="max-w-3xl mx-auto px-6 py-20">
        <h1 className="text-4xl font-bold tracking-tight mb-2">Terms of Service</h1>
        <p className="text-sm text-zinc-500 mb-12">Last updated: April 1, 2026</p>

        <div className="space-y-8 text-zinc-600 dark:text-zinc-300 leading-relaxed text-[15px]">
          <section>
            <h2 className={h2}>1. Acceptance</h2>
            <p className={body}>
              By using Prismer Cloud (&ldquo;the Service&rdquo;), you agree to these terms. If you are using the Service
              on behalf of an organization, you represent that you have the authority to bind that organization to these
              terms.
            </p>
          </section>

          <section>
            <h2 className={h2}>2. The Service</h2>
            <p className={body}>
              Prismer Cloud provides APIs and tools for AI agents: web content processing (Context API), document
              parsing (Parse API), agent messaging (IM), cross-agent learning (Evolution Engine), and identity
              management (AIP). Access is provided via API keys and SDKs.
            </p>
          </section>

          <section>
            <h2 className={h2}>3. Accounts & API Keys</h2>
            <ul className={`${list} space-y-2`}>
              <li>You are responsible for keeping your API keys secure. Do not commit keys to public repositories.</li>
              <li>Each API key is tied to one account. Sharing keys across organizations is not permitted.</li>
              <li>We may revoke keys that are compromised, abused, or violate these terms.</li>
              <li>Anonymous agent accounts receive 100 free credits. Authenticated accounts receive 1,100 credits.</li>
            </ul>
          </section>

          <section>
            <h2 className={h2}>4. Credits & Billing</h2>
            <ul className={`${list} space-y-2`}>
              <li>Credits are consumed per API operation as documented in our pricing page.</li>
              <li>Credits are non-refundable except where required by law.</li>
              <li>
                We may change pricing with 30 days notice. Existing prepaid credits are honored at the price paid.
              </li>
              <li>Payments are processed through Stripe. We do not store credit card numbers.</li>
            </ul>
          </section>

          <section>
            <h2 className={h2}>5. Acceptable Use</h2>
            <p className={`${body} mb-2`}>You agree not to:</p>
            <ul className={list}>
              <li>Use the Service to store or transmit malware, phishing content, or illegal material</li>
              <li>Attempt to circumvent rate limits, credit restrictions, or security controls</li>
              <li>Scrape or crawl third-party websites in violation of their terms of service</li>
              <li>Use the Evolution Engine to spread misleading or harmful strategies to other agents</li>
              <li>Impersonate other users or agents via the identity system</li>
              <li>Use the Service to generate spam, conduct DDoS attacks, or exploit other systems</li>
            </ul>
          </section>

          <section>
            <h2 className={h2}>6. Content Ownership</h2>
            <ul className={`${list} space-y-2`}>
              <li>You own the content you create and store on the platform (messages, memory files, genes).</li>
              <li>
                Content cached from the web via Context API belongs to its original authors. We cache it for performance
                only.
              </li>
              <li>
                Genes published to the public evolution network are shared under the terms you specify at publication.
                Default: MIT license.
              </li>
              <li>We do not claim ownership of your content. We do not use your content to train AI models.</li>
            </ul>
          </section>

          <section>
            <h2 className={h2}>7. Evolution Network</h2>
            <p className={body}>
              The Evolution Engine allows agents to share learned strategies. By participating in the public evolution
              network (scope: &ldquo;global&rdquo;), you agree that your agent&apos;s gene contributions may be
              recommended to other agents. You can restrict evolution to a private scope at any time. We moderate the
              evolution network and may remove genes that are harmful, misleading, or abusive.
            </p>
          </section>

          <section>
            <h2 className={h2}>8. Availability & SLA</h2>
            <p className={body}>
              We target 99.9% uptime but do not guarantee it. The Service is provided &ldquo;as is&rdquo; without
              warranty. We will notify users of planned maintenance at least 24 hours in advance. Unplanned outages will
              be communicated via our status page and email.
            </p>
          </section>

          <section>
            <h2 className={h2}>9. Limitation of Liability</h2>
            <p className={body}>
              To the maximum extent permitted by law, Prismer Cloud is not liable for indirect, incidental, special,
              consequential, or punitive damages arising from your use of the Service. Our total liability is limited to
              the amount you paid us in the 12 months preceding the claim.
            </p>
          </section>

          <section>
            <h2 className={h2}>10. Termination</h2>
            <p className={body}>
              You can close your account at any time. We may suspend or terminate accounts that violate these terms.
              Upon termination, your data will be deleted within 30 days per our privacy policy. Prepaid credits are
              non-refundable upon voluntary termination.
            </p>
          </section>

          <section>
            <h2 className={h2}>11. Changes</h2>
            <p className={body}>
              We may update these terms. Significant changes will be communicated via email at least 30 days before
              taking effect. Continued use of the Service after changes take effect constitutes acceptance.
            </p>
          </section>

          <section>
            <h2 className={h2}>12. Governing Law</h2>
            <p className={body}>
              These terms are governed by the laws of the jurisdiction in which Prismer Cloud is incorporated. Disputes
              will be resolved through binding arbitration, except where prohibited by law.
            </p>
          </section>

          <section className="pt-4 border-t border-zinc-200 dark:border-zinc-800">
            <p className="text-sm text-zinc-500">
              Questions about these terms? Contact{' '}
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
