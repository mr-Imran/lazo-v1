/** What the management page sees. Never includes the secret. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly ownerId: string;
  name: string;
  /** The public half, e.g. `lazo_sk_A1b2C3d4`. Safe to display and log. */
  readonly prefix: string;
  readonly createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  readonly revoked: boolean;
}

/** Returned once, at creation. The secret is never retrievable again. */
export interface CreatedApiKey extends ApiKeyRecord {
  /** The full key. Shown once — the server keeps only its hash. */
  readonly key: string;
}

export interface CreateApiKeyInput {
  name?: unknown;
}
