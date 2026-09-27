import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { getAuthContext } from './auth-context.js';

/**
 * Injects the caller, or a single property of them:
 *
 *   getProfile(@CurrentUser('userId') userId: string) { ... }
 *
 * Reads the AuthContext the guard recorded, so it is identical whether the
 * request arrived with a Clerk session or an API key.
 */
export const CurrentUser = createParamDecorator(
  (property: string | undefined, context: ExecutionContext) => {
    const auth = getAuthContext(context.switchToHttp().getRequest<Request>());

    if (!auth) {
      // A guarded route cannot reach here; a @Public() one asking for the user
      // is a mistake worth surfacing loudly rather than handing back undefined.
      throw new UnauthorizedException();
    }

    return property ? auth[property as keyof typeof auth] : auth;
  },
);
