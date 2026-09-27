import {
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import type { EventModeRow } from '../supabase/database.types.js';
import { familySections } from './event-details.js';
import type { FamilySection } from './event-details.js';
import { privacyDefaults, sections, vocabulary, giftConfig, type GiftConfig } from './mode-config.js';
import type { PrivacyDefaults, SectionKey, Vocabulary } from './mode-config.js';
import { SubEventsService } from './sub-events.service.js';

/** PostgREST: the relation is not in its schema cache (migration not applied). */
const UNDEFINED_TABLE = 'PGRST205';

@Controller('api/event-types')
export class EventTypesController {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
    private readonly subEvents: SubEventsService,
  ) {}

  /**
   * The occasion picker is the first step of the create flow, before sign-in,
   * so this is public and never encrypted. Served from the event_modes table —
   * the same table events.mode references — so the two cannot disagree.
   * Only active rows, in `position` order, which is display order.
   */
  @Public()
  @PlainPayload()
  @Get()
  async list(): Promise<{
    types: {
      value: string;
      label: string;
      fields: EventModeRow['fields'];
      nameTemplate: string | null;
      slugTemplate: string | null;
      description: string;
      imageUrl: string;
      familyTitle: string;
      familySections: FamilySection[];
      subEventKinds: { value: string; label: string }[];
      /** From 20261012000000_modes_mercadopago.sql; defaults until it is applied. */
      vocabulary: Vocabulary;
      privacyDefaults: PrivacyDefaults;
      sections: SectionKey[];
      /** From 20261016000000_mode_gifts.sql; empty strings until it is applied. */
      gifts: GiftConfig;
    }[];
  }> {
    if (!this.supabase) {
      throw new ServiceUnavailableException('The database is not configured');
    }

    const { data, error } = await this.supabase
      .from('event_modes')
      .select('*')
      .eq('active', true)
      .order('position', { ascending: true })
      .order('value', { ascending: true });

    if (error?.code === UNDEFINED_TABLE) {
      throw new ServiceUnavailableException(
        'The event_modes table does not exist yet. Apply supabase/migrations/20260924200000_event_modes.sql.',
      );
    }

    // Postgres undefined_column: the details migration hasn't been applied.
    if (error?.code === '42703') {
      throw new ServiceUnavailableException(
        'The occasion details columns are missing. Apply supabase/migrations/20260925100000_event_details.sql.',
      );
    }

    if (error) {
      throw new InternalServerErrorException(`Could not load event types: ${error.message}`);
    }

    // Empty until 20260929000000_event_info.sql is applied.
    const kinds = await this.subEvents.allKinds();

    return {
      types: data.map((row) => ({
        value: row.value,
        label: row.label,
        fields: Array.isArray(row.fields) ? row.fields : [],
        nameTemplate: row.name_template,
        slugTemplate: row.slug_template ?? null,
        // From 20260928000000_homepage.sql; empty until it is applied.
        description: row.description ?? '',
        imageUrl: row.image_url ?? '',
        familyTitle: (row as { family_title?: string }).family_title ?? '',
        familySections: familySections((row as { family_sections?: unknown }).family_sections),
        subEventKinds: kinds
          .filter((k) => k.modes.length === 0 || k.modes.includes(row.value))
          .map(({ value, label }) => ({ value, label })),
        vocabulary: vocabulary((row as { vocabulary?: unknown }).vocabulary),
        privacyDefaults: privacyDefaults((row as { privacy_defaults?: unknown }).privacy_defaults),
        sections: sections((row as { sections?: unknown }).sections),
        gifts: giftConfig((row as { gifts?: unknown }).gifts),
      })),
    };
  }
}
