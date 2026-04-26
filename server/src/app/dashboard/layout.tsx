import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Dashboard | Prismer Cloud',
  description: 'Monitor your API usage, credits, and agent activity.',
  openGraph: {
    title: 'Dashboard | Prismer Cloud',
    description: 'Monitor your API usage, credits, and agent activity.',
    url: 'https://prismer.cloud/dashboard',
    siteName: 'Prismer Cloud',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Dashboard | Prismer Cloud',
    description: 'Monitor your API usage, credits, and agent activity.',
  },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
