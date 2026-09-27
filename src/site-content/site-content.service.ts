import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sniffImageType } from '../common/image-type.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export const SITE_CONTENT_MIGRATION = 'supabase/migrations/20261001000000_site_content.sql';
export const EVENT_MEDIA_BUCKET = 'event-media';
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const UNDEFINED_COLUMN = '42703';

type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

export interface SiteContent {
  story: { title: string; body: string; photoUrl: string };
  faq: { q: string; a: string }[];
  stay: { name: string; address: string; url: string; phone: string; note: string }[];
  invitation: { message: string; closing: string };
  gifts: { note: string; bank: { holder: string; bank: string; clabe: string; reference: string } };
  cover: { photoUrl: string };
  /** "Getting there": airport, transport, parking and a note, for out-of-town guests. */
  travel: { airport: string; transport: string; parking: string; note: string };
  // ---- mode-specific sections (20261012000000_modes_mercadopago.sql; event_modes.sections says which show)
  /** Corporate: the programme, in order. */
  agenda: { time: string; title: string; speaker: string; description: string }[];
  /** Corporate: who is presenting. */
  speakers: { name: string; role: string; bio: string; photoUrl: string }[];
  /** Corporate: slides, recordings, downloads. */
  materials: { title: string; url: string; description: string }[];
  /** Memorial: the person being remembered. */
  life: { born: string; died: string; biography: string; obituary: string; photoUrl: string };
  /** Memorial: whether guests may leave messages (moderated), and an intro line. */
  condolences: { enabled: boolean; intro: string };
  /** Memorial: "in lieu of flowers" — an organisation and where to give. */
  donations: { org: string; url: string; note: string };
}

export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

/** The host's words and choices for the public site, publishing, and the site password. */
@Injectable()
export class SiteContentService {
  private bucketReady: Promise<void> | null = null;

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  async get(eventId: string) {
    const row = await this.row(eventId);
    return this.view(row);
  }

