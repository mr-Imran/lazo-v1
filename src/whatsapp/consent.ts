/**
 * WhatsApp consent captured on the public RSVP form (PRD WA-1). Kept apart
 * from GuestsService so the RSVP submit only gains two lines.
 */
type Row = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Household columns to set from an RSVP submission's { whatsappConsent,
 * whatsappPhone }. Returns null when the form did not touch consent, so an
 * older form keeps working and nothing is written.
 */
export function rsvpConsentPatch(input: Row): Row | null {
  if (typeof input.whatsappConsent !== 'boolean') return null;
  const now = new Date().toISOString();
  const patch: Row = input.whatsappConsent
    ? { whatsapp_consent: true, whatsapp_consent_at: now, whatsapp_consent_source: 'rsvp_form', whatsapp_opted_out_at: null }
    : { whatsapp_consent: false, whatsapp_consent_source: 'rsvp_form' };
  const phone = s(input.whatsappPhone).trim().slice(0, 40);
  if (phone) patch.phone = phone;
  return patch;
}

/** Household consent fields as the guest list and RSVP form see them. */
export function consentView(h: Row) {
  return {
    whatsappConsent: h.whatsapp_consent === true && !h.whatsapp_opted_out_at,
    whatsappConsentSource: s(h.whatsapp_consent_source),
    whatsappOptedOutAt: s(h.whatsapp_opted_out_at) || null,
  };
}
