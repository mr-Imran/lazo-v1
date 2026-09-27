import { Inject, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { SUPABASE_CLIENT } from '../supabase/supabase.provider.js';
import type { LazoSupabaseClient } from '../supabase/supabase.provider.js';
import { dbError, requireDb, s, sn, stripeClient, vendorFor } from './vendor-payments.common.js';
import type { Row } from './vendor-payments.common.js';

export interface ConnectStatus {
  configured: boolean;
  accountId: string | null;
  onboardingStatus: 'pending' | 'complete' | 'restricted';
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  disabledReason: string | null;
  currentlyDue: string[];
  syncedAt: string | null;
}

/**
 * Stripe Connect Express onboarding for vendors. Lazo is the platform; each
 * vendor gets an Express account (country MX, MXN) that receives destination
 * charges. What we store on vendors.* is a cache of Stripe's answer, refreshed
 * on demand (?refresh=1) and by the account.updated webhook.
 */
@Injectable()
export class VendorConnectService {
  private readonly logger = new Logger(VendorConnectService.name);
  private readonly stripe = stripeClient();

  constructor(@Inject(SUPABASE_CLIENT) private readonly supabase: LazoSupabaseClient | null) {}

  /** The vendor's onboarding state, from our cache or (refresh) from Stripe. */
  async status(ownerId: string, refresh = false): Promise<ConnectStatus> {
    const vendor = await vendorFor(this.db, ownerId);
    const accountId = sn(vendor.stripe_account_id);
    if (!this.stripe || !accountId) return this.cached(vendor);
    if (!refresh) return this.cached(vendor);
    const account = await this.stripe.accounts.retrieve(accountId);
    return this.syncAccount(account, s(vendor.id));
  }



  /** Writes Stripe's view of an account onto the vendor row. Used by refresh and the webhook. */
  async syncAccount(account: Stripe.Account, vendorId?: string): Promise<ConnectStatus> {
    const disabledReason = account.requirements?.disabled_reason ?? null;
    const chargesEnabled = account.charges_enabled === true;
    const payoutsEnabled = account.payouts_enabled === true;
    const detailsSubmitted = account.details_submitted === true;
    const onboardingStatus: ConnectStatus['onboardingStatus'] =
      chargesEnabled && payoutsEnabled ? 'complete' : detailsSubmitted || disabledReason ? 'restricted' : 'pending';
    const syncedAt = new Date().toISOString();

    let q = this.db
      .from('vendors')
      .update({
        stripe_onboarding_status: onboardingStatus,
        charges_enabled: chargesEnabled,
        payouts_enabled: payoutsEnabled,
        stripe_synced_at: syncedAt,
        updated_at: syncedAt,
      });
    q = vendorId ? q.eq('id', vendorId) : q.eq('stripe_account_id', account.id);
    const { error } = await q;
    if (error) throw dbError('Could not save the Stripe account status', error);

    return {
      configured: true,
      accountId: account.id,
      onboardingStatus,
      chargesEnabled,
      payoutsEnabled,
      detailsSubmitted,
      disabledReason,
      currentlyDue: account.requirements?.currently_due ?? [],
      syncedAt,
    };
  }

  private cached(vendor: Row): ConnectStatus {
    return {
      configured: Boolean(this.stripe),
      accountId: sn(vendor.stripe_account_id),
      onboardingStatus: (s(vendor.stripe_onboarding_status) || 'pending') as ConnectStatus['onboardingStatus'],
      chargesEnabled: vendor.charges_enabled === true,
      payoutsEnabled: vendor.payouts_enabled === true,
      detailsSubmitted: false,
      disabledReason: null,
      currentlyDue: [],
      syncedAt: sn(vendor.stripe_synced_at),
    };
  }

  private get db() {
    return requireDb(this.supabase);
  }
}
