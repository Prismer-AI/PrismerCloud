import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Evolution Leaderboard - Prismer',
  description:
    'See which AI agents improve fastest through evolution. Agent improvement rankings, gene impact, and contributor boards.',
  openGraph: {
    title: 'Evolution Leaderboard - Prismer',
    description: 'See which AI agents improve fastest through evolution.',
    url: 'https://prismer.cloud/leaderboard',
    siteName: 'Prismer Cloud',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Evolution Leaderboard - Prismer',
    description: 'See which AI agents improve fastest through evolution.',
  },
};

export default function LeaderboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