  /** Replaces the top-level sections sent; the others are kept. */
  async update(eventId: string, input: Row) {
    const row = await this.row(eventId);
    const current = normalize(row.site_content);
    const next = { ...current };
    const mediaPrefix = this.mediaPrefix(eventId);

    if (input.story !== undefined) {
      const v = obj(input.story, 'story');
      next.story = {
        title: text(v.title, 80, 'Story title'),
        body: text(v.body, 5000, 'Story'),
        photoUrl: mediaUrl(v.photoUrl, mediaPrefix),
      };
    }
    if (input.cover !== undefined) {
      const v = obj(input.cover, 'cover');
      next.cover = { photoUrl: mediaUrl(v.photoUrl, mediaPrefix) };
    }
    if (input.faq !== undefined) {
      next.faq = list(input.faq, 30, 'questions').map((v) => ({
        q: text(v.q, 200, 'Question'),
        a: text(v.a, 1500, 'Answer'),
      })).filter((f) => f.q);
    }
    if (input.stay !== undefined) {
      next.stay = list(input.stay, 20, 'places to stay').map((v) => ({
        name: text(v.name, 120, 'Hotel name'),
        address: text(v.address, 300, 'Address'),
        url: httpsUrl(v.url, 'Website'),
        phone: text(v.phone, 40, 'Phone'),
        note: text(v.note, 300, 'Note'),
      })).filter((h) => h.name);
    }
    if (input.invitation !== undefined) {
      const v = obj(input.invitation, 'invitation');
      next.invitation = { message: text(v.message, 1500, 'Invitation message'), closing: text(v.closing, 200, 'Closing') };
    }
    if (input.travel !== undefined) {
      const v = obj(input.travel, 'travel');
      next.travel = {
        airport: text(v.airport, 300, 'Airport'),
        transport: text(v.transport, 1000, 'Transport'),
        parking: text(v.parking, 500, 'Parking'),
        note: text(v.note, 1000, 'Travel note'),
      };
    }
    if (input.gifts !== undefined) {
      const v = obj(input.gifts, 'gifts');
      const bank = v.bank === undefined || v.bank === null ? {} : obj(v.bank, 'bank');
      const clabe = text(bank.clabe, 18, 'CLABE').replace(/\s+/g, '');
      if (clabe && !/^\d{18}$/.test(clabe)) throw new BadRequestException('A CLABE is 18 digits');
      next.gifts = {
        note: text(v.note, 600, 'Gift note'),
        bank: {
          holder: text(bank.holder, 120, 'Account holder'),
          bank: text(bank.bank, 80, 'Bank'),
          clabe,
          reference: text(bank.reference, 60, 'Reference'),
        },
      };
    }

    if (input.agenda !== undefined) {
      next.agenda = list(input.agenda, 60, 'agenda items').map((v) => ({
        time: text(v.time, 40, 'Time'),
        title: text(v.title, 160, 'Session title'),
        speaker: text(v.speaker, 120, 'Speaker'),
        description: text(v.description, 1000, 'Session description'),
      })).filter((a) => a.title);
    }
    if (input.speakers !== undefined) {
      next.speakers = list(input.speakers, 40, 'speakers').map((v) => ({
        name: text(v.name, 120, 'Speaker name'),
        role: text(v.role, 160, 'Speaker role'),
        bio: text(v.bio, 1500, 'Speaker bio'),
        photoUrl: mediaUrl(v.photoUrl, mediaPrefix),
      })).filter((sp) => sp.name);
    }
    if (input.materials !== undefined) {
      next.materials = list(input.materials, 40, 'materials').map((v) => ({
        title: text(v.title, 160, 'Material title'),
        url: httpsUrl(v.url, 'Material link'),
        description: text(v.description, 300, 'Material description'),
      })).filter((m) => m.title && m.url);
    }
    if (input.life !== undefined) {
      const v = obj(input.life, 'life');
      next.life = {
        born: isoDate(v.born, 'Date of birth'),
        died: isoDate(v.died, 'Date of passing'),
        biography: text(v.biography, 6000, 'Biography'),
        obituary: text(v.obituary, 3000, 'Obituary'),
        photoUrl: mediaUrl(v.photoUrl, mediaPrefix),
      };
    }
    if (input.condolences !== undefined) {
      const v = obj(input.condolences, 'condolences');
      if (v.enabled !== undefined && typeof v.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
      next.condolences = { enabled: v.enabled === true, intro: text(v.intro, 400, 'Condolences intro') };
    }
    if (input.donations !== undefined) {
      const v = obj(input.donations, 'donations');
      next.donations = {
        org: text(v.org, 160, 'Organisation'),
        url: httpsUrl(v.url, 'Donation link'),
        note: text(v.note, 600, 'Donation note'),
      };
    }

    const { error } = await this.db
      .from('events')
      .update({ site_content: next, updated_at: new Date().toISOString() })
      .eq('id', eventId);
    if (error) throw this.fail('Could not save your site', error);
    return this.view({ ...row, site_content: next });
  }

  /** A photo for the site (story, cover). Returns its public URL; the caller saves it into content. */
  async upload(eventId: string, file: UploadedImage | undefined): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('Send the image as multipart field "image"');
    const type = sniffImageType(file.buffer);
    const ext = type ? IMAGE_TYPES[type] : undefined;
    if (!ext) throw new UnsupportedMediaTypeException('Use a JPEG, PNG or WebP image');
    if (file.size > MAX_IMAGE_BYTES) throw new PayloadTooLargeException('Images must be 8 MB or smaller');

    await this.ensureBucket();
    const path = `${eventId}/${randomUUID()}.${ext}`;
    const storage = this.db.storage.from(EVENT_MEDIA_BUCKET);
    const up = await storage.upload(path, file.buffer, { contentType: type!, cacheControl: '31536000' });
    if (up.error) throw new InternalServerErrorException(`Could not store the image: ${up.error.message}`);
    return { url: storage.getPublicUrl(path).data.publicUrl };
  }

