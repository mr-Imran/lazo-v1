import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import type { ApiKeyRow } from '../supabase/database.types.js';
import type { ApiKeyRecord, CreateApiKeyInput, CreatedApiKey } from './api-key.entity.js';

/** Identifies a Lazo key at a glance, in logs and in leaked-secret scanners. */
const KEY_SCHEME = 'lazo_sk_';
const SECRET_BYTES = 32;
/** Characters of the secret kept in the clear, as the lookup handle. */
const PREFIX_CHARS = 8;
const MAX_NAME = 80;

/** Don't write to the database on every single request. */
const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  async findAllFor(ownerId: string): Promise<ApiKeyRecord[]> {
    const { data, error } = await this.db
      .from('api_keys')
      .select('*')
      .eq('owner_id', ownerId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new InternalServerErrorException(`Could not load API keys: ${error.message}`);
    }

    return data.map(toRecord);
  }

  /**
   * Mints a key. The full secret exists only in this return value — the row
   * holds a hash, so it can never be shown again.
   */
  async create(ownerId: string, input: CreateApiKeyInput): Promise<CreatedApiKey> {
    const name = this.parseName(input.name);
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const key = `${KEY_SCHEME}${secret}`;

    const { data, error } = await this.db
      .from('api_keys')
      .insert({
        owner_id: ownerId,
        name,
        prefix: `${KEY_SCHEME}${secret.slice(0, PREFIX_CHARS)}`,
        hash: hash(key),
      })
      .select('*')
      .single();

    if (error) {
      throw new InternalServerErrorException(`Could not create API key: ${error.message}`);
    }

    return { ...toRecord(data), key };
  }

  /** Revoking is permanent and keeps the row, so the audit trail survives. */
  async revoke(ownerId: string, id: string): Promise<ApiKeyRecord> {
    const { data, error } = await this.db
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', id)
      .eq('owner_id', ownerId)
      .is('revoked_at', null)
      .select('*')
      .maybeSingle();

    if (error) {
      throw new InternalServerErrorException(`Could not revoke API key: ${error.message}`);
    }

    if (!data) {
      // Covers missing, someone else's, and already revoked alike.
      throw new NotFoundException('No active API key with that id');
    }

    return toRecord(data);
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const { data, error } = await this.db
      .from('api_keys')
      .delete()
      .eq('id', id)
      .eq('owner_id', ownerId)
      .select('id');

    if (error) {
      throw new InternalServerErrorException(`Could not delete API key: ${error.message}`);
    }

    if (data.length === 0) {
      throw new NotFoundException('No API key with that id');
    }
  }

  /**
   * Resolves a presented key to its owner, or null if it is unknown, malformed
   * or revoked. Called on every API-key request, so it is one indexed lookup.
   */
  async resolveOwner(presented: string): Promise<string | null> {
    if (!this.supabase || !presented.startsWith(KEY_SCHEME)) {
      return null;
    }

    const secret = presented.slice(KEY_SCHEME.length);

    if (secret.length < PREFIX_CHARS) {
      return null;
    }

    const { data, error } = await this.db
      .from('api_keys')
      .select('*')
      .eq('prefix', `${KEY_SCHEME}${secret.slice(0, PREFIX_CHARS)}`)
      .maybeSingle();

    if (error) {
      this.logger.error(`Could not look up an API key: ${error.message}`);

      return null;
    }

    // Compare even when there is no row, so a bad prefix and a bad secret take
    // the same time to reject.
    const expected = data?.hash ?? hash('');

    if (!matches(expected, hash(presented)) || !data || data.revoked_at) {
      return null;
    }

    await this.touch(data);

    return data.owner_id;
  }

  private async touch(row: ApiKeyRow): Promise<void> {
    const last = row.last_used_at ? Date.parse(row.last_used_at) : 0;

    if (Date.now() - last < LAST_USED_THROTTLE_MS) {
      return;
    }

    const { error } = await this.db
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', row.id);

    if (error) {
      // Never fail a request because the usage stamp could not be written.
      this.logger.warn(`Could not stamp API key ${row.prefix}: ${error.message}`);
    }
  }

  private get db(): LazoSupabaseClient {
    if (!this.supabase) {
      throw new ServiceUnavailableException('The database is not configured');
    }

    return this.supabase;
  }

  private parseName(value: unknown): string {
    if (typeof value !== 'string' && value !== undefined && value !== null) {
      throw new BadRequestException('name must be a string');
    }

    const name = (value ?? '').toString().trim();

    if (!name) {
      throw new BadRequestException('name is required');
    }

    if (name.length > MAX_NAME) {
      throw new BadRequestException(`name must be at most ${MAX_NAME} characters`);
    }

    return name;
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time comparison, so a wrong key leaks nothing through timing. */
function matches(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  return left.length === right.length && timingSafeEqual(left, right);
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revoked: Boolean(row.revoked_at),
  };
}
