import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import type {
  CustomThemeRequestRow,
  ServiceRow,
  ThemeRow,
} from '../supabase/database.types.js';

/** PostgREST: the relation is not in its schema cache (migration not applied). */
const UNDEFINED_TABLE = 'PGRST205';
const UNIQUE_VIOLATION = '23505';
const MIGRATION = 'supabase/migrations/20260925000000_website_builder.sql';
const CUSTOM_THEME = 'custom_theme';
const MAX_MODE = 40;

export interface Theme {
  id: string;
  slug: string;
  name: string;
  description: string;
  previewUrl: string;
  modes: string[];
}

export interface Service {
  key: string;
  name: string;
  priceCentavos: number;
  currency: string;
}

export interface CustomThemeRequest {
  id: string;
  eventId: string;
  serviceKey: string;
  priceCentavos: number;
  currency: string;
  status: CustomThemeRequestRow['status'];
  createdAt: string;
}

/** Themes, priced services, and custom-theme requests for the site builder. */
@Injectable()
export class WebsiteService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  /** Active themes in display order; with `mode`, only those suiting it. */
  async listThemes(mode: unknown): Promise<Theme[]> {
    const { data, error } = await this.db
      .from('themes')
      .select('*')
      .eq('active', true)
      .neq('preview_url', '')
      .order('position', { ascending: true })
      .order('name', { ascending: true });

    if (error) throw this.dbError('Could not load themes', error);

    // The catalog is small; filtering here keeps the rule in one readable
    // place. No modes listed means the theme suits every occasion.
    const wanted = typeof mode === 'string' && mode.length <= MAX_MODE ? mode.trim() : '';

    return data
      .filter((row) => !wanted || row.modes.length === 0 || row.modes.includes(wanted))
      .map(toTheme);
  }

  async getService(key: string): Promise<Service> {
    const { data, error } = await this.db
      .from('services')
      .select('*')
      .eq('key', key)
      .eq('active', true)
      .maybeSingle();

    if (error) throw this.dbError('Could not load the price', error);
    if (!data) throw new NotFoundException(`No service ${key}`);

    return toService(data);
  }

  /** The event's open request, or null. The caller has already checked ownership. */
  async findOpenRequest(eventId: string): Promise<CustomThemeRequest | null> {
    const { data, error } = await this.db
      .from('custom_theme_requests')
      .select('*')
      .eq('event_id', eventId)
      .in('status', ['requested', 'in_progress'])
      .maybeSingle();

    if (error) throw this.dbError('Could not load the request', error);

    return data ? toRequest(data) : null;
  }

  /**
   * Opens a custom-theme request at today's price and marks the event as a
   * custom build. Idempotent: asking again returns the open request.
   */
  async requestCustomTheme(ownerId: string, eventId: string): Promise<CustomThemeRequest> {
    const existing = await this.findOpenRequest(eventId);
    if (existing) return existing;

    const service = await this.getService(CUSTOM_THEME);

    const { data, error } = await this.db
      .from('custom_theme_requests')
      .insert({
        event_id: eventId,
        owner_id: ownerId,
        service_key: service.key,
        price_centavos: service.priceCentavos,
        currency: service.currency,
      })
      .select('*')
      .single();

    if (error?.code === UNIQUE_VIOLATION) {
      // A second tab won the race; hand back the one it created.
      const winner = await this.findOpenRequest(eventId);
      if (winner) return winner;
    }

    if (error) throw this.dbError('Could not save the request', error);

    const marked = await this.db
      .from('events')
      .update({ build_type: 'custom', theme_id: null, updated_at: new Date().toISOString() })
      .eq('id', eventId)
      .eq('owner_id', ownerId);

    if (marked.error) throw this.dbError('Could not update the event', marked.error);

    return toRequest(data);
  }

  /** Admin: every request, newest first, with its event's name. */
  async listRequests(): Promise<(CustomThemeRequest & { ownerId: string; eventName: string | null })[]> {
    const { data, error } = await this.db
      .from('custom_theme_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw this.dbError('Could not load requests', error);

    const ids = [...new Set(data.map((r) => r.event_id))];
    const names = new Map<string, string>();

    if (ids.length) {
      const events = await this.db.from('events').select('id, name').in('id', ids);
      if (events.error) throw this.dbError('Could not load events', events.error);
      for (const e of events.data) names.set(e.id, e.name);
    }

    return data.map((row) => ({
      ...toRequest(row),
      ownerId: row.owner_id,
      eventName: names.get(row.event_id) ?? null,
    }));
  }

  async setRequestStatus(id: string, status: unknown): Promise<CustomThemeRequest> {
    const allowed = ['requested', 'in_progress', 'delivered', 'cancelled'] as const;
    if (!allowed.includes(status as (typeof allowed)[number])) {
      throw new BadRequestException(`status must be one of: ${allowed.join(', ')}`);
    }

    const { data, error } = await this.db
      .from('custom_theme_requests')
      .update({ status: status as (typeof allowed)[number], updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle();

    if (error?.code === UNIQUE_VIOLATION) {
      throw new BadRequestException('This event already has another open request');
    }
    if (error) throw this.dbError('Could not update the request', error);
    if (!data) throw new NotFoundException(`No request ${id}`);

    return toRequest(data);
  }

  private dbError(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE) {
      return new ServiceUnavailableException(`A site-builder table is missing. Apply ${MIGRATION}.`);
    }

    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): LazoSupabaseClient {
    if (!this.supabase) {
      throw new ServiceUnavailableException('The database is not configured');
    }

    return this.supabase;
  }
}

function toTheme(row: ThemeRow): Theme {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    previewUrl: row.preview_url,
    modes: row.modes,
  };
}

function toService(row: ServiceRow): Service {
  return {
    key: row.key,
    name: row.name,
    priceCentavos: row.price_centavos,
    currency: row.currency,
  };
}

function toRequest(row: CustomThemeRequestRow): CustomThemeRequest {
  return {
    id: row.id,
    eventId: row.event_id,
    serviceKey: row.service_key,
    priceCentavos: row.price_centavos,
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
  };
}
