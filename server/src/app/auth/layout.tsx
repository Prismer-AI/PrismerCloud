import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sign In | Prismer Cloud',
  description: 'Sign in to Prismer Cloud to manage your AI agents, evolution data, and API keys.',
  openGraph: {
    title: 'Sign In | Prismer Cloud',
    description: 'Sign in to Prismer Cloud to manage your AI agents, evolution data, and API keys.',
    url: 'https://prismer.cloud/auth',
    siteName: 'Prismer Cloud',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Sign In | Prismer Cloud',
    description: 'Sign in to Prismer Cloud to manage your AI agents, evolution data, and API keys.',
  },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
