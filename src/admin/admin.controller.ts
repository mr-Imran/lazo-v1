import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Query } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { EventsService } from '../events/events.service.js';
import { AdminUsersService } from './admin-users.service.js';
import { UsersService } from '../users/users.service.js';
import type { UserRecord } from '../users/users.service.js';
import { WebsiteService } from '../website/website.service.js';
import type { CustomThemeRequest } from '../website/website.service.js';
import type { AdminUserPage } from './admin-users.service.js';
import type {
  AdminUpdateEventInput,
  AdminEventPage,
  AdminEventQuery,
  EventRecord,
  EventStats,
} from '../events/event.entity.js';

/**
 * Admin surface, used by the backend dashboard (/dashboard#admin and friends).
 *
 * @Roles at the controller level covers every route below, and the global
 * ClerkAuthGuard has already established who is calling. Everything here
 * deliberately ignores ownership: these routes see all users' events.
 */
@Roles('admin')
@Controller('api/admin')
export class AdminController {
  constructor(
    private readonly events: EventsService,
    private readonly users: AdminUsersService,
    private readonly mirror: UsersService,
    private readonly website: WebsiteService,
  ) {}

  /** Confirms the caller really is an admin — handy for gating an admin UI. */
  @Get('me')
  me(@CurrentUser('userId') userId: string): { userId: string; role: 'admin' } {
    return { userId, role: 'admin' };
  }

  @Get('stats')
  stats(): Promise<EventStats> {
    return this.events.stats();
  }

  /**
   * Every event, newest first.
   *
   * Filters: ownerId, type, search (event name), from / to (event date,
   * YYYY-MM-DD), limit (1–100, default 25), offset.
   */
  @Get('events')
  listEvents(@Query() query: AdminEventQuery): Promise<AdminEventPage> {
    return this.events.findAllAsAdmin(this.events.parseAdminQuery(query));
  }

  @Get('events/:id')
  findEvent(@Param('id') id: string): Promise<EventRecord> {
    return this.events.findAnyById(id);
  }

  /** Publish / unpublish (state), set the subdomain, or rename. */
  @Patch('events/:id')
  updateEvent(@Param('id') id: string, @Body() body: AdminUpdateEventInput): Promise<EventRecord> {
    return this.events.updateAsAdmin(id, body ?? {});
  }

  @Delete('events/:id')
  @HttpCode(204)
  removeEvent(@Param('id') id: string): Promise<void> {
    return this.events.removeAny(id);
  }

  /** The public.users mirror, as synced from Clerk, with event counts. */
  @Get('users/mirror')
  async mirrorUsers(): Promise<{ users: (UserRecord & { eventCount: number })[] }> {
    return { users: await this.mirror.listWithEventCounts() };
  }

  @Get('custom-requests')
  async customRequests(): Promise<{ requests: (CustomThemeRequest & { ownerId: string; eventName: string | null })[] }> {
    return { requests: await this.website.listRequests() };
  }

  @Patch('custom-requests/:id')
  setRequestStatus(
    @Param('id') id: string,
    @Body('status') status: unknown,
  ): Promise<CustomThemeRequest> {
    return this.website.setRequestStatus(id, status);
  }

  /** Clerk is the source of truth for people; this just reads it back. */
  @Get('users')
  listUsers(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('query') search?: string,
  ): Promise<AdminUserPage> {
    return this.users.list({ limit, offset, search });
  }
}
