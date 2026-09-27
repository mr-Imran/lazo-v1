import { Controller, Get, Headers, NotFoundException, Param, Query, UnauthorizedException } from '@nestjs/common';
import { tokenMatches } from '../site-content/site-content.service.js';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { parseSlug, siteConfig, siteUrlFor } from './site-config.js';
import { SitesService } from './sites.service.js';
import type { PublicSite } from './sites.service.js';

@Controller('api/sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  /**
   * Where sites are hosted, so a UI can show "<slug>.lazo.com" while the host
   * types. Public: it's the same for everyone and holds nothing secret.
   */
  @Public()
  @PlainPayload()
  @Get('config')
  config(): { configured: boolean; domain: string | null; scheme: string | null } {
    const config = siteConfig();

    return { configured: Boolean(config), domain: config?.domain ?? null, scheme: config?.scheme ?? null };
  }

  /**
   * What the frontend renders at <slug>.<SITE_DOMAIN>. Public, and only for
   * live events; anything else is a 404 that says whether the address is
   * claimed-but-unpublished, so the page can word it right.
   */
  @Public()
  @PlainPayload()
  @Get('by-slug/:slug')
  async bySlug(
    @Param('slug') slug: string,
    @Headers('x-site-token') token: string | undefined,
  ): Promise<Omit<PublicSite, 'state' | 'passwordHash' | 'eventId'>> {
    const site = await this.sites.findBySlug(String(slug).toLowerCase());

    if (!site) throw new NotFoundException({ message: 'No site at this address', reason: 'missing' });
    if (site.state !== 'live') {
      throw new NotFoundException({ message: 'This website isn’t published yet', reason: 'unpublished' });
    }

    // Private sites: nothing but "this is private" until the password is given.
    if (site.passwordHash && !tokenMatches(site.slug, site.passwordHash, token)) {
      throw new UnauthorizedException({ message: 'This site is private. Enter the password to continue.', reason: 'password' });
    }

    const { state: _state, passwordHash: _hash, eventId, ...publicSite } = site;
    void this.sites.countView(eventId);
    return publicSite;
  }

  /** Is a subdomain valid and free? `eventId` ignores that event's own claim. */
  @Get('check')
  async check(
    @Query('slug') slug: string,
    @Query('eventId') eventId?: string,
  ): Promise<{ slug: string; available: boolean; url: string | null }> {
    const parsed = parseSlug(slug ?? '');
    if (!parsed) return { slug: '', available: false, url: null };

    return {
      slug: parsed,
      available: await this.sites.isAvailable(parsed, eventId),
      url: siteUrlFor(parsed),
    };
  }
}
