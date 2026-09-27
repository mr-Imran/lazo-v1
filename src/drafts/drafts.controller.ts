import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import type { CreateEventInput, EventRecord, UpdateEventInput } from '../events/event.entity.js';
import { EventsService } from '../events/events.service.js';

/**
 * Anonymous drafts: the details step of the create flow saved before there is
 * an account (PRD §2.1). The row is an event in state 'anonymous_draft'; the
 * browser keeps { id, token } and hands them over once signed up.
 *
 * Rate limit: 'drafts' rule in src/common/http-hardening.ts (per IP, in memory).
 */
@Controller('api/drafts')
export class DraftsController {
  constructor(private readonly events: EventsService) {}

  /** Same body as POST /api/events. Returns the event plus `claimToken` (shown once). */
  @Public()
  @PlainPayload()
  @Post()
  @HttpCode(201)
  create(@Body() body: CreateEventInput): Promise<EventRecord & { claimToken?: string }> {
    return this.events.create(null, body ?? {});
  }

  /** ?token=<raw claim token>. 404 for a wrong token, an expired or a claimed draft. */
  @Public()
  @PlainPayload()
  @Get(':id')
  find(@Param('id') id: string, @Query('token') token: string | undefined): Promise<EventRecord> {
    return this.events.findAnonymousDraft(id, token);
  }

  /** { token, details?, date?, location? } — the details step re-saving. */
  @Public()
  @PlainPayload()
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { token?: unknown } & UpdateEventInput & CreateEventInput): Promise<EventRecord> {
    return this.events.updateAnonymousDraft(id, body?.token, body ?? {});
  }

  /** { token } — the signed-in caller becomes the owner; state moves to 'draft'. */
  @Post(':id/claim')
  @HttpCode(200)
  claim(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: { token?: unknown }): Promise<EventRecord> {
    return this.events.claim(userId, id, body?.token);
  }
}
