import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { EventsService } from '../events/events.service.js';
import { GuestsService } from '../guests/guests.service.js';
import { PhotosService } from '../photos/photos.service.js';
import { RegistryService } from '../site-content/registry.service.js';

type Body = Record<string, unknown>;

/**
 * The post-event flow (PRD §2.1): who came, gifts and thank-yous, photos
 * waiting for moderation, and closing the event. Owner-only. Everything is
 * read from the guest list, registry and gallery, so there is no new table:
 * only guests.attended and events.closed_at (20261008000000_core_gaps.sql).
 */
@Controller('api/events/:id')
export class AfterEventController {
  constructor(
    private readonly events: EventsService,
    private readonly guests: GuestsService,
    private readonly registry: RegistryService,
    private readonly photos: PhotosService,
  ) {}

  @Get('after')
  async summary(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    const event = await this.events.findOneFor(userId, id);
    const [guests, registry, gallery] = await Promise.all([
      this.guests.overview(event),
      this.registry.overview(event.id).catch(() => ({ items: [], gifts: [] })),
      this.photos.overview(event.id).catch(() => ({ open: true, photos: [], pending: 0 })),
    ]);

    // "Attending" = said yes to at least one celebration; "came" = host-marked.
    const people = guests.households.flatMap((h) => h.guests);
    const attending = people.filter((g) => Object.values(g.rsvps).some((a) => a.status === 'attending'));
    const gifts = registry.gifts.filter((g) => g.status !== 'cancelled' && g.status !== 'refunded');

    return {
      event: { id: event.id, name: event.name, date: event.date, closedAt: event.closedAt, state: event.state, siteUrl: event.siteUrl },
      guests: {
        invited: people.length,
        attending: attending.length,
        came: people.filter((g) => g.attended === true).length,
        noShow: people.filter((g) => g.attended === false).length,
        unmarked: people.filter((g) => g.attended === null).length,
        // The list the host ticks off: attending guests first, then the rest.
        list: [...guests.households]
          .map((h) => ({
            id: h.id,
            name: h.name,
            guests: h.guests.map((g) => ({
              id: g.id,
              name: g.fullName,
              attended: g.attended,
              attending: Object.values(g.rsvps).some((a) => a.status === 'attending'),
            })),
          }))
          .sort((a, b) => Number(b.guests.some((g) => g.attending)) - Number(a.guests.some((g) => g.attending))),
      },
      gifts: {
        total: gifts.length,
        thanked: gifts.filter((g) => g.thankedAt).length,
        list: gifts.map((g) => ({ id: g.id, guestName: g.guestName, amountCents: g.amountCents, currency: g.currency, thankedAt: g.thankedAt })),
      },
      photos: { pending: gallery.pending, total: gallery.photos.length },
    };
  }

  /** { attended: true | false | null } */
  @Patch('guests/:guestId/attendance')
  async attendance(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('guestId') guestId: string, @Body() body: Body) {
    return this.guests.setAttendance(await this.events.findOneFor(userId, id), guestId, body ?? {});
  }

  /** Sets events.closed_at. The site stays live; RSVP is refused from now on. */
  @Post('close')
  @HttpCode(200)
  close(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.events.close(userId, id);
  }
}
