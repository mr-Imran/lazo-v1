import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { humanDuration, vendorResponseStats } from '../chat/chat-system.js';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import {
  LAZO_PRODUCTS_MIGRATION,
  UNDEFINED_TABLE,
  UNIQUE_VIOLATION,
  dbError,
  oneOf,
  text,
  toLazoProduct,
  toLocation,
  toProduct,
  toPromotion,
  toVendor,
} from './vendor-common.js';
import type { RawClient, Row } from './vendor-common.js';

interface VendorCard {
  id: string;
  businessName: string;
  department: string;
  city: string;
  logoUrl: string;
  phone: string;
  email: string;
  website: string;
  instagram: string;
  /** "2 h", "1 d"... from chat first replies; '' until the vendor has answered a host. */
  responseTime: string;
  /** 0-100, threads answered / threads with a host message; null with no data. */
  responseRate: number | null;
}

export interface Listing {
  /** 'lazo' is one of Lazo's own products: no vendor, sold by Lazo or through an affiliate link. */
  type: 'product' | 'location' | 'lazo';
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  priceCentavos: number | null;
  currency: string;
  capacityMin: number | null;
  capacityMax: number | null;
  address: string;
  city: string;
  featured: boolean;
  department: string;
  vendor: VendorCard | null;
  /** Lazo products only. */
  saleType?: 'affiliate' | 'direct';
  buyUrl?: string;
  sourceSite?: string;
}

const lazoFail = (action: string, error: { code?: string; message: string }) =>
  dbError(action, error, LAZO_PRODUCTS_MIGRATION);

/**
 * What hosts see: only approved listings of active vendors. Featured
 * (promoted) listings come first. Also records views and host selections,
 * which are the numbers vendors see on their dashboard.
 */
