import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bump this if the envelope shape or algorithm ever changes. */
export const ENVELOPE_VERSION = 'v1';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** How far a payload's timestamp may drift before it is refused. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type EncryptionMode = 'off' | 'optional' | 'required';

/** What the wire carries instead of the real body. */
export interface Envelope {
  enc: typeof ENVELOPE_VERSION;
  /** Unix milliseconds. Authenticated, so it cannot be edited in flight. */
  ts: number;
  iv: string;
  data: string;
  tag: string;
}

/**
 * Binds a payload to the exact call it was made for. Included as AES-GCM
 * additional data, so a captured envelope cannot be replayed against a
 * different route or verb — it will fail authentication rather than decrypt.
 */
export interface PayloadContext {
  method: string;
  path: string;
}

export const isEnvelope = (value: unknown): value is Envelope =>
  Boolean(
    value &&
      typeof value === 'object' &&
      (value as Envelope).enc === ENVELOPE_VERSION &&
      typeof (value as Envelope).iv === 'string' &&
      typeof (value as Envelope).data === 'string' &&
      typeof (value as Envelope).tag === 'string' &&
      typeof (value as Envelope).ts === 'number',
  );

/**
 * Encrypts and decrypts API payloads with a pre-shared symmetric key.
 *
 * This sits *on top of* TLS — it is not a replacement for HTTPS. It is worth
 * having for server-to-server clients, where the key really is a secret: the
 * body stays unreadable in logs, proxies and error trackers, and an envelope
 * cannot be replayed at another endpoint. It buys nothing against a hostile
 * browser user, because anything the browser can decrypt, its owner can too.
 */
@Injectable()
export class PayloadCryptoService {
  private readonly logger = new Logger(PayloadCryptoService.name);
  private readonly key: Buffer | null;
  readonly mode: EncryptionMode;

  constructor() {
    this.key = readKey(this.logger);
    this.mode = readMode(this.key, this.logger);
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  encrypt(body: unknown, context: PayloadContext): Envelope {
    const key = this.requireKey();
    const ts = Date.now();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    cipher.setAAD(aad(context, ts));

    const data = Buffer.concat([
      cipher.update(JSON.stringify(body ?? null), 'utf8'),
      cipher.final(),
    ]);

    return {
      enc: ENVELOPE_VERSION,
      ts,
      iv: iv.toString('base64'),
      data: data.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(envelope: Envelope, context: PayloadContext): unknown {
    const key = this.requireKey();

    if (Math.abs(Date.now() - envelope.ts) > MAX_CLOCK_SKEW_MS) {
      throw new BadRequestException('Encrypted payload has expired');
    }

    const iv = decodeExact(envelope.iv, IV_BYTES, 'iv');
    const tag = decodeExact(envelope.tag, TAG_BYTES, 'tag');
    const decipher = createDecipheriv(ALGORITHM, key, iv);

    decipher.setAAD(aad(context, envelope.ts));
    decipher.setAuthTag(tag);

    let plaintext: string;

    try {
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // A failed tag check means the wrong key, a tampered body, or an
      // envelope captured from a different route. Never say which.
      throw new BadRequestException('Encrypted payload could not be verified');
    }

    try {
      return JSON.parse(plaintext);
    } catch {
      throw new BadRequestException('Encrypted payload was not valid JSON');
    }
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new BadRequestException('Payload encryption is not configured');
    }

    return this.key;
  }
}

function aad({ method, path }: PayloadContext, ts: number): Buffer {
  return Buffer.from(`${ENVELOPE_VERSION}|${method.toUpperCase()} ${path}|${ts}`, 'utf8');
}

function decodeExact(value: string, bytes: number, field: string): Buffer {
  const decoded = Buffer.from(value, 'base64');

  if (decoded.length !== bytes) {
    throw new BadRequestException(`Encrypted payload has a malformed ${field}`);
  }

  return decoded;
}

/** Accepts the key as 64 hex characters or 44 characters of base64. */
function readKey(logger: Logger): Buffer | null {
  const raw = process.env.API_ENCRYPTION_KEY?.trim();

  if (!raw) {
    return null;
  }

  const decoded = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');

  if (decoded.length !== KEY_BYTES) {
    logger.error(
      `API_ENCRYPTION_KEY must be ${KEY_BYTES} bytes (64 hex or 44 base64 characters) — got ${decoded.length}. Encryption is disabled.`,
    );

    return null;
  }

  // Guard against the placeholder from .env.example reaching an environment.
  const placeholder = Buffer.alloc(KEY_BYTES);

  if (decoded.length === placeholder.length && timingSafeEqual(decoded, placeholder)) {
    logger.error('API_ENCRYPTION_KEY is all zero bytes — encryption is disabled.');

    return null;
  }

  return decoded;
}

function readMode(key: Buffer | null, logger: Logger): EncryptionMode {
  const requested = (process.env.API_ENCRYPTION_MODE?.trim() ||
    'optional') as EncryptionMode;

  if (!['off', 'optional', 'required'].includes(requested)) {
    logger.error(`API_ENCRYPTION_MODE "${requested}" is not valid — falling back to "optional".`);

    return key ? 'optional' : 'off';
  }

  if (requested !== 'off' && !key) {
    logger.warn(
      `API_ENCRYPTION_MODE is "${requested}" but API_ENCRYPTION_KEY is not set — payloads will be sent in the clear. See .env.example.`,
    );

    return 'off';
  }

  return requested;
}
