import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { UsersService } from './users.service.js';
import type { UserRecord } from './users.service.js';

/** Guarded by the global ClerkAuthGuard — the caller is always the user. */
@Controller('api/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser('userId') userId: string): Promise<UserRecord> {
    return this.users.findOne(userId);
  }

  /**
   * Called by the frontend straight after sign-in or sign-up. Takes no body:
   * the profile is re-read from Clerk, so the caller cannot write its own.
   */
  @Post('me/sync')
  @HttpCode(200)
  sync(@CurrentUser('userId') userId: string): Promise<UserRecord> {
    return this.users.syncFromClerk(userId);
  }
}
