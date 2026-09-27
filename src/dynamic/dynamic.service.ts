import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { RESOURCE_BY_NAME } from './resources.registry.js';
import type { FieldSpec, Operation, ResourceDefinition } from './resource.types.js';
import type { AppRole } from '../auth/roles.decorator.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** ilike wildcards and PostgREST's own filter separators. */
const WILDCARDS = /[%_,()*\\]/g;

export interface Caller {
  userId: string;
  role: AppRole | null;
  /**
   * Ids of the events this caller owns, resolved once per request.
   *
   * It lives on the caller rather than on the service because the service is a
   * singleton: per-request state stored on it would leak between concurrent
   * requests and could scope one user's query to another user's events.
   */
  eventIds: readonly string[];
}

/** The PostgREST result shape, narrowed to what this layer reads. */
interface DynamicResult {
  data: Record<string, unknown>[] | Record<string, unknown> | null;
  error: { code?: string; message: string } | null;
  count?: number | null;
}

/**
 * The query-builder surface the dynamic layer uses.
 *
 * The generated Database type is a closed union of two tables, which is right
 * for the hand-written services but cannot describe a table name that arrives
 * as data. So this layer addresses Supabase through a structural interface
 * instead: the registry, not the compiler, is what guarantees the table exists
 * and the columns are real.
 */
interface DynamicBuilder extends PromiseLike<DynamicResult> {
  select(columns: string, options?: { count: 'exact' }): DynamicBuilder;
  insert(row: Record<string, unknown>): DynamicBuilder;
  update(patch: Record<string, unknown>): DynamicBuilder;
  delete(): DynamicBuilder;
  eq(column: string, value: unknown): DynamicBuilder;
  in(column: string, values: unknown[]): DynamicBuilder;
  ilike(column: string, pattern: string): DynamicBuilder;
  order(column: string, options: { ascending: boolean }): DynamicBuilder;
  range(from: number, to: number): DynamicBuilder;
  maybeSingle(): DynamicBuilder;
  single(): DynamicBuilder;
}

interface DynamicClient {
  from(table: string): DynamicBuilder;
}

export interface Page {
  resource: string;
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * One implementation behind every resource route.
 *
 * Everything specific to a table — its columns, validation, which operations
 * exist and how it is scoped to the caller — comes from the registry, so a new
 * table is a definition rather than a controller, a service and a DTO.
 */
@Injectable()
export class DynamicService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  definition(name: string, operation: Operation, caller: Caller): ResourceDefinition {
    const resource = RESOURCE_BY_NAME.get(name);

    if (!resource) {
      throw new NotFoundException(`Unknown resource "${name}"`);
    }

    const allowed = resource.operations ?? ['list', 'read', 'create', 'update', 'delete'];

    if (!allowed.includes(operation)) {
      throw new ForbiddenException(
        `${operation} is not available on ${name}. Allowed: ${allowed.join(', ')}.`,
      );
    }

    // An admin-scoped resource has no per-user filter, so only an admin may see
    // it at all — otherwise the scope would silently be "everything".
    const needsAdmin = resource.roles?.includes('admin') || resource.scope.by === 'admin';

    if (needsAdmin && caller.role !== 'admin') {
      throw new ForbiddenException('Not allowed');
    }

    return resource;
  }

