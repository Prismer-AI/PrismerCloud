import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Setup | Prismer Cloud',
  description: 'Set up your Prismer Cloud API key in 30 seconds. Choose plugin or SDK integration path.',
  openGraph: {
    title: 'Setup | Prismer Cloud',
    description: 'Set up your Prismer Cloud API key in 30 seconds. Choose plugin or SDK integration path.',
    url: 'https://prismer.cloud/setup',
    siteName: 'Prismer Cloud',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Setup | Prismer Cloud',
    description: 'Set up your Prismer Cloud API key in 30 seconds. Choose plugin or SDK integration path.',
  },
};

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
