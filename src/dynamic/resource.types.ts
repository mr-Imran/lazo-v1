import type { AppRole } from '../auth/roles.decorator.js';

export type FieldType =
  | 'text'
  | 'int'
  | 'money'
  | 'bool'
  | 'date'
  | 'timestamp'
  | 'uuid'
  | 'enum'
  | 'json'
  | 'text[]'
  /** An https:// URL, or "" to clear. Anything else (javascript:, data:…) is rejected. */
  | 'url';

export interface FieldSpec {
  type: FieldType;
  /** Rejected on create when absent. */
  required?: boolean;
  /** Writable only by the server or an admin — e.g. money and lifecycle states. */
  readOnly?: boolean;
  max?: number;
  min?: number;
  /** Allowed values for `enum`, mirroring the column's check constraint. */
  values?: readonly string[];
  /** Exposed as a query-string filter on the list endpoint. */
  filterable?: boolean;
}

/**
 * How a row is tied to the caller.
 *
 *  - `owner`    the table has an owner column holding a Clerk user id.
 *  - `event`    the table has event_id; ownership is the event's owner.
 *  - `admin`    no per-user scope; admin only.
 */
export type Scope =
  | { by: 'owner'; column: string }
  | { by: 'event'; column: string }
  | { by: 'admin' };

export interface ResourceDefinition {
  /** URL segment and Postgres table name. */
  name: string;
  table: string;
  scope: Scope;
  /** Defaults to every verb; narrow it for records the API should not mutate. */
  operations?: ReadonlyArray<'list' | 'read' | 'create' | 'update' | 'delete'>;
  /** Roles that may use it at all. Omit for any signed-in caller. */
  roles?: readonly AppRole[];
  fields: Record<string, FieldSpec>;
  defaultSort?: { column: string; ascending: boolean };
  /** Columns never returned, whatever is asked for. */
  hidden?: readonly string[];
}

export const ALL_OPERATIONS = ['list', 'read', 'create', 'update', 'delete'] as const;

export type Operation = (typeof ALL_OPERATIONS)[number];
