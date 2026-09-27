import { Injectable, Logger } from '@nestjs/common';
import { clerkClient } from '@clerk/express';
import type { AppRole } from './roles.decorator.js';

/** How long a resolved role is trusted before Clerk is asked again. */
const CACHE_TTL_MS = 60_000;

interface CachedRole {
  role: AppRole | null;
  expiresAt: number;
}

/**
 * Works out whether a signed-in user is an admin.
 *
 * Two sources, cheapest first:
 *
 *  1. The session token, if the Clerk instance was set up to carry metadata
 *     (Dashboard → Sessions → Customize session token, e.g.
 *     `{ "metadata": "{{user.public_metadata}}" }`). No network call.
 *  2. Clerk's backend API, cached briefly. Private metadata wins over public,
 *     so the role can be moved server-side later without touching this code.
 *
 * Roles are never read from anything the browser sends — only from claims Clerk
 * signed, or from Clerk itself.
 */
@Injectable()
export class UserRoleService {
  private readonly logger = new Logger(UserRoleService.name);
  private readonly cache = new Map<string, CachedRole>();

  async resolve(userId: string, sessionClaims: unknown): Promise<AppRole | null> {
    const fromClaims = roleFromClaims(sessionClaims);

    if (fromClaims) {
      return fromClaims;
    }

    const cached = this.cache.get(userId);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.role;
    }

    let role: AppRole | null = null;

    try {
      const user = await clerkClient.users.getUser(userId);
      role =
        asRole(user.privateMetadata?.['role']) ?? asRole(user.publicMetadata?.['role']);
    } catch (error) {
      // Treat an unreachable Clerk as "not an admin" rather than as an admin.
      // The caller turns a null role into a 403.
      this.logger.error(`Could not read the role for ${userId}: ${describe(error)}`);

      return null;
    }

    this.cache.set(userId, { role, expiresAt: Date.now() + CACHE_TTL_MS });

    return role;
  }

  /** Lets a role change take effect without waiting out the TTL. */
  forget(userId: string): void {
    this.cache.delete(userId);
  }
}

/**
 * Clerk rejections are not Errors — they carry `status` and an `errors` array,
 * so `error.message` alone logs nothing useful.
 */
function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const { status, errors } = error as {
      status?: number;
      errors?: { message?: string; longMessage?: string }[];
    };
    const first = errors?.[0];

    if (status ?? first) {
      return [status, first?.longMessage ?? first?.message].filter(Boolean).join(' ');
    }
  }

  return error instanceof Error ? error.message : String(error);
}

function asRole(value: unknown): AppRole | null {
  return value === 'admin' ? 'admin' : null;
}

/** Checks the shapes a customised Clerk session token might use. */
function roleFromClaims(sessionClaims: unknown): AppRole | null {
  if (!sessionClaims || typeof sessionClaims !== 'object') {
    return null;
  }

  const claims = sessionClaims as Record<string, unknown>;

  for (const key of ['metadata', 'publicMetadata', 'public_metadata']) {
    const group = claims[key];

    if (group && typeof group === 'object') {
      const role = asRole((group as Record<string, unknown>)['role']);

      if (role) {
        return role;
      }
    }
  }

  return asRole(claims['role']);
}
