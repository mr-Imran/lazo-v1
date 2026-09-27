import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { MODES_MIGRATION } from '../events/mode-config.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { normalize } from './site-content.service.js';

const UNDEFINED_TABLE = 'PGRST205';
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_PER_EVENT = 2000;

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export interface Condolence {
  id: string;
  name: string;
  message: string;
  approved: boolean;
  createdAt: string;
}

/**
 * Remembrance messages on a memorial site (EVT-4). Guests post from the site;
 * nothing shows until the host approves it. Table: condolences
 * (20261012000000_modes_mercadopago.sql).
 */
@Injectable()
export class CondolencesService {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  /** Host view: every message, pending first. */
  async overview(eventId: string) {
    const { data, error } = await this.db
      .from('condolences')
      .select('*')
      .eq('event_id', eventId)
      .order('approved', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(MAX_PER_EVENT);
    if (error) throw this.fail('Could not load messages', error);
    const list = (data as Row[]).map(toCondolence);
    return { condolences: list, pending: list.filter((c) => !c.approved).length };
  }

  /** Approved messages, oldest first, for the public site. */
  async publicList(eventId: string): Promise<Condolence[]> {
    const { data, error } = await this.db
      .from('condolences')
      .select('*')
      .eq('event_id', eventId)
      .eq('approved', true)
      .order('created_at', { ascending: true })
      .limit(300);
    if (error) throw this.fail('Could not load messages', error);
    return (data as Row[]).map(toCondolence);
  }

  /** A guest's { name?, message }. Only when the host switched condolences on. */
  async submit(eventId: string, input: Row) {
    const { data: ev, error: evError } = await this.db.from('events').select('site_content').eq('id', eventId).single();
    if (evError) throw this.fail('Could not load the site', evError);
    if (!normalize((ev as Row).site_content).condolences.enabled) {
      throw new ForbiddenException('The family is not receiving messages on this site.');
    }

    const message = s(input.message).trim();
    if (message.length < 1 || message.length > 2000) throw new BadRequestException('Write a message of up to 2000 characters');
    const name = s(input.name).trim().slice(0, 120);

    const { count, error: countError } = await this.db
      .from('condolences')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', eventId);
    if (countError) throw this.fail('Could not count messages', countError);
    if ((count ?? 0) >= MAX_PER_EVENT) throw new BadRequestException('This site is not accepting more messages');

    const { error } = await this.db.from('condolences').insert({ event_id: eventId, name, message, approved: false });
    if (error) throw this.fail('Could not save your message', error);
    return { ok: true, pending: true };
  }

  /** { approved: boolean } */
  async moderate(eventId: string, id: string, input: Row) {
    if (!UUID.test(id)) throw new NotFoundException('No such message');
    if (typeof input.approved !== 'boolean') throw new BadRequestException('approved must be true or false');
    const { data, error } = await this.db
      .from('condolences')
      .update({ approved: input.approved })
      .eq('id', id)
      .eq('event_id', eventId)
      .select('id');
    if (error) throw this.fail('Could not update the message', error);
    if (!data?.length) throw new NotFoundException('No such message');
    return this.overview(eventId);
  }

  async remove(eventId: string, id: string) {
    if (!UUID.test(id)) throw new NotFoundException('No such message');
    const { data, error } = await this.db.from('condolences').delete().eq('id', id).eq('event_id', eventId).select('id');
    if (error) throw this.fail('Could not delete the message', error);
    if (!data?.length) throw new NotFoundException('No such message');
    return this.overview(eventId);
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE) {
      return new ServiceUnavailableException(`The condolences table does not exist yet. Apply ${MODES_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

function toCondolence(r: Row): Condolence {
  return { id: s(r.id), name: s(r.name), message: s(r.message), approved: r.approved === true, createdAt: s(r.created_at) };
}
