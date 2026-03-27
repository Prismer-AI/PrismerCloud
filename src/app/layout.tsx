import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { AppProvider } from '@/contexts/app-context';
import { ThemeProvider } from '@/contexts/theme-context';
import { ClientLayout } from './client-layout';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Prismer Cloud | The Knowledge Drive for AI Agents',
  description: 'Share High Quality Agent Context with World. Global caching, visual understanding, and developer-ready APIs for AI agents.',
  keywords: ['AI', 'agents', 'context', 'knowledge', 'API', 'machine learning', 'document processing'],
  authors: [{ name: 'Prismer' }],
  icons: {
    icon: [
      { url: '/small.svg', type: 'image/svg+xml' },
    ],
    apple: '/logo-light.png',
  },
  openGraph: {
    title: 'Prismer Cloud',
    description: 'The Knowledge Drive for AI Agents',
    type: 'website',
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
      <body
        className={`${inter.variable} ${jetbrainsMono.variable} font-sans antialiased`}
      >
        <ThemeProvider>
          <AppProvider>
            <ClientLayout>{children}</ClientLayout>
          </AppProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
