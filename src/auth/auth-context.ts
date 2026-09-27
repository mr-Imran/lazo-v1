import { getAuth } from '@clerk/express';
import type { Request } from 'express';

/** Header an API client sends instead of a Clerk session token. */
export const API_KEY_HEADER = 'x-api-key';

const CONTEXT_KEY = '__lazoAuth';

export interface AuthContext {
  userId: string;
  /** How the caller proved who they are. */
  via: 'session' | 'apiKey';
  /** Present only for sessions — an API key carries no Clerk claims. */
  sessionClaims: unknown;
}

/**
 * The one place the rest of the app asks "who is calling?".
 *
 * A request authenticated by API key has no Clerk session, so `getAuth()`
 * returns nothing for it. Guards record the answer here instead, and everything
 * downstream — @CurrentUser, RolesGuard — reads it back, which keeps both
 * credential types on exactly the same path.
 */
export function setAuthContext(request: Request, context: AuthContext): void {
  (request as Request & Record<string, unknown>)[CONTEXT_KEY] = context;
}

export function getAuthContext(request: Request): AuthContext | null {
  const stored = (request as Request & Record<string, unknown>)[CONTEXT_KEY];

  if (stored) {
    return stored as AuthContext;
  }

  // Falls back to Clerk so anything reached without passing a guard — a public
  // route reading the optional caller — still sees a signed-in session.
  try {
    const auth = getAuth(request);

    return auth.userId
      ? { userId: auth.userId, via: 'session', sessionClaims: auth.sessionClaims }
      : null;
  } catch {
    // getAuth throws when clerkMiddleware was never mounted.
    return null;
  }
}

export const readApiKey = (request: Request): string | null => {
  const header = request.headers[API_KEY_HEADER];
  const value = Array.isArray(header) ? header[0] : header;

  return value?.trim() || null;
};
