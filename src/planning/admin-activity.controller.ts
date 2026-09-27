import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Roles } from '../auth/roles.decorator.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';

type Row = Record<string, unknown>;

/** Per-event activity across guests, RSVPs, gifts, planning and inquiries, for the admin dashboard. */
@Roles('admin')
@Controller('api/admin/activity')
export class AdminActivityController {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  @Get()
  async activity() {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    const db = this.supabase as unknown as SupabaseClient;

    // Tables whose migration isn't applied yet simply count as zero.
    const load = async (table: string, columns: string) => {
      const { data, error } = await db.from(table).select(columns).limit(20000);
      return error ? { rows: [] as Row[], missing: true } : { rows: (data as unknown as Row[]) ?? [], missing: false };
    };

    const [events, households, guests, rsvps, registry, gifts, tasks, quotes, views] = await Promise.all([
      load('events', 'id, name, mode, state, slug, created_at'),
      load('households', 'event_id, rsvp_submitted_at'),
      load('guests', 'event_id'),
      load('rsvps', 'event_id, status'),
      load('registry_items', 'event_id'),
      load('gifts', 'event_id, amount_cents, source'),
      load('planning_tasks', 'event_id, done_at'),
      load('quotes', 'event_id, status'),
      load('site_views', 'event_id, views'),
    ]);

    const tally = (rows: Row[], pick: (r: Row) => number = () => 1) => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(String(r.event_id), (m.get(String(r.event_id)) ?? 0) + pick(r));
      return m;
    };
    const t = {
      households: tally(households.rows),
      responded: tally(households.rows, (r) => (r.rsvp_submitted_at ? 1 : 0)),
      guests: tally(guests.rows),
      attending: tally(rsvps.rows, (r) => (r.status === 'attending' ? 1 : 0)),
      registry: tally(registry.rows),
      gifts: tally(gifts.rows),
      tasks: tally(tasks.rows),
      tasksDone: tally(tasks.rows, (r) => (r.done_at ? 1 : 0)),
      quotes: tally(quotes.rows),
      views: tally(views.rows, (r) => Number(r.views ?? 0)),
    };

    const list = events.rows
      .map((e) => {
        const id = String(e.id);
        const get = (m: Map<string, number>) => m.get(id) ?? 0;
        return {
          id,
          name: String(e.name ?? ''),
          mode: String(e.mode ?? ''),
          state: String(e.state ?? ''),
          slug: (e.slug as string | null) ?? null,
          households: get(t.households),
          responded: get(t.responded),
          guests: get(t.guests),
          attending: get(t.attending),
          registryItems: get(t.registry),
          gifts: get(t.gifts),
          tasks: get(t.tasks),
          tasksDone: get(t.tasksDone),
          quotes: get(t.quotes),
          views: get(t.views),
        };
      })
      .sort((a, b) => b.views + b.guests - (a.views + a.guests));

    const sum = (key: keyof (typeof list)[number]) => list.reduce((n, e) => n + (Number(e[key]) || 0), 0);
    return {
      totals: {
        events: list.length,
        live: list.filter((e) => e.state === 'live').length,
        households: sum('households'),
        guests: sum('guests'),
        attending: sum('attending'),
        registryItems: sum('registryItems'),
        gifts: sum('gifts'),
        tasks: sum('tasks'),
        quotes: sum('quotes'),
        views: sum('views'),
      },
      missing: Object.entries({ households, rsvps, registry, gifts, tasks, quotes, views })
        .filter(([, v]) => v.missing)
        .map(([k]) => k),
      events: list.slice(0, 300),
    };
  }
}
