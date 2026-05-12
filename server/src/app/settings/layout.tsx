import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Settings | Prismer Cloud',
  description: 'Manage CEO authorization, account, and workspace preferences.',
  openGraph: {
    title: 'Settings | Prismer Cloud',
    description: 'Manage CEO authorization, account, and workspace preferences.',
    url: 'https://prismer.cloud/settings',
    siteName: 'Prismer Cloud',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Settings | Prismer Cloud',
    description: 'Manage CEO authorization, account, and workspace preferences.',
  },
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