  /** Makes the site public at its subdomain. Free: tiers and payments come later. */
  async publish(eventId: string) {
    const row = await this.row(eventId);
    if (!row.slug) throw new BadRequestException('Choose your site address before publishing');
    if (row.state === 'suspended') throw new BadRequestException('This site is suspended. Contact Lazo support.');
    // Modes that default to private (memorial, baptism) cannot go live open (EVT-5).
    if (row.password_required === true && !row.site_password_hash) {
      throw new BadRequestException('This kind of event is private: set a site password before publishing.');
    }
    const { error } = await this.db
      .from('events')
      .update({ state: 'live', published_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', eventId);
    if (error) throw this.fail('Could not publish', error);
    return this.get(eventId);
  }

  async unpublish(eventId: string) {
    const row = await this.row(eventId);
    if (row.state !== 'live') return this.view(row);
    const { error } = await this.db
      .from('events')
      .update({ state: 'draft', updated_at: new Date().toISOString() })
      .eq('id', eventId);
    if (error) throw this.fail('Could not unpublish', error);
    return this.get(eventId);
  }

  /** { password: string } sets it (6–100 characters); { password: null } removes it. */
  async setPassword(eventId: string, input: Row) {
    let hash: string | null = null;
    if (input.password !== null) {
      const password = s(input.password);
      if (password.length < 6 || password.length > 100) {
        throw new BadRequestException('Use a password of 6 to 100 characters');
      }
      const salt = randomBytes(16);
      const key = await scrypt(password, salt, 32);
      hash = `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
    }
    const { error } = await this.db.from('events').update({ site_password_hash: hash }).eq('id', eventId);
    if (error) throw this.fail('Could not save the password', error);
    return this.get(eventId);
  }

  // ------------------------------------------------------------ public side

  /** Checks a guest's password for a protected site and returns a token for later requests. */
  async unlock(slug: string, hash: string | null, password: unknown): Promise<{ token: string }> {
    if (!hash) return { token: '' };
    const [, saltB64, keyB64] = hash.split('$');
    const expected = Buffer.from(keyB64 ?? '', 'base64');
    const actual = await scrypt(s(password), Buffer.from(saltB64 ?? '', 'base64'), 32);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException({ message: 'That password isn’t right.', reason: 'password' });
    }
    return { token: siteToken(slug, hash) };
  }

  // ------------------------------------------------------------ internals

  private view(row: Row) {
    return {
      content: normalize(row.site_content),
      publish: {
        state: s(row.state),
        slug: typeof row.slug === 'string' ? row.slug : null,
        publishedAt: typeof row.published_at === 'string' ? row.published_at : null,
        protected: typeof row.site_password_hash === 'string' && row.site_password_hash.length > 0,
        passwordRequired: row.password_required === true,
      },
    };
  }

  private async row(eventId: string): Promise<Row> {
    const { data, error } = await this.db.from('events').select('*').eq('id', eventId).single();
    if (error) throw this.fail('Could not load your site', error);
    const row = data as Row;
    if (!('site_content' in row)) {
      throw new ServiceUnavailableException(`Site content is not set up. Apply ${SITE_CONTENT_MIGRATION}.`);
    }
    return row;
  }

  private mediaPrefix(eventId: string) {
    const base = this.db.storage.from(EVENT_MEDIA_BUCKET).getPublicUrl(`${eventId}/`).data.publicUrl;
    return base;
  }

  private ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      const found = await this.db.storage.getBucket(EVENT_MEDIA_BUCKET);
      if (!found.error) return;
      const created = await this.db.storage.createBucket(EVENT_MEDIA_BUCKET, {
        public: true,
        fileSizeLimit: MAX_IMAGE_BYTES,
        allowedMimeTypes: Object.keys(IMAGE_TYPES),
      });
      if (created.error && !/already exists/i.test(created.error.message)) {
        throw new InternalServerErrorException(`Could not create the ${EVENT_MEDIA_BUCKET} bucket: ${created.error.message}`);
      }
    })().catch((error: unknown) => {
      this.bucketReady = null;
      throw error;
    });
    return this.bucketReady;
  }

  private fail(action: string, error: { code?: string; message: string }): Error {
    if (error.code === UNDEFINED_COLUMN) {
      return new ServiceUnavailableException(`Site content is not set up. Apply ${SITE_CONTENT_MIGRATION}.`);
    }
    return new InternalServerErrorException(`${action}: ${error.message}`);
  }

  private get db(): SupabaseClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as SupabaseClient;
  }
}

/** A token proving the password was entered for this site; changes when the password does. */
export function siteToken(slug: string, hash: string): string {
  const secret = process.env.SITE_TOKEN_SECRET || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const key = createHash('sha256').update(`lazo-site-token:${secret}`).digest();
  return createHmac('sha256', key).update(`${slug}:${hash}`).digest('base64url');
}

export function tokenMatches(slug: string, hash: string, token: unknown): boolean {
  if (typeof token !== 'string' || !token) return false;
  const expected = Buffer.from(siteToken(slug, hash));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Stored content with every section present, whatever the row holds. */
export function normalize(value: unknown): SiteContent {
  const v = (value && typeof value === 'object' ? value : {}) as Row;
  const o = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Row) : {});
  const arr = (x: unknown) => (Array.isArray(x) ? (x as Row[]).filter((i) => i && typeof i === 'object') : []);
  const story = o(v.story);
  const inv = o(v.invitation);
  const gifts = o(v.gifts);
  const bank = o(gifts.bank);
  return {
    story: { title: s(story.title), body: s(story.body), photoUrl: s(story.photoUrl) },
    faq: arr(v.faq).map((f) => ({ q: s(f.q), a: s(f.a) })),
    stay: arr(v.stay).map((h) => ({ name: s(h.name), address: s(h.address), url: s(h.url), phone: s(h.phone), note: s(h.note) })),
    invitation: { message: s(inv.message), closing: s(inv.closing) },
    gifts: { note: s(gifts.note), bank: { holder: s(bank.holder), bank: s(bank.bank), clabe: s(bank.clabe), reference: s(bank.reference) } },
    cover: { photoUrl: s(o(v.cover).photoUrl) },
    travel: { airport: s(o(v.travel).airport), transport: s(o(v.travel).transport), parking: s(o(v.travel).parking), note: s(o(v.travel).note) },
    agenda: arr(v.agenda).map((a) => ({ time: s(a.time), title: s(a.title), speaker: s(a.speaker), description: s(a.description) })),
    speakers: arr(v.speakers).map((p) => ({ name: s(p.name), role: s(p.role), bio: s(p.bio), photoUrl: s(p.photoUrl) })),
    materials: arr(v.materials).map((m) => ({ title: s(m.title), url: s(m.url), description: s(m.description) })),
    life: { born: s(o(v.life).born), died: s(o(v.life).died), biography: s(o(v.life).biography), obituary: s(o(v.life).obituary), photoUrl: s(o(v.life).photoUrl) },
    condolences: { enabled: o(v.condolences).enabled === true, intro: s(o(v.condolences).intro) },
    donations: { org: s(o(v.donations).org), url: s(o(v.donations).url), note: s(o(v.donations).note) },
  };
}

function obj(value: unknown, name: string): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException(`${name} must be an object`);
  return value as Row;
}

function list(value: unknown, max: number, name: string): Row[] {
  if (!Array.isArray(value)) throw new BadRequestException(`${name} must be a list`);
  if (value.length > max) throw new BadRequestException(`Up to ${max} ${name}`);
  return value.map((v) => obj(v, name));
}

function text(value: unknown, max: number, label: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BadRequestException(`${label} must be text`);
  const v = value.trim();
  if (v.length > max) throw new BadRequestException(`${label} must be ${max} characters or fewer`);
  return v;
}

/** YYYY-MM-DD or empty. */
function isoDate(value: unknown, label: string): string {
  const v = text(value, 10, label);
  if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequestException(`${label} must be a date (YYYY-MM-DD)`);
  return v;
}

function httpsUrl(value: unknown, label: string): string {
  const v = text(value, 500, label);
  if (!v) return '';
  try {
    const url = new URL(v);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    return url.toString();
  } catch {
    throw new BadRequestException(`${label} must be a web address (https://…)`);
  }
}

/** Only photos this event uploaded to our bucket (no hot-linking arbitrary URLs into a public page). */
function mediaUrl(value: unknown, prefix: string): string {
  const v = text(value, 600, 'Photo');
  if (!v) return '';
  if (!v.startsWith(prefix)) throw new BadRequestException('Upload the photo instead of linking to it');
  return v;
}
