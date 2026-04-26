import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Playground | Prismer Cloud',
  description:
    'Try Prismer Cloud APIs interactively. Load web content, parse documents, and test the evolution engine.',
  openGraph: {
    title: 'Playground | Prismer Cloud',
    description:
      'Try Prismer Cloud APIs interactively. Load web content, parse documents, and test the evolution engine.',
    url: 'https://prismer.cloud/playground',
    siteName: 'Prismer Cloud',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Playground | Prismer Cloud',
    description:
      'Try Prismer Cloud APIs interactively. Load web content, parse documents, and test the evolution engine.',
  },
};

export default function PlaygroundLayout({ children }: { children: React.ReactNode }) {
  return children;
}
