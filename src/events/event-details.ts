import { BadRequestException } from '@nestjs/common';
import { parseSlug } from '../sites/site-config.js';

/** One input of an occasion's details form, as stored in event_modes.fields. */
export interface DetailField {
  key: string;
  label: string;
  required?: boolean;
  maxLength?: number;
}

const DEFAULT_MAX = 80;

/**
 * Checks answers against the occasion's fields: only known keys, strings,
 * required ones present, within length. Blank optional answers are dropped.
 */
export function parseDetails(fields: DetailField[], input: unknown): Record<string, string> {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('details must be an object');
  }

  const given = input as Record<string, unknown>;
  const known = new Set(fields.map((f) => f.key));
  const unknown = Object.keys(given).filter((k) => !known.has(k));
  if (unknown.length) throw new BadRequestException(`Unknown detail: ${unknown.join(', ')}`);

  const details: Record<string, string> = {};

  for (const field of fields) {
    const raw = given[field.key];
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      throw new BadRequestException(`${field.label} must be text`);
    }

    const value = (raw ?? '').replace(/\s+/g, ' ').trim();
    const max = field.maxLength ?? DEFAULT_MAX;

    if (!value) {
      if (field.required) throw new BadRequestException(`${field.label} is required`);
      continue;
    }
    if (value.length > max) throw new BadRequestException(`${field.label} must be at most ${max} characters`);

    details[field.key] = value;
  }

  return details;
}

/** Fills {key} placeholders; null if any placeholder has no answer. */
export function fillTemplate(template: string | null, details: Record<string, string>): string | null {
  if (!template) return null;

  let missing = false;
  const filled = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = details[key];
    if (!value) missing = true;
    return value ?? '';
  });

  return missing ? null : filled.trim() || null;
}

/** "José & Ana" → "jose-ana": ASCII letters, digits and single hyphens. */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The subdomain a new event should start with, before checking it's free.
 * Kept short enough that a "-2" style suffix still fits in one DNS label.
 */
export function baseSlug(template: string | null, details: Record<string, string>, mode: string): string | null {
  const filled = fillTemplate(template, details);
  if (!filled) return null;

  let slug = slugify(filled).slice(0, 56).replace(/-+$/, '');
  if (slug.length < 3) slug = `${slug}-${slugify(mode)}`.replace(/^-+/, '');

  try {
    return parseSlug(slug);
  } catch {
    // Reserved or still malformed ("www", "api"…): make it clearly an event.
    try {
      return parseSlug(`${slug}-${slugify(mode)}`.slice(0, 60));
    } catch {
      return null;
    }
  }
}

/** base, then base-2, base-3 … — the first one not in `taken`. */
export function firstFreeSlug(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;

  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`;
}

/** One family block on the Ceremony Info step (event_modes.family_sections). */
export interface FamilySection {
  key: string;
  title: string;
  /** The details field holding this person's own name (e.g. partner2). */
  nameKey: string;
  nameLabel: string;
}

const FAMILY_LIMITS = { father: 80, mother: 80, address: 300 } as const;

/** The sections as stored, dropping anything malformed. */
export function familySections(value: unknown): FamilySection[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null)
    .map((v) => ({
      key: typeof v.key === 'string' ? v.key : '',
      title: typeof v.title === 'string' ? v.title : '',
      nameKey: typeof v.nameKey === 'string' ? v.nameKey : '',
      nameLabel: typeof v.nameLabel === 'string' ? v.nameLabel : '',
    }))
    .filter((v) => /^[a-z0-9_]{1,40}$/.test(v.key));
}

/**
 * { groom: { father, mother, address }, … } checked against the mode's
 * sections: unknown sections and fields are dropped, values trimmed and
 * length-limited. Throws on anything that isn't text.
 */
export function parseFamilies(
  sections: FamilySection[],
  input: unknown,
): Record<string, { father: string; mother: string; address: string }> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BadRequestException('families must be an object');
  }
  const out: Record<string, { father: string; mother: string; address: string }> = {};
  for (const section of sections) {
    const raw = (input as Record<string, unknown>)[section.key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException(`${section.title || section.key} must be an object`);
    }
    const answers = { father: '', mother: '', address: '' };
    for (const field of Object.keys(FAMILY_LIMITS) as (keyof typeof FAMILY_LIMITS)[]) {
      const value = (raw as Record<string, unknown>)[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') throw new BadRequestException(`${field} must be text`);
      const text = value.trim();
      if (text.length > FAMILY_LIMITS[field]) {
        throw new BadRequestException(`${field} must be ${FAMILY_LIMITS[field]} characters or fewer`);
      }
      answers[field] = text;
    }
    out[section.key] = answers;
  }
  return out;
}
