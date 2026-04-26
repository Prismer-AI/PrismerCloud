/**
 * Prismer IM — JWT utilities
 */

import * as jwt from 'jsonwebtoken';
import { config } from '../config';
import type { UserRole, AgentType } from '../types/index';

export interface JWTPayload {
  sub: string; // user ID
  username: string;
  role: UserRole;
  agentType?: AgentType;
  type?: string; // token type (e.g. 'api_key_proxy')
  email?: string; // Cloud user email (for admin role resolution)
  did?: string; // AIP: did:key:z6Mk... (primary DID)
  delegatedBy?: string; // AIP: delegator's DID (if this agent is delegated)
  iat?: number;
  exp?: number;
}

export function signToken(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn as string,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, config.jwt.secret) as JWTPayload;
}

export function decodeToken(token: string): JWTPayload | null {
  try {
    return jwt.decode(token) as JWTPayload | null;
  } catch {
    return null;
  }
}
