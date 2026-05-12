import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Workspace · Prismer Cloud',
  description:
    'Personal workspace for Prismer Cloud — sessions, assets, devices, agents, and task board collaboration.',
  robots: { index: false, follow: false },
};

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  return children;
}
