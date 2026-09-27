import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from './roles.decorator.js';
import type { AppRole } from './roles.decorator.js';
import { UserRoleService } from './user-role.service.js';
import { getAuthContext } from './auth-context.js';

/**
 * Enforces @Roles(...). Registered after ClerkAuthGuard, so by the time this
 * runs the request is known to carry a valid session; routes without @Roles
 * are left alone.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly roles: UserRoleService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length) {
      return true;
    }

    // An API key resolves to its owner's Clerk id, and the role is then read
    // from Clerk exactly as it is for a session — except for admin, below.
    const auth = getAuthContext(context.switchToHttp().getRequest<Request>());

    if (!auth) {
      throw new ForbiddenException('Not allowed');
    }

    // API keys are for integrations acting as their owner. A leaked key from an
    // admin account must not carry admin powers, so those need a live session.
    if (required.includes('admin') && auth.via === 'apiKey') {
      throw new ForbiddenException('Admin actions need a signed-in session, not an API key');
    }

    const role = await this.roles.resolve(auth.userId, auth.sessionClaims);

    if (!role || !required.includes(role)) {
      // Deliberately vague: a non-admin learns nothing about what exists here.
      throw new ForbiddenException('Not allowed');
    }

    return true;
  }
}
