import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';

const DB_TIMEOUT_MS = 3000;

/**
 * For uptime checks and the process manager: 200 when the server and the
 * database answer, 503 when the database doesn't. Says nothing about data.
 */
@Controller('api/health')
export class HealthController {
  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  @Public()
  @PlainPayload()
  @Get()
  async health(@Res() res: Response): Promise<void> {
    const db = await this.database();
    res.status(db === 'ok' ? 200 : 503).json({
      status: db === 'ok' ? 'ok' : 'degraded',
      database: db,
      uptimeSeconds: Math.round(process.uptime()),
    });
  }

  private async database(): Promise<'ok' | 'down' | 'not configured'> {
    if (!this.supabase) return 'not configured';
    try {
      const query = this.supabase.from('event_modes').select('value', { head: true, count: 'exact' });
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_TIMEOUT_MS));
      const { error } = await Promise.race([query, timeout]);
      return error ? 'down' : 'ok';
    } catch {
      return 'down';
    }
  }
}
