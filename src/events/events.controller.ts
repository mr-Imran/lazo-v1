import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { CreateEventInput, EventRecord, UpdateEventInput } from './event.entity.js';
import { EventsService } from './events.service.js';
import { SubEventsService } from './sub-events.service.js';
import type { SubEvent } from './sub-events.service.js';

/** Guarded by the global ClerkAuthGuard — every route here needs a session. */
@Controller('api/events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly subEvents: SubEventsService,
  ) {}

  @Get()
  async list(@CurrentUser('userId') userId: string): Promise<{ events: EventRecord[] }> {
    return { events: await this.events.findAllFor(userId) };
  }

  @Post()
  create(
    @CurrentUser('userId') userId: string,
    @Body() body: CreateEventInput,
  ): Promise<EventRecord> {
    return this.events.create(userId, body ?? {});
  }

  @Get(':id')
  findOne(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<EventRecord> {
    return this.events.findOneFor(userId, id);
  }

  // ---- Event Info: the celebrations inside an event (ceremony, reception…)

  @Get(':id/sub-events')
  async subEventList(@CurrentUser('userId') userId: string, @Param('id') id: string): Promise<{ subEvents: SubEvent[] }> {
    const event = await this.events.findOneFor(userId, id);
    return { subEvents: await this.subEvents.list(event.id) };
  }

  /** { kind, date?, arriveTime?, beginTime?, guestCount?, venue? } */
  @Post(':id/sub-events')
  async subEventCreate(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ subEvents: SubEvent[] }> {
    const event = await this.events.findOneFor(userId, id);
    return { subEvents: await this.subEvents.create(event, body ?? {}) };
  }

  @Patch(':id/sub-events/:subId')
  async subEventUpdate(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('subId') subId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<{ subEvents: SubEvent[] }> {
    const event = await this.events.findOneFor(userId, id);
    return { subEvents: await this.subEvents.update(event, subId, body ?? {}) };
  }

  @Delete(':id/sub-events/:subId')
  async subEventRemove(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('subId') subId: string,
  ): Promise<{ subEvents: SubEvent[] }> {
    const event = await this.events.findOneFor(userId, id);
    return { subEvents: await this.subEvents.remove(event.id, subId) };
  }

  @Patch(':id')
  update(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() body: UpdateEventInput,
  ): Promise<EventRecord> {
    return this.events.update(userId, id, body ?? {});
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser('userId') userId: string, @Param('id') id: string): Promise<void> {
    return this.events.remove(userId, id);
  }
}
