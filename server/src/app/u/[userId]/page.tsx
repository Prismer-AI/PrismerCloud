import { cache } from 'react';
import { Metadata } from 'next';
import Image from 'next/image';
import { OpenInAppButton } from './open-in-app';

interface Props {
  params: Promise<{ userId: string }>;
}

const fetchUser = cache(async (userId: string) => {
  try {
    const { default: prisma } = await import('@/im/db');

    let user = await prisma.iMUser.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
    });

    if (!user) {
      user = await prisma.iMUser.findFirst({
        where: { username: userId },
        select: { id: true, username: true, displayName: true, avatarUrl: true, role: true },
      });
    }

    return user;
  } catch (e) {
    console.error('[UserCard] Failed to fetch user:', e);
    return null;
  }
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { userId } = await params;
  const user = await fetchUser(userId);

  return {
    title: user ? `${user.displayName || user.username} on Prismer` : 'Join Prismer',
    description: user
      ? `Add ${user.displayName || user.username} (@${user.username}) as a contact on Lumin`
      : 'Join Prismer — The Knowledge Drive for AI Agents',
    robots: 'noindex, nofollow',
    openGraph: {
      title: user ? `${user.displayName || user.username} on Prismer` : 'Join Prismer',
      description: 'Scan to add as a contact on Lumin',
      images: user?.avatarUrl ? [user.avatarUrl] : ['/logo-light.png'],
    },
  };
}

export default async function UserCardPage({ params }: Props) {
  const { userId } = await params;
  const user = await fetchUser(userId);

  const displayName = user?.displayName || user?.username || userId;
  const username = user?.username || userId;
  const avatarUrl = user?.avatarUrl;
  const role = user?.role || 'human';
  const customSchemeUrl = `prismer://u/${user?.id || userId}`;

  return (
    <div className="min-h-screen bg-[#0A0A0F] text-zinc-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Card */}
        <div className="rounded-2xl bg-white/[0.07] backdrop-blur-2xl border border-white/[0.10] shadow-[0_8px_28px_rgba(0,0,0,0.4),0_2px_6px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.06)] p-8 text-center">
          {/* Logo */}
          <div className="mb-6">
            <Image
              src="/logo-light.png"
              alt="Prismer"
              width={120}
              height={24}
              className="h-6 w-auto mx-auto opacity-60"
            />
          </div>

          {/* Avatar */}
          <div className="flex justify-center mb-4">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={displayName}
                className="h-20 w-20 rounded-full object-cover ring-2 ring-violet-400/30"
              />
            ) : (
              <div
                className={`flex h-20 w-20 items-center justify-center rounded-full text-3xl font-bold ring-2 ${
                  role === 'agent'
                    ? 'bg-gradient-to-br from-cyan-500/20 to-teal-500/20 text-cyan-400 ring-cyan-400/30'
                    : 'bg-gradient-to-br from-violet-500/20 to-purple-500/20 text-violet-400 ring-violet-400/30'
                }`}
              >
                {displayName[0].toUpperCase()}
              </div>
            )}
          </div>

          {/* Name */}
          <h1 className="text-xl font-bold">{displayName}</h1>
          <p className="text-sm text-zinc-400 mt-1">@{username}</p>
          {role === 'agent' && (
            <span className="mt-2 inline-block rounded px-2 py-0.5 text-xs font-medium bg-cyan-500/10 text-cyan-400">
              Agent
            </span>
          )}

          {/* Actions */}
          <div className="mt-8 space-y-3">
            <OpenInAppButton customSchemeUrl={customSchemeUrl} />

            {/* App Store — placeholder until listed */}
            <a
              href="https://prismer.cloud"
              className="block w-full rounded-xl border border-white/10 bg-white/5 py-3 text-sm font-medium text-zinc-300 hover:bg-white/[0.08] transition-colors"
            >
              Download on App Store
            </a>
          </div>

          {/* Tagline */}
          <p className="mt-6 text-xs text-zinc-500 leading-relaxed">
            Scan QR codes, share memories, chat with AI agents — all in one.
          </p>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-zinc-600 mt-6">Powered by Prismer Cloud</p>
      </div>
    </div>
  );
}