  async list(name: string, query: Record<string, unknown>, caller: Caller): Promise<Page> {
    const resource = this.definition(name, 'list', caller);
    const limit = this.int(query['limit'], DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
    const offset = this.int(query['offset'], 0, 0, Number.MAX_SAFE_INTEGER, 'offset');

    let builder = this.db.from(resource.table).select(this.columns(resource), { count: 'exact' });
    builder = this.scoped(builder, resource, caller);

    for (const [field, spec] of Object.entries(resource.fields)) {
      const value = query[field];

      if (!spec.filterable || value === undefined || value === '') {
        continue;
      }

      builder = builder.eq(field, this.coerce(field, spec, value));
    }

    // `search` runs against the first free-text column the resource declares.
    const searchable = Object.entries(resource.fields).find(
      ([, spec]) => spec.type === 'text' && !spec.readOnly,
    );
    const search = typeof query['search'] === 'string' ? query['search'] : '';

    if (search && searchable) {
      const safe = search.replace(WILDCARDS, ' ').trim().slice(0, 80);

      if (safe) {
        builder = builder.ilike(searchable[0], `%${safe}%`);
      }
    }

    const sort = resource.defaultSort ?? { column: 'created_at', ascending: false };
    const { data, error, count } = await builder
      .order(sort.column, { ascending: sort.ascending })
      .range(offset, offset + limit - 1);

    if (error) {
      throw this.translate(error, resource);
    }

    return {
      resource: name,
      rows: (data ?? []) as Record<string, unknown>[],
      total: count ?? (Array.isArray(data) ? data.length : 0),
      limit,
      offset,
    };
  }

  async read(name: string, id: string, caller: Caller): Promise<Record<string, unknown>> {
    const resource = this.definition(name, 'read', caller);
    let builder = this.db.from(resource.table).select(this.columns(resource)).eq('id', id);
    builder = this.scoped(builder, resource, caller);

    const { data, error } = await builder.maybeSingle();

    if (error) {
      throw this.translate(error, resource);
    }

    if (!data) {
      throw new NotFoundException(`No ${name} with id ${id}`);
    }

    return data as Record<string, unknown>;
  }

  async create(
    name: string,
    body: Record<string, unknown>,
    caller: Caller,
  ): Promise<Record<string, unknown>> {
    const resource = this.definition(name, 'create', caller);
    const row = this.validate(resource, body, true);

    if (resource.scope.by === 'owner') {
      // The owner is taken from the session, never from the payload.
      row[resource.scope.column] = caller.userId;
    }

    if (resource.scope.by === 'event') {
      this.assertOwnsEvent(row[resource.scope.column], caller);
    }

    const { data, error } = await this.db
      .from(resource.table)
      .insert(row)
      .select(this.columns(resource))
      .single();

    if (error) {
      throw this.translate(error, resource);
    }

    return data as Record<string, unknown>;
  }

  async update(
    name: string,
    id: string,
    body: Record<string, unknown>,
    caller: Caller,
  ): Promise<Record<string, unknown>> {
    const resource = this.definition(name, 'update', caller);
    const patch = this.validate(resource, body, false);

    // The scope column (event_id / owner_id) decides who owns the row. Letting
    // it change on update would move the row into someone else's event or
    // account, so it is never writable here — create takes it from the body
    // (event) or the session (owner); update must not touch it.
    if (resource.scope.by !== 'admin' && resource.scope.column in patch) {
      delete patch[resource.scope.column];
    }

    if (!Object.keys(patch).length) {
      throw new BadRequestException('No writable fields in the request body');
    }

    // Proves the row is in scope before touching it.
    await this.read(name, id, caller);

    let builder = this.db.from(resource.table).update(patch).eq('id', id);
    builder = this.scoped(builder, resource, caller);

    const { data, error } = await builder.select(this.columns(resource)).maybeSingle();

    if (error) {
      throw this.translate(error, resource);
    }

    if (!data) {
      throw new NotFoundException(`No ${name} with id ${id}`);
    }

    return data as Record<string, unknown>;
  }

  async remove(name: string, id: string, caller: Caller): Promise<void> {
    const resource = this.definition(name, 'delete', caller);
    let builder = this.db.from(resource.table).delete().eq('id', id);
    builder = this.scoped(builder, resource, caller);

    const { data, error } = await builder.select('id');

    if (error) {
      throw this.translate(error, resource);
    }

    if (!Array.isArray(data) || data.length === 0) {
      throw new NotFoundException(`No ${name} with id ${id}`);
    }
  }

  // ------------------------------------------------------------------ internals

  /**
   * Narrows a query to what the caller may see. An admin sees everything; a
   * user sees rows they own, or rows belonging to an event they own.
   */
  private scoped(
    builder: DynamicBuilder,
    resource: ResourceDefinition,
    caller: Caller,
  ): DynamicBuilder {
    if (caller.role === 'admin' || resource.scope.by === 'admin') {
      return builder;
    }

    const filterable = builder;

    if (resource.scope.by === 'owner') {
      return filterable.eq(resource.scope.column, caller.userId);
    }

    // Event-scoped: restrict to the events this caller owns. PostgREST has no
    // sub-select, so the ids are resolved once per request by resolveCaller.
    // An empty list matches nothing, which is right for a user with no events.
    return filterable.in(resource.scope.column, [...caller.eventIds]);
  }

  /**
   * Builds the caller once per request, including the event ids their scope
   * covers. Admins get an empty list because they are never filtered by it.
   */
  async resolveCaller(userId: string, role: AppRole | null): Promise<Caller> {
    if (role === 'admin') {
      return { userId, role, eventIds: [] };
    }

    const { data, error } = await this.db.from('events').select('id').eq('owner_id', userId);

    if (error) {
      throw new InternalServerErrorException(`Could not resolve scope: ${error.message}`);
    }

    const rows = Array.isArray(data) ? (data as { id: string }[]) : [];

    return { userId, role, eventIds: rows.map((row) => row.id) };
  }

  private assertOwnsEvent(eventId: unknown, caller: Caller): void {
    if (caller.role === 'admin') {
      return;
    }

    if (typeof eventId !== 'string' || !caller.eventIds.includes(eventId)) {
      throw new ForbiddenException('That event does not belong to you');
    }
  }

  private columns(resource: ResourceDefinition): string {
    const hidden = new Set(resource.hidden ?? []);
    const names = ['id', ...Object.keys(resource.fields), 'created_at'].filter(
      (column) => !hidden.has(column),
    );

    return [...new Set(names)].join(',');
  }

  private validate(
    resource: ResourceDefinition,
    body: Record<string, unknown>,
    isCreate: boolean,
  ): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('Body must be an object');
    }

    const unknown = Object.keys(body).filter((key) => !(key in resource.fields));

