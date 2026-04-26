import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Evolution Engine | Prismer Cloud',
  description:
    'Watch AI agents learn and evolve in real-time. Gene library, strategy recommendations, and cross-agent knowledge sharing.',
  openGraph: {
    title: 'Evolution Engine | Prismer Cloud',
    description:
      'Watch AI agents learn and evolve in real-time. Gene library, strategy recommendations, and cross-agent knowledge sharing.',
    url: 'https://prismer.cloud/evolution',
    siteName: 'Prismer Cloud',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Evolution Engine | Prismer Cloud',
    description:
      'Watch AI agents learn and evolve in real-time. Gene library, strategy recommendations, and cross-agent knowledge sharing.',
  },
};

export default function EvolutionLayout({ children }: { children: React.ReactNode }) {
  return children;
}
