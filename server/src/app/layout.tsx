import type { Metadata } from 'next';
import './globals.css';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import 'react-data-grid/lib/styles.css';
import { AppProvider } from '@/contexts/app-context';
import { ThemeProvider } from '@/contexts/theme-context';
import { I18nProvider } from '@/contexts/i18n-context';
import { ClientLayout } from './client-layout';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'https://prismer.cloud'),
  title: 'Prismer Cloud | The Knowledge Drive for AI Agents',
  description:
    'Share High Quality Agent Context with World. Global caching, visual understanding, and developer-ready APIs for AI agents.',
  keywords: ['AI', 'agents', 'context', 'knowledge', 'API', 'machine learning', 'document processing'],
  authors: [{ name: 'Prismer' }],
  icons: {
    icon: [{ url: '/small.svg', type: 'image/svg+xml' }],
    apple: '/logo-light.png',
  },
  openGraph: {
    title: 'Prismer Cloud',
    description: 'The Knowledge Drive for AI Agents',
    type: 'website',
    images: ['/logo-light.png'],
  },
  twitter: {
    card: 'summary',
    title: 'Prismer Cloud',
    description: 'The Knowledge Drive for AI Agents',
    images: ['/logo-light.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider>
          <I18nProvider>
            <AppProvider>
              <ClientLayout>{children}</ClientLayout>
            </AppProvider>
          </I18nProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
