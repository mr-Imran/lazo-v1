/**
 * The common retailer contract (PRD INT-1): every store adapter exposes the
 * same three operations and returns the same normalised product shape. What
 * an adapter cannot do is declared in the `retailers.supports` row, never
 * faked here.
 */
export interface RetailerProduct {
  retailer: string;
  externalId: string;
  title: string;
  imageUrl: string;
  priceCentavos: number | null;
  currency: string;
  /** null = the store did not say. */
  available: boolean | null;
  /** Affiliate-tagged product page. */
  url: string;
  /** Text the store requires next to its data (Amazon: "Precio y disponibilidad…"). */
  attribution: string;
}

export interface SearchOptions {
  limit?: number;
}

export interface RetailerAdapter {
  readonly key: string;
  /** Env var names this adapter reads. */
  readonly envNames: readonly string[];
  /** All env vars present. */
  configured(): boolean;
  /** Which env vars are missing (for the "not configured" message). */
  missingEnv(): string[];
  search(query: string, opts?: SearchOptions): Promise<RetailerProduct[]>;
  getItems(ids: string[]): Promise<RetailerProduct[]>;
  /** Current price + stock only; the same shape so callers can update rows. */
  availability(ids: string[]): Promise<RetailerProduct[]>;
}

export const FETCH_TIMEOUT_MS = 12_000;

export function toCentavos(amount: unknown): number | null {
  const n = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}
