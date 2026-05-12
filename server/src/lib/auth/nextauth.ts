/**
 * NextAuth v5 配置 — pcrefactor Prismer Cloud
 *
 * 邮箱/密码 + Google OAuth + GitHub OAuth
 * 用户存储: IMUser (role='human')，认证字段由 migration 130 添加
 */

import NextAuth, { NextAuthConfig } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import GitHubProvider from 'next-auth/providers/github';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      numericId: number;
      email: string;
      name: string;
      image?: string;
    };
  }

  interface User {
    id: string;
    numericId?: number;
    email: string;
    name: string;
    image?: string;
  }
}

function isUserActive(user: { banned: boolean; suspendedUntil?: Date | null }): boolean {
  if (user.banned) return false;
  if (user.suspendedUntil && user.suspendedUntil > new Date()) return false;
  return true;
}

function mergeMetaLastLogin(existing?: string | null): string {
  const base: Record<string, unknown> = existing
    ? (() => {
        try {
          return JSON.parse(existing);
        } catch {
          return {};
        }
      })()
    : {};
  base.lastLoginAt = new Date().toISOString();
  return JSON.stringify(base);
}

const credentialsSchema = z.object({
  email: z.string().email('请输入有效的邮箱地址'),
  password: z.string().min(8, '密码至少 8 位'),
});

export const authConfig: NextAuthConfig = {
  trustHost: true,

  pages: {
    signIn: '/auth',
    signOut: '/auth',
    error: '/auth',
    newUser: '/dashboard',
  },

  session: {
    strategy: 'jwt',
    maxAge: 7 * 24 * 60 * 60,
  },

  providers: [
    CredentialsProvider({
      id: 'credentials',
      name: 'Email',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        try {
          const { email, password } = credentialsSchema.parse(credentials);
          const prisma = (await import('@/lib/prisma')).default;

          const user = await (prisma as any).iMUser.findFirst({
            where: { email, role: 'human' },
            select: {
              id: true,
              numericId: true,
              email: true,
              displayName: true,
              passwordHash: true,
              avatarUrl: true,
              banned: true,
              suspendedUntil: true,
              metadata: true,
            },
          });

          if (!user || !user.passwordHash || !isUserActive(user)) return null;

          const isValid = await bcrypt.compare(password, user.passwordHash);
          if (!isValid) return null;

          await (prisma as any).iMUser.update({
            where: { id: user.id },
            data: { metadata: mergeMetaLastLogin(user.metadata) },
          });

          return {
            id: user.id,
            numericId: user.numericId ? Number(user.numericId) : undefined,
            email: user.email,
            name: user.displayName || user.email.split('@')[0],
            image: user.avatarUrl || undefined,
          };
        } catch (error) {
          console.error('[NextAuth] Credentials authorize error:', error);
          return null;
        }
      },
    }),

    // Nacos convention: NEXT_PUBLIC_*_CLIENT_ID (also visible to client
    // bundle) + *_CLIENT_SECRET (server-only). Plain *_CLIENT_ID kept as
    // fallback for local dev.
    ...((process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID) && process.env.GOOGLE_CLIENT_SECRET
      ? [
          GoogleProvider({
            clientId: (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID)!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          }),
        ]
      : []),

    ...((process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID) && process.env.GITHUB_CLIENT_SECRET
      ? [
          GitHubProvider({
            clientId: (process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID)!,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          }),
        ]
      : []),
  ],

  callbacks: {
    async jwt({ token, user, account, profile }) {
      if (user) {
        token.id = user.id;
        token.numericId = user.numericId;
        token.email = user.email;
        token.name = user.name;
        token.picture = user.image;
      }

      if (account?.provider && account.provider !== 'credentials') {
        try {
          const prisma = (await import('@/lib/prisma')).default;

          // Account-linking security: prefer match by provider account-id
          // (immutable). Only fall back to email match when the provider
          // explicitly says the email is verified. profile.email_verified
          // is set by next-auth from the OIDC userinfo (Google) and from
          // GitHub's primary verified email.
          // profile field shape varies by provider; Google sends boolean,
          // GitHub doesn't include this field (we don't fall back to email
          // for GitHub at this layer — see local-auth.ts for the
          // /user/emails-based check).
          const profileVerified =
            (profile as any)?.email_verified === true || (profile as any)?.email_verified === 'true';

          const providerIdMatch =
            account.provider === 'google'
              ? { googleId: account.providerAccountId }
              : account.provider === 'github'
                ? { githubId: account.providerAccountId }
                : null;

          let dbUser = providerIdMatch
            ? await (prisma as any).iMUser.findFirst({ where: { ...providerIdMatch, role: 'human' } })
            : null;

          if (!dbUser && profileVerified && token.email) {
            dbUser = await (prisma as any).iMUser.findFirst({
              where: { email: token.email, role: 'human' },
            });
          }

          if (!dbUser) {
            const username = (token.email as string).split('@')[0] + '_' + Math.random().toString(36).slice(2, 6);

            dbUser = await (prisma as any).iMUser.create({
              data: {
                email: token.email!,
                username,
                displayName: token.name || (token.email as string).split('@')[0],
                avatarUrl: token.picture || undefined,
                googleId: account.provider === 'google' ? account.providerAccountId : undefined,
                githubId: account.provider === 'github' ? account.providerAccountId : undefined,
                emailVerified: profileVerified,
                role: 'human',
                metadata: mergeMetaLastLogin(null),
              },
            });
          } else {
            const updateData: Record<string, unknown> = {
              metadata: mergeMetaLastLogin(dbUser.metadata),
            };
            if (account.provider === 'google' && !dbUser.googleId) {
              updateData.googleId = account.providerAccountId;
            }
            if (account.provider === 'github' && !dbUser.githubId) {
              updateData.githubId = account.providerAccountId;
            }
            await (prisma as any).iMUser.update({ where: { id: dbUser.id }, data: updateData });
          }

          token.id = dbUser.id;
          token.numericId = dbUser.numericId ? Number(dbUser.numericId) : undefined;
        } catch (error) {
          console.error('[NextAuth] OAuth callback error:', error);
        }
      }

      return token;
    },

    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.numericId = (token.numericId as number) || 0;
        session.user.email = token.email as string;
        session.user.name = token.name as string;
        session.user.image = token.picture as string | undefined;
      }
      return session;
    },

    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isOnAuth = nextUrl.pathname.startsWith('/auth') || nextUrl.pathname.startsWith('/login');
      const isOnDashboard = nextUrl.pathname.startsWith('/dashboard');

      if (isLoggedIn && isOnAuth) {
        return Response.redirect(new URL('/dashboard', nextUrl));
      }
      if (!isLoggedIn && isOnDashboard && process.env.NODE_ENV !== 'development') {
        return Response.redirect(new URL('/auth', nextUrl));
      }
      return true;
    },
  },

  events: {
    async signIn({ user, account }) {
      console.log(`[NextAuth] User signed in: ${user.email} via ${account?.provider || 'credentials'}`);
    },
    async signOut() {
      console.log('[NextAuth] User signed out');
    },
  },

  debug: process.env.NODE_ENV === 'development',
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
