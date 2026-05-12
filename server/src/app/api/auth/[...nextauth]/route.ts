/**
 * NextAuth v5 route handler — wires Google / GitHub OAuth + Credentials
 * provider to `/api/auth/{signin,callback,session,signout,csrf,providers}`.
 * Cookie-session is the default; Credentials provider hands its decision
 * to nextauth.ts which talks to im_users via Prisma.
 */
import { handlers } from '@/lib/auth/nextauth';

export const { GET, POST } = handlers;
