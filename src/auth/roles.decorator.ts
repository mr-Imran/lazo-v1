import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'requiredRoles';

/** The roles this app knows about. Anyone signed in but unlisted is a planner. */
export type AppRole = 'admin';

/**
 * Restricts a route (or a whole controller) to the given roles:
 *
 *   @Roles('admin')
 *   @Get('events')
 *   listEverything() { ... }
 *
 * Stacks on top of the global Clerk guard — the caller must be signed in first.
 */
export const Roles = (...roles: AppRole[]) => SetMetadata(ROLES_KEY, roles);
