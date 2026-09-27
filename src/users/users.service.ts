import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { clerkClient } from '@clerk/express';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import type { UserInsert, UserRow } from '../supabase/database.types.js';

/** PostgREST: the relation is not in its schema cache (migration not applied). */
const UNDEFINED_TABLE = 'PGRST205';
const MIGRATION = 'supabase/migrations/20260924300000_users.sql';

export interface UserRecord {
  id: string;
  email: string | null;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  clerkCreatedAt: string | null;
  lastSignInAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The subset of Clerk's backend User this mirror reads. */
interface ClerkUser {
  id: string;
  primaryEmailAddressId: string | null;
  emailAddresses: { id: string; emailAddress: string; verification: { status: string } | null }[];
  firstName: string | null;
  lastName: string | null;
  imageUrl: string;
  createdAt: number;
  lastSignInAt: number | null;
}

/**
 * Keeps public.users in step with Clerk.
 *
 * Every write starts from Clerk's Backend API, never from a request body, so
 * the mirror only ever holds what Clerk itself says about a user.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  async syncFromClerk(userId: string): Promise<UserRecord> {
    let user: ClerkUser;

    try {
      user = await clerkClient.users.getUser(userId);
    } catch (error) {
      throw new InternalServerErrorException(
        `Could not read the user from Clerk: ${error instanceof Error ? error.message : error}`,
      );
    }

    const { data, error } = await this.db
      .from('users')
      .upsert({ ...toRow(user), updated_at: new Date().toISOString() }, { onConflict: 'id' })
      .select('*')
      .single();

    if (error) {
      throw this.dbError('Could not save the user', error);
    }

    return toRecord(data);
  }

  async findOne(userId: string): Promise<UserRecord> {
    const { data, error } = await this.db.from('users').select('*').eq('id', userId).maybeSingle();

    if (error) {
      throw this.dbError('Could not load the user', error);
    }

    if (!data) {
      throw new NotFoundException('This user has not been synced yet. Call POST /api/users/me/sync.');
    }

    return toRecord(data);
  }

  /** Admin view of the mirror, newest first, with how many events each owns. */
  async listWithEventCounts(): Promise<(UserRecord & { eventCount: number })[]> {
    const [users, events] = await Promise.all([
      this.db.from('users').select('*').order('created_at', { ascending: false }),
      this.db.from('events').select('owner_id'),
    ]);

    if (users.error) throw this.dbError('Could not load users', users.error);
    if (events.error) throw this.dbError('Could not count events', events.error);

    const counts = new Map<string, number>();
    // Anonymous drafts (owner_id null, 20261008000000_core_gaps.sql) belong to nobody yet.
    for (const { owner_id } of events.data) if (owner_id) counts.set(owner_id, (counts.get(owner_id) ?? 0) + 1);

    return users.data.map((row) => ({ ...toRecord(row), eventCount: counts.get(row.id) ?? 0 }));
  }

  async remove(userId: string): Promise<void> {
    const { error } = await this.db.from('users').delete().eq('id', userId);

    if (error) {
      throw this.dbError('Could not delete the user', error);
    }
  }

  private dbError(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_TABLE) {
      return new ServiceUnavailableException(
        `The users table does not exist yet. Apply ${MIGRATION}.`,
      );
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

function toRow(user: ClerkUser): UserInsert {
  const primary =
    user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId) ??
    user.emailAddresses[0];

  return {
    id: user.id,
    email: primary?.emailAddress ?? null,
    email_verified: primary?.verification?.status === 'verified',
    first_name: user.firstName,
    last_name: user.lastName,
    image_url: user.imageUrl || null,
    clerk_created_at: new Date(user.createdAt).toISOString(),
    last_sign_in_at: user.lastSignInAt ? new Date(user.lastSignInAt).toISOString() : null,
  };
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    firstName: row.first_name,
    lastName: row.last_name,
    imageUrl: row.image_url,
    clerkCreatedAt: row.clerk_created_at,
    lastSignInAt: row.last_sign_in_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
