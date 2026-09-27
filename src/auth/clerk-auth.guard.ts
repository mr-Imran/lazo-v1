import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getAuth } from '@clerk/express';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator.js';
import { readApiKey, setAuthContext } from './auth-context.js';
import { ApiKeysService } from '../api-keys/api-keys.service.js';

/**
 * Accepts either credential:
 *
 *  - `x-api-key: lazo_sk_...` — a key minted from the dashboard, acting as the
 *    user who owns it.
 *  - `Authorization: Bearer <clerk session token>` — a signed-in browser.
 *
 * The key is checked first so an API client never depends on Clerk being
 * reachable. Either way the request ends up with the same AuthContext, so
 * everything downstream is indifferent to which was used.
 */
@Injectable()
export class ClerkAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const presented = readApiKey(request);

    if (presented) {
      const ownerId = await this.apiKeys.resolveOwner(presented);

      if (!ownerId) {
        throw new UnauthorizedException();
      }

      setAuthContext(request, { userId: ownerId, via: 'apiKey', sessionClaims: null });

      return true;
    }

    let userId: string | null;
    let sessionClaims: unknown;

    try {
      ({ userId, sessionClaims } = getAuth(request));
    } catch {
      // getAuth throws when clerkMiddleware was never mounted, which happens
      // when the Clerk keys are missing. That is a server config problem, not
      // a bad credential, so say so rather than returning a misleading 401.
      throw new ServiceUnavailableException('Authentication is not configured');
    }

    if (!userId) {
      throw new UnauthorizedException();
    }

    setAuthContext(request, { userId, via: 'session', sessionClaims });

    return true;
  }
}
