import { BadRequestException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { dbError, oneOf, text, toLocation, toProduct, toPromotion, toVendor } from './vendor-common.js';
import type { RawClient, Row } from './vendor-common.js';

const VENDOR_ACTIONS = ['approve', 'reject', 'pause', 'activate'] as const;
const DECISIONS = ['approve', 'reject'] as const;

/**
 * The Lazo team's side of the vendor marketplace: approve vendor profiles,
 * moderate products and venue locations, and approve promotions. Reachable
 * only through @Roles('admin') routes.
 */
@Injectable()
export class VendorAdminService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  /** Vendors, optionally by status, with listing counts for the review queue. */
  async vendors(status: unknown) {
    let query = this.db.from('vendors').select('*').order('submitted_at', { ascending: false, nullsFirst: false });
    if (typeof status === 'string' && status) query = query.eq('status', status);

    const [vendors, products, locations, selections] = await Promise.all([
      query,
      this.db.from('vendor_packages').select('vendor_id, review_status'),
      this.db.from('vendor_locations').select('vendor_id, review_status'),
      this.db.from('vendor_selections').select('vendor_id'),
    ]);
    for (const r of [vendors, products, locations, selections]) {
      if (r.error) throw dbError('Could not load vendors', r.error);
    }

    const count = (rows: Row[] | null, id: string, pendingOnly = false) =>
      (rows ?? []).filter((r) => r.vendor_id === id && (!pendingOnly || r.review_status === 'pending')).length;

    return (vendors.data ?? []).map((row) => {
      const v = toVendor(row);
      return {
        ...v,
        products: count(products.data, v.id),
        locations: count(locations.data, v.id),
        pendingListings: count(products.data, v.id, true) + count(locations.data, v.id, true),
        selections: count(selections.data, v.id),
      };
    });
  }

  async reviewVendor(adminId: string, id: string, input: Row) {
    const action = oneOf(input.action, VENDOR_ACTIONS, 'action');
    const note = text(input.note, 1000, 'note');
    if (action === 'reject' && !note) throw new BadRequestException('Say why, so the vendor can fix it');

    const now = new Date().toISOString();
    const patch: Row = {
      approve: { status: 'active', verified_at: now, review_note: note },
      reject: { status: 'rejected', review_note: note },
      pause: { status: 'paused', review_note: note },
      activate: { status: 'active', review_note: note },
    }[action];

    const { data, error } = await this.db
      .from('vendors')
      .update({ ...patch, reviewed_at: now, reviewed_by: adminId, updated_at: now })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw dbError('Could not update the vendor', error);
    if (!data) throw new NotFoundException('No such vendor');
    return toVendor(data);
  }

  /** Products and locations, pending first, with their vendor's name. */
  async listings(status: unknown) {
    const wanted = typeof status === 'string' && status ? status : null;
    const build = (table: string) => {
      let q = this.db.from(table).select('*').order('updated_at', { ascending: false });
      if (wanted) q = q.eq('review_status', wanted);
      return q;
    };

    const [products, locations, vendors] = await Promise.all([
      build('vendor_packages'),
      build('vendor_locations'),
      this.db.from('vendors').select('id, business_name, status'),
    ]);
    for (const r of [products, locations, vendors]) {
      if (r.error) throw dbError('Could not load listings', r.error);
    }

    const names = new Map((vendors.data ?? []).map((v) => [v.id as string, v]));
    const withVendor = <T extends { vendorId: string }>(item: T) => ({
      ...item,
      vendorName: (names.get(item.vendorId)?.business_name as string) ?? '',
      vendorStatus: (names.get(item.vendorId)?.status as string) ?? '',
    });

    return {
      products: (products.data ?? []).map(toProduct).map(withVendor),
      locations: (locations.data ?? []).map(toLocation).map(withVendor),
    };
  }

  async reviewListing(type: unknown, id: string, input: Row) {
    const kind = oneOf(type, ['product', 'location'] as const, 'type');
    const decision = oneOf(input.decision, DECISIONS, 'decision');
    const note = text(input.note, 1000, 'note');
    if (decision === 'reject' && !note) throw new BadRequestException('Say why, so the vendor can fix it');

    const table = kind === 'product' ? 'vendor_packages' : 'vendor_locations';
    const { data, error } = await this.db
      .from(table)
      .update({
        review_status: decision === 'approve' ? 'approved' : 'rejected',
        review_note: note,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw dbError('Could not update the listing', error);
    if (!data) throw new NotFoundException(`No such ${kind}`);
    return kind === 'product' ? toProduct(data) : toLocation(data);
  }

  async promotions(status: unknown) {
    let query = this.db.from('vendor_promotions').select('*').order('created_at', { ascending: false });
    if (typeof status === 'string' && status) query = query.eq('status', status);

    const [promos, vendors, products, locations] = await Promise.all([
      query,
      this.db.from('vendors').select('id, business_name'),
      this.db.from('vendor_packages').select('id, name'),
      this.db.from('vendor_locations').select('id, name'),
    ]);
    for (const r of [promos, vendors, products, locations]) {
      if (r.error) throw dbError('Could not load promotions', r.error);
    }

    const name = (rows: Row[] | null, id: string | null) =>
      (id && ((rows ?? []).find((r) => r.id === id)?.name as string)) || '';
    const vendorName = (id: string) =>
      ((vendors.data ?? []).find((v) => v.id === id)?.business_name as string) ?? '';

    return (promos.data ?? []).map(toPromotion).map((p) => ({
      ...p,
      vendorName: vendorName(p.vendorId),
      listingType: p.packageId ? 'product' : 'location',
      listingName: p.packageId ? name(products.data, p.packageId) : name(locations.data, p.locationId),
    }));
  }

  /** Approving starts the promotion now and runs it for the requested days. */
  async reviewPromotion(id: string, input: Row) {
    const decision = oneOf(input.decision, [...DECISIONS, 'end'] as const, 'decision');
    const note = text(input.note, 1000, 'note');
    if (decision === 'reject' && !note) throw new BadRequestException('Say why, so the vendor understands');

    const { data: current, error: loadError } = await this.db
      .from('vendor_promotions')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (loadError) throw dbError('Could not load the promotion', loadError);
    if (!current) throw new NotFoundException('No such promotion');

    const now = new Date();
    const patch: Row =
      decision === 'approve'
        ? {
            status: 'approved',
            starts_at: now.toISOString(),
            ends_at: new Date(now.getTime() + (current.days as number) * 86_400_000).toISOString(),
          }
        : decision === 'end'
          ? { ends_at: now.toISOString() }
          : { status: 'rejected' };

    const { data, error } = await this.db
      .from('vendor_promotions')
      .update({ ...patch, review_note: note, reviewed_at: now.toISOString() })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw dbError('Could not update the promotion', error);
    return toPromotion(data);
  }

  private get db(): RawClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as RawClient;
  }
}
