import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import {
  AVAILABILITY,
  DEPARTMENTS,
  PROMOTION_DAYS,
  PURCHASE_MODES,
  UNIQUE_VIOLATION,
  bool,
  cents,
  dbError,
  int,
  list,
  oneOf,
  text,
  toLocation,
  toProduct,
  toPromotion,
  toVendor,
  uploadImage,
  url,
} from './vendor-common.js';
import type { Product, Promotion, RawClient, Row, UploadedImage, Vendor, VendorLocation } from './vendor-common.js';

export interface ListingStats {
  type: 'product' | 'location';
  id: string;
  name: string;
  reviewStatus: string;
  active: boolean;
  views: number;
  selections: number;
  featured: boolean;
}

/**
 * Everything a vendor does from their own dashboard. Every method is scoped
 * to the caller's vendor profile (vendors.owner_id = Clerk user id).
 */
@Injectable()
export class VendorsService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  // ------------------------------------------------------------ profile

  /** The caller's profile, or null if they haven't started one. */
  async mine(ownerId: string): Promise<Vendor | null> {
    const { data, error } = await this.db.from('vendors').select('*').eq('owner_id', ownerId).maybeSingle();
    if (error) throw dbError('Could not load your vendor profile', error);
    return data ? toVendor(data) : null;
  }

  async createProfile(ownerId: string, input: Row): Promise<Vendor> {
    if (await this.mine(ownerId)) throw new ConflictException('You already have a vendor profile');

    const { data, error } = await this.db
      .from('vendors')
      .insert({ ...this.profileFields(input, true), owner_id: ownerId, status: 'candidate', intake_source: 'portal' })
      .select('*')
      .single();

    if (error?.code === UNIQUE_VIOLATION) throw new ConflictException('You already have a vendor profile');
    if (error) throw dbError('Could not create your vendor profile', error);
    return toVendor(data);
  }

  async updateProfile(ownerId: string, input: Row): Promise<Vendor> {
    const vendor = await this.requireMine(ownerId);
    const fields = this.profileFields(input, false);
    if (Object.keys(fields).length === 0) throw new BadRequestException('Nothing to update');

    const { data, error } = await this.db
      .from('vendors')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', vendor.id)
      .select('*')
      .single();

    if (error) throw dbError('Could not save your vendor profile', error);
    return toVendor(data);
  }

  /** Sends the profile to the Lazo team. Also how a rejected profile tries again. */
  async submit(ownerId: string): Promise<Vendor> {
    const vendor = await this.requireMine(ownerId);

    if (vendor.status === 'pending_approval') return vendor;
    if (vendor.status === 'active') throw new BadRequestException('Your profile is already approved');
    if (vendor.status === 'paused') throw new ForbiddenException('Your profile is paused; contact Lazo support');

    const missing = [
      !vendor.businessName && 'business name',
      !vendor.department && 'category',
      !vendor.city && 'city',
      !vendor.description && 'description',
      !vendor.phone && !vendor.email && 'a phone number or email',
    ].filter(Boolean);
    if (missing.length) throw new BadRequestException(`Add ${missing.join(', ')} before submitting`);

    const { data, error } = await this.db
      .from('vendors')
      .update({ status: 'pending_approval', submitted_at: new Date().toISOString(), review_note: '' })
      .eq('id', vendor.id)
      .select('*')
      .single();

    if (error) throw dbError('Could not submit your profile', error);
    return toVendor(data);
  }

  async uploadLogo(ownerId: string, file: UploadedImage | undefined): Promise<Vendor> {
    const vendor = await this.requireMine(ownerId);
    const logoUrl = await uploadImage(this.db, `${vendor.id}/logo`, file);

    // Written here, never from a request body: only an uploaded file can set it.
    const { data, error } = await this.db
      .from('vendors')
      .update({ logo_url: logoUrl, updated_at: new Date().toISOString() })
      .eq('id', vendor.id)
      .select('*')
      .single();
    if (error) throw dbError('Could not save your logo', error);
    return toVendor(data);
  }

  /** Uploads a product or location photo and returns its URL for the form. */
  async uploadMedia(ownerId: string, file: UploadedImage | undefined): Promise<{ url: string }> {
    const vendor = await this.requireMine(ownerId);
    return { url: await uploadImage(this.db, `${vendor.id}/media`, file) };
  }

  // ----------------------------------------------------------- products

  async products(ownerId: string): Promise<Product[]> {
    const vendor = await this.requireMine(ownerId);
    const { data, error } = await this.db
      .from('vendor_packages')
      .select('*')
      .eq('vendor_id', vendor.id)
      .order('created_at', { ascending: false });
    if (error) throw dbError('Could not load your products', error);
    return (data ?? []).map(toProduct);
  }

  /** New and edited products go to review before hosts see them. */
  async saveProduct(ownerId: string, id: string | null, input: Row): Promise<Product> {
    const vendor = await this.requireMine(ownerId);
    const fields = this.productFields(input, id === null);

    const query = id
      ? this.db
          .from('vendor_packages')
          .update({ ...fields, ...this.backToReview(fields) })
          .eq('id', id)
          .eq('vendor_id', vendor.id)
      : this.db.from('vendor_packages').insert({ ...fields, vendor_id: vendor.id, review_status: 'pending' });

    const { data, error } = await query.select('*').maybeSingle();
    if (error) throw dbError('Could not save the product', error);
    if (!data) throw new NotFoundException('No such product');
    return toProduct(data);
  }

  async removeProduct(ownerId: string, id: string): Promise<void> {
    await this.removeOwned(ownerId, 'vendor_packages', id, 'product');
  }

  // ---------------------------------------------------------- locations

  async locations(ownerId: string): Promise<VendorLocation[]> {
    const vendor = await this.requireMine(ownerId);
    const { data, error } = await this.db
      .from('vendor_locations')
      .select('*')
      .eq('vendor_id', vendor.id)
      .order('created_at', { ascending: false });
    if (error) throw dbError('Could not load your locations', error);
    return (data ?? []).map(toLocation);
  }

  async saveLocation(ownerId: string, id: string | null, input: Row): Promise<VendorLocation> {
    const vendor = await this.requireMine(ownerId);
    const fields = this.locationFields(input, id === null);

    const query = id
      ? this.db
          .from('vendor_locations')
          .update({ ...fields, ...this.backToReview(fields) })
          .eq('id', id)
          .eq('vendor_id', vendor.id)
      : this.db.from('vendor_locations').insert({ ...fields, vendor_id: vendor.id, review_status: 'pending' });

    const { data, error } = await query.select('*').maybeSingle();
    if (error) throw dbError('Could not save the location', error);
    if (!data) throw new NotFoundException('No such location');
    return toLocation(data);
  }

  async removeLocation(ownerId: string, id: string): Promise<void> {
    await this.removeOwned(ownerId, 'vendor_locations', id, 'location');
  }

  // --------------------------------------------------------- promotions

  async promotions(ownerId: string): Promise<Promotion[]> {
    const vendor = await this.requireMine(ownerId);
    const { data, error } = await this.db
      .from('vendor_promotions')
      .select('*')
      .eq('vendor_id', vendor.id)
      .order('created_at', { ascending: false });
    if (error) throw dbError('Could not load your promotions', error);
    return (data ?? []).map(toPromotion);
  }

  /** Ask to feature an approved product or location; the Lazo team reviews it. */
  async requestPromotion(ownerId: string, input: Row): Promise<Promotion> {
    const vendor = await this.requireMine(ownerId);
    if (vendor.status !== 'active') {
      throw new BadRequestException('Your profile must be approved before you can promote listings');
    }

    const type = oneOf(input.type, ['product', 'location'] as const, 'type');
    const listingId = text(input.id, 60, 'id', true);
    const days = Number(input.days);
    if (!PROMOTION_DAYS.includes(days as (typeof PROMOTION_DAYS)[number])) {
      throw new BadRequestException(`days must be one of: ${PROMOTION_DAYS.join(', ')}`);
    }

    const table = type === 'product' ? 'vendor_packages' : 'vendor_locations';
    const { data: listing, error: listingError } = await this.db
      .from(table)
      .select('id, review_status, active')
      .eq('id', listingId)
      .eq('vendor_id', vendor.id)
      .maybeSingle();
    if (listingError) throw dbError('Could not check the listing', listingError);
    if (!listing) throw new NotFoundException(`No such ${type}`);
    if (listing.review_status !== 'approved' || listing.active === false) {
      throw new BadRequestException(`Only approved, active ${type}s can be promoted`);
    }

    const column = type === 'product' ? 'package_id' : 'location_id';
    const open = await this.db
      .from('vendor_promotions')
      .select('id, status, ends_at')
      .eq(column, listingId)
      .in('status', ['requested', 'approved']);
    if (open.error) throw dbError('Could not check promotions', open.error);
    const stillOpen = (open.data ?? []).some(
      (p) => p.status === 'requested' || (p.ends_at && Date.parse(p.ends_at as string) > Date.now()),
    );
    if (stillOpen) throw new ConflictException('This listing already has a promotion requested or running');

    const { data, error } = await this.db
      .from('vendor_promotions')
      .insert({
        vendor_id: vendor.id,
        [column]: listingId,
        days,
        message: text(input.message, 500, 'message'),
      })
      .select('*')
      .single();
    if (error) throw dbError('Could not request the promotion', error);
    return toPromotion(data);
  }

  async cancelPromotion(ownerId: string, id: string): Promise<Promotion> {
    const vendor = await this.requireMine(ownerId);
    const { data, error } = await this.db
      .from('vendor_promotions')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('vendor_id', vendor.id)
      .in('status', ['requested', 'approved'])
      .select('*')
      .maybeSingle();
    if (error) throw dbError('Could not cancel the promotion', error);
    if (!data) throw new NotFoundException('No open promotion with that id');
    return toPromotion(data);
  }

  // -------------------------------------------------------------- stats

  /** Unique daily views and host selections, per listing and in total. */
  async stats(ownerId: string): Promise<{
    totals: { views: number; selections: number; events: number; views30d: number };
    listings: ListingStats[];
  }> {
    const vendor = await this.requireMine(ownerId);
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

    const [products, locations, views, selections, promos] = await Promise.all([
      this.db.from('vendor_packages').select('id, name, review_status, active').eq('vendor_id', vendor.id),
      this.db.from('vendor_locations').select('id, name, review_status, active').eq('vendor_id', vendor.id),
      this.db.from('vendor_listing_views').select('package_id, location_id, viewed_on').eq('vendor_id', vendor.id),
      this.db.from('vendor_selections').select('package_id, location_id, event_id').eq('vendor_id', vendor.id),
      this.db.from('vendor_promotions').select('*').eq('vendor_id', vendor.id).eq('status', 'approved'),
    ]);
    for (const r of [products, locations, views, selections, promos]) {
      if (r.error) throw dbError('Could not load your stats', r.error);
    }

    const tally = (rows: Row[] | null) => {
      const map = new Map<string, number>();
      for (const row of rows ?? []) {
        const key = (row.package_id ?? row.location_id) as string;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      return map;
    };
    const viewCounts = tally(views.data);
    const selectionCounts = tally(selections.data);
    const live = new Set(
      (promos.data ?? [])
        .map(toPromotion)
        .filter((p) => p.live)
        .map((p) => p.packageId ?? p.locationId),
    );

    const listing = (type: 'product' | 'location') => (row: Row): ListingStats => ({
      type,
      id: row.id as string,
      name: row.name as string,
      reviewStatus: row.review_status as string,
      active: row.active !== false,
      views: viewCounts.get(row.id as string) ?? 0,
      selections: selectionCounts.get(row.id as string) ?? 0,
      featured: live.has(row.id as string),
    });

    const listings = [
      ...(locations.data ?? []).map(listing('location')),
      ...(products.data ?? []).map(listing('product')),
    ].sort((a, b) => b.selections - a.selections || b.views - a.views);

    return {
      totals: {
        views: views.data?.length ?? 0,
        views30d: (views.data ?? []).filter((v) => (v.viewed_on as string) >= since).length,
        selections: selections.data?.length ?? 0,
        events: new Set((selections.data ?? []).map((s) => s.event_id)).size,
      },
      listings,
    };
  }

  // ---------------------------------------------------------- internals

  private async requireMine(ownerId: string): Promise<Vendor> {
    const vendor = await this.mine(ownerId);
    if (!vendor) throw new NotFoundException('Create your vendor profile first');
    return vendor;
  }

  private async removeOwned(ownerId: string, table: string, id: string, what: string): Promise<void> {
    const vendor = await this.requireMine(ownerId);
    const { data, error } = await this.db
      .from(table)
      .delete()
      .eq('id', id)
      .eq('vendor_id', vendor.id)
      .select('id');
    if (error) throw dbError(`Could not delete the ${what}`, error);
    if (!data?.length) throw new NotFoundException(`No such ${what}`);
  }

  /** Content edits send a listing back to review; toggling `active` alone doesn't. */
  private backToReview(fields: Row): Row {
    const contentChanged = Object.keys(fields).some((k) => k !== 'active');
    return {
      updated_at: new Date().toISOString(),
      ...(contentChanged ? { review_status: 'pending', review_note: '', reviewed_at: null } : {}),
    };
  }

  private profileFields(input: Row, creating: boolean): Row {
    const out: Row = {};
    const has = (k: string) => creating || input[k] !== undefined;

    if (has('businessName')) out.business_name = text(input.businessName, 160, 'Business name', true);
    if (has('department')) out.department = oneOf(input.department, DEPARTMENTS, 'Category');
    if (has('city')) out.city = text(input.city, 80, 'City', creating);
    if (input.serviceArea !== undefined) out.service_area = list(input.serviceArea, 'Service area');
    if (input.description !== undefined) out.description = text(input.description, 2000, 'Description');
    if (input.phone !== undefined) out.phone = text(input.phone, 40, 'Phone');
    if (input.email !== undefined) {
      const email = text(input.email, 160, 'Email');
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Email is not valid');
      out.email = email;
    }
    if (input.website !== undefined) out.website = url(input.website, 'Website');
    if (input.instagram !== undefined) out.instagram = text(input.instagram, 80, 'Instagram').replace(/^@/, '');
    if (input.purchaseMode !== undefined) out.purchase_mode = oneOf(input.purchaseMode, PURCHASE_MODES, 'How hosts buy');
    return out;
  }

  private productFields(input: Row, creating: boolean): Row {
    const out: Row = {};
    if (creating || input.name !== undefined) out.name = text(input.name, 160, 'Name', true);
    if (input.description !== undefined) out.description = text(input.description, 2000, 'Description');
    if (input.price !== undefined) out.price_cents = cents(input.price, 'Price');
    if (input.capacityMin !== undefined) out.capacity_min = int(input.capacityMin, 'Minimum guests', 0, 100000);
    if (input.capacityMax !== undefined) out.capacity_max = int(input.capacityMax, 'Maximum guests', 0, 100000);
    if (input.availability !== undefined) out.availability = oneOf(input.availability, AVAILABILITY, 'Availability');
    if (input.imageUrl !== undefined) out.image_url = url(input.imageUrl, 'Image');
    if (input.active !== undefined) out.active = bool(input.active, 'Active') ?? true;
    this.checkCapacity(out);
    if (!creating && Object.keys(out).length === 0) throw new BadRequestException('Nothing to update');
    return out;
  }

  private locationFields(input: Row, creating: boolean): Row {
    const out: Row = {};
    if (creating || input.name !== undefined) out.name = text(input.name, 160, 'Name', true);
    if (input.description !== undefined) out.description = text(input.description, 2000, 'Description');
    if (creating || input.address !== undefined) out.address = text(input.address, 300, 'Address', true);
    if (creating || input.city !== undefined) out.city = text(input.city, 80, 'City', true);
    if (input.region !== undefined) out.region = text(input.region, 80, 'State or region');
    if (input.capacityMin !== undefined) out.capacity_min = int(input.capacityMin, 'Minimum guests', 0, 100000);
    if (input.capacityMax !== undefined) out.capacity_max = int(input.capacityMax, 'Maximum guests', 0, 100000);
    if (input.imageUrl !== undefined) out.image_url = url(input.imageUrl, 'Image');
    if (input.active !== undefined) out.active = bool(input.active, 'Active') ?? true;
    this.checkCapacity(out);
    if (!creating && Object.keys(out).length === 0) throw new BadRequestException('Nothing to update');
    return out;
  }

  private checkCapacity(out: Row): void {
    const min = out.capacity_min as number | null | undefined;
    const max = out.capacity_max as number | null | undefined;
    if (min != null && max != null && max < min) {
      throw new BadRequestException('Maximum guests must be at least the minimum');
    }
  }

  private get db(): RawClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as RawClient;
  }
}