@Injectable()
export class MarketplaceService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null,
  ) {}

  async search(filters: { department?: string; city?: string; q?: string; type?: string }): Promise<Listing[]> {
    const q = filters.q?.trim().toLowerCase();
    const [vendorListings, own] = await Promise.all([
      filters.type === 'lazo' ? Promise.resolve([]) : this.vendorListings(filters),
      filters.type === 'location' ? Promise.resolve([]) : this.lazoListings(filters.department),
    ]);
    // Lazo products are online, so a city filter doesn't hide them.
    const ownMatches = own.filter(
      (l) => !q || `${l.name} ${l.description} ${l.sourceSite ?? ''}`.toLowerCase().includes(q),
    );
    return [...vendorListings, ...ownMatches].sort(
      (a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name),
    );
  }

  /** Active Lazo products. Empty (not an error) until their migration is applied. */
  private async lazoListings(department?: string): Promise<Listing[]> {
    let query = this.db.from('lazo_products').select('*').eq('active', true);
    if (department) query = query.eq('department', department);
    const { data, error } = await query;
    if (error) {
      if (error.code === UNDEFINED_TABLE) return [];
      throw lazoFail('Could not load Lazo products', error);
    }
    return (data ?? []).map(toLazoProduct).map((p) => ({
      type: 'lazo' as const,
      id: p.id,
      name: p.name,
      description: p.description,
      imageUrl: p.imageUrl,
      priceCentavos: p.priceCentavos,
      currency: p.currency,
      capacityMin: null,
      capacityMax: null,
      address: '',
      city: '',
      featured: p.featured,
      department: p.department,
      vendor: null,
      saleType: p.saleType,
      buyUrl: p.saleType === 'affiliate' ? p.affiliateUrl : '',
      sourceSite: p.sourceSite,
    }));
  }

  private async vendorListings(filters: { department?: string; city?: string; q?: string; type?: string }): Promise<Listing[]> {
    let vendorsQuery = this.db.from('vendors').select('*').eq('status', 'active');
    if (filters.department) vendorsQuery = vendorsQuery.eq('department', filters.department);

    const vendors = await vendorsQuery;
    if (vendors.error) throw dbError('Could not load vendors', vendors.error);
    const byId = new Map((vendors.data ?? []).map((row) => [row.id as string, toVendor(row)]));
    const ids = [...byId.keys()];
    if (ids.length === 0) return [];

    const wantProducts = filters.type !== 'location';
    const wantLocations = filters.type !== 'product';
    const approved = (table: string) =>
      this.db.from(table).select('*').in('vendor_id', ids).eq('review_status', 'approved').eq('active', true);

    const [products, locations, promos, stats] = await Promise.all([
      wantProducts ? approved('vendor_packages') : Promise.resolve({ data: [], error: null }),
      wantLocations ? approved('vendor_locations') : Promise.resolve({ data: [], error: null }),
      this.db.from('vendor_promotions').select('*').in('vendor_id', ids).eq('status', 'approved'),
      vendorResponseStats(this.db, ids),
    ]);
    for (const r of [products, locations, promos]) {
      if (r.error) throw dbError('Could not load listings', r.error);
    }

    const featured = new Set(
      (promos.data ?? [])
        .map(toPromotion)
        .filter((p) => p.live)
        .map((p) => p.packageId ?? p.locationId),
    );

    const vendorCard = (id: string) => {
      const v = byId.get(id)!;
      return {
        id: v.id,
        businessName: v.businessName,
        department: v.department,
        city: v.city,
        logoUrl: v.logoUrl,
        phone: v.phone,
        email: v.email,
        website: v.website,
        instagram: v.instagram,
        responseTime: stats.get(id)?.avgSeconds != null ? humanDuration(stats.get(id)!.avgSeconds!) : '',
        responseRate: stats.get(id)?.rate != null ? Math.round(stats.get(id)!.rate! * 100) : null,
      };
    };

    const listings: Listing[] = [
      ...(locations.data ?? []).map(toLocation).map((l) => ({
        type: 'location' as const,
        id: l.id,
        name: l.name,
        description: l.description,
        imageUrl: l.imageUrl,
        priceCentavos: null,
        currency: 'MXN',
        capacityMin: l.capacityMin,
        capacityMax: l.capacityMax,
        address: l.address,
        city: l.city || byId.get(l.vendorId)!.city,
        featured: featured.has(l.id),
        department: byId.get(l.vendorId)!.department,
        vendor: vendorCard(l.vendorId),
      })),
      ...(products.data ?? []).map(toProduct).map((p) => ({
        type: 'product' as const,
        id: p.id,
        name: p.name,
        description: p.description,
        imageUrl: p.imageUrl,
        priceCentavos: p.priceCentavos,
        currency: p.currency,
        capacityMin: p.capacityMin,
        capacityMax: p.capacityMax,
        address: '',
        city: byId.get(p.vendorId)!.city,
        featured: featured.has(p.id),
        department: byId.get(p.vendorId)!.department,
        vendor: vendorCard(p.vendorId),
      })),
    ];

    const city = filters.city?.trim().toLowerCase();
    const q = filters.q?.trim().toLowerCase();
    const matches = (l: Listing) =>
      (!city ||
        l.city.toLowerCase().includes(city) ||
        byId.get(l.vendor!.id)!.serviceArea.some((a) => a.toLowerCase().includes(city))) &&
      (!q || `${l.name} ${l.description} ${l.vendor!.businessName}`.toLowerCase().includes(q));

    return listings.filter(matches);
  }

  /** One unique view per viewer, listing and day. Lazo products count Buy clicks instead. */
  async recordView(viewerId: string, input: Row): Promise<void> {
    if (input.type === 'lazo') return;
    const { type, listing } = await this.findListing(input);
    const { error } = await this.db.from('vendor_listing_views').insert({
      vendor_id: listing.vendor_id,
      viewer_id: viewerId,
      [type === 'product' ? 'package_id' : 'location_id']: listing.id,
    });
    if (error && error.code !== UNIQUE_VIOLATION) throw dbError('Could not record the view', error);
  }

  /** One click per viewer, product and day on an affiliate product's Buy link. */
  async recordClick(viewerId: string, productId: string): Promise<void> {
    const product = await this.findLazoProduct(productId);
    if (product.sale_type !== 'affiliate') return;
    const { error } = await this.db.from('lazo_product_clicks').insert({ product_id: product.id, viewer_id: viewerId });
    if (error && error.code !== UNIQUE_VIOLATION) throw lazoFail('Could not record the click', error);
  }

  async selections(eventId: string) {
    const [vendorPicks, lazoPicks] = await Promise.all([
      this.db.from('vendor_selections').select('*').eq('event_id', eventId),
      this.db.from('lazo_product_picks').select('*').eq('event_id', eventId),
    ]);
    if (vendorPicks.error) throw dbError('Could not load your picks', vendorPicks.error);
    if (lazoPicks.error && lazoPicks.error.code !== UNDEFINED_TABLE) throw lazoFail('Could not load your picks', lazoPicks.error);

    return [
      ...(vendorPicks.data ?? []).map((row) => ({
        id: row.id as string,
        type: row.package_id ? 'product' : 'location',
        listingId: (row.package_id ?? row.location_id) as string,
        vendorId: row.vendor_id as string | null,
        createdAt: row.created_at as string,
      })),
      ...(lazoPicks.error ? [] : (lazoPicks.data ?? [])).map((row) => ({
        id: row.id as string,
        type: 'lazo',
        listingId: row.product_id as string,
        vendorId: null,
        createdAt: row.created_at as string,
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The caller has already checked they own the event. Picking twice is a no-op. */
  async select(eventId: string, ownerId: string, input: Row) {
    if (input.type === 'lazo') {
      const product = await this.findLazoProduct(text(input.id, 60, 'id', true));
      const { error } = await this.db
        .from('lazo_product_picks')
        .insert({ event_id: eventId, owner_id: ownerId, product_id: product.id });
      if (error && error.code !== UNIQUE_VIOLATION) throw lazoFail('Could not save your pick', error);
      return this.selections(eventId);
    }

    const { type, listing } = await this.findListing(input);
    const column = type === 'product' ? 'package_id' : 'location_id';

    const { error } = await this.db.from('vendor_selections').insert({
      event_id: eventId,
      owner_id: ownerId,
      vendor_id: listing.vendor_id,
      [column]: listing.id,
    });
    if (error && error.code !== UNIQUE_VIOLATION) throw dbError('Could not save your pick', error);

    return this.selections(eventId);
  }

  async unselect(eventId: string, selectionId: string) {
    const { data, error } = await this.db
      .from('vendor_selections')
      .delete()
      .eq('id', selectionId)
      .eq('event_id', eventId)
      .select('id');
    if (error) throw dbError('Could not remove your pick', error);
    if (!data?.length) {
      const own = await this.db
        .from('lazo_product_picks')
        .delete()
        .eq('id', selectionId)
        .eq('event_id', eventId)
        .select('id');
      if (own.error && own.error.code !== UNDEFINED_TABLE) throw lazoFail('Could not remove your pick', own.error);
      if (!own.data?.length) throw new NotFoundException('No such pick');
    }
    return this.selections(eventId);
  }

  /** A Lazo product hosts can see: active. */
  private async findLazoProduct(id: string): Promise<Row> {
    const { data, error } = await this.db
      .from('lazo_products')
      .select('id, sale_type, active')
      .eq('id', id)
      .maybeSingle();
    if (error) throw lazoFail('Could not load the product', error);
    if (!data || data.active === false) throw new NotFoundException('No such product');
    return data;
  }

  /** A listing hosts are allowed to see: approved, active, from an active vendor. */
  private async findListing(input: Row): Promise<{ type: 'product' | 'location'; listing: Row }> {
    const type = oneOf(input.type, ['product', 'location'] as const, 'type');
    const id = text(input.id, 60, 'id', true);
    const table = type === 'product' ? 'vendor_packages' : 'vendor_locations';

    const { data, error } = await this.db
      .from(table)
      .select('id, vendor_id, review_status, active')
      .eq('id', id)
      .maybeSingle();
    if (error) throw dbError('Could not load the listing', error);
    if (!data || data.review_status !== 'approved' || data.active === false) {
      throw new NotFoundException(`No such ${type}`);
    }

    const vendor = await this.db.from('vendors').select('status').eq('id', data.vendor_id).maybeSingle();
    if (vendor.error) throw dbError('Could not load the vendor', vendor.error);
    if (vendor.data?.status !== 'active') throw new NotFoundException(`No such ${type}`);

    return { type, listing: data };
  }

  private get db(): RawClient {
    if (!this.supabase) throw new ServiceUnavailableException('The database is not configured');
    return this.supabase as unknown as RawClient;
  }
}