    if (unknown.length) {
      throw new BadRequestException(`Unknown field(s): ${unknown.join(', ')}`);
    }

    const row: Record<string, unknown> = {};

    for (const [field, spec] of Object.entries(resource.fields)) {
      const value = body[field];

      if (value === undefined) {
        if (isCreate && spec.required && !spec.readOnly) {
          throw new BadRequestException(`${field} is required`);
        }

        continue;
      }

      if (spec.readOnly) {
        throw new BadRequestException(`${field} is read-only`);
      }

      row[field] = this.coerce(field, spec, value);
    }

    return row;
  }

  private coerce(field: string, spec: FieldSpec, value: unknown): unknown {
    if (value === null) {
      if (spec.required) {
        throw new BadRequestException(`${field} cannot be null`);
      }

      return null;
    }

    switch (spec.type) {
      case 'text':
      case 'uuid': {
        if (typeof value !== 'string') {
          throw new BadRequestException(`${field} must be a string`);
        }

        const text = value.trim();

        if (spec.max && text.length > spec.max) {
          throw new BadRequestException(`${field} must be at most ${spec.max} characters`);
        }

        if (spec.type === 'uuid' && text && !isUuidLike(text)) {
          throw new BadRequestException(`${field} must be an id`);
        }

        return text;
      }

      case 'url': {
        if (typeof value !== 'string') {
          throw new BadRequestException(`${field} must be a string`);
        }

        const raw = value.trim();
        if (!raw) return '';
        if (spec.max && raw.length > spec.max) {
          throw new BadRequestException(`${field} must be at most ${spec.max} characters`);
        }

        let parsed: URL;
        try {
          parsed = new URL(raw);
        } catch {
          throw new BadRequestException(`${field} must be a full https:// address`);
        }
        if (parsed.protocol !== 'https:') {
          throw new BadRequestException(`${field} must use https`);
        }

        return parsed.toString();
      }

      case 'enum': {
        if (typeof value !== 'string' || !spec.values?.includes(value)) {
          throw new BadRequestException(
            `${field} must be one of: ${(spec.values ?? []).join(', ')}`,
          );
        }

        return value;
      }

      case 'int':
      case 'money': {
        const parsed = Number(value);

        if (!Number.isInteger(parsed)) {
          throw new BadRequestException(
            spec.type === 'money'
              ? `${field} must be a whole number of centavos`
              : `${field} must be a whole number`,
          );
        }

        if (parsed < (spec.min ?? Number.MIN_SAFE_INTEGER)) {
          throw new BadRequestException(`${field} must be at least ${spec.min}`);
        }

        if (spec.max !== undefined && parsed > spec.max) {
          throw new BadRequestException(`${field} must be at most ${spec.max}`);
        }

        return parsed;
      }

      case 'bool': {
        if (typeof value === 'boolean') return value;
        if (value === 'true') return true;
        if (value === 'false') return false;

        throw new BadRequestException(`${field} must be true or false`);
      }

      case 'date': {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
          throw new BadRequestException(`${field} must be a valid YYYY-MM-DD date`);
        }

        return value;
      }

      case 'timestamp': {
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
          throw new BadRequestException(`${field} must be an ISO timestamp`);
        }

        return new Date(value).toISOString();
      }

      case 'text[]': {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
          throw new BadRequestException(`${field} must be an array of strings`);
        }

        return value.map((entry) => (entry as string).trim()).filter(Boolean);
      }

      case 'json': {
        if (typeof value !== 'object' || Array.isArray(value)) {
          throw new BadRequestException(`${field} must be an object`);
        }

        return value;
      }

      default:
        throw new BadRequestException(`${field} has an unsupported type`);
    }
  }

  private int(value: unknown, fallback: number, min: number, max: number, field: string): number {
    if (value === undefined || value === '') {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException(`${field} must be a whole number between ${min} and ${max}`);
    }

    return parsed;
  }

  /** Turns a Postgres complaint into something a client can act on. */
  private translate(
    error: { code?: string; message: string },
    resource: ResourceDefinition,
  ): Error {
    if (error.code === '23505') {
      return new BadRequestException(`That ${resource.name} already exists`);
    }

    if (error.code === '23503') {
      return new BadRequestException('A referenced record does not exist');
    }

    if (error.code === '23514') {
      return new BadRequestException('A value is outside what this record allows');
    }

    if (error.code === 'PGRST205' || /schema cache/i.test(error.message)) {
      return new ServiceUnavailableException(
        `The ${resource.table} table does not exist yet — run the migrations in supabase/migrations.`,
      );
    }

    return new InternalServerErrorException(error.message);
  }

  private get db(): DynamicClient {
    if (!this.supabase) {
      throw new ServiceUnavailableException('The database is not configured');
    }

    return this.supabase as unknown as DynamicClient;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** events.id is a six-character share code, not a uuid. */
const EVENT_CODE = /^[A-HJ-NP-Z2-9]{6}$/i;

const isUuidLike = (value: string): boolean => UUID.test(value) || EVENT_CODE.test(value);
