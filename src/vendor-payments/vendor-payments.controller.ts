import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { UsersService } from '../users/users.service.js';
import { VendorOrdersService } from './vendor-orders.service.js';
import { VendorPaymentsAdminService } from './vendor-payments-admin.service.js';
import { VendorQuotesService } from './vendor-quotes.service.js';
import type { Row } from './vendor-payments.common.js';

/** The vendor's side: money received through Lazo, quotes they send, orders they fulfil. */
@Controller('api/vendor')
export class VendorPaymentsController {
  constructor(
    private readonly quotes: VendorQuotesService,
    private readonly orders: VendorOrdersService,
  ) {}

  /**
   * Payments overview: hosts pay through Lazo's Stripe, so there is nothing for
   * the vendor to set up — this returns what they have received, Lazo's
   * commission, the net owed to them, and a receipt per order.
   */
  @Get('payments')
  async payments(@CurrentUser('userId') userId: string) {
    return { ...this.orders.config(), summary: await this.orders.vendorSummary(userId) };
  }

  @Get('quotes')
  listQuotes(@CurrentUser('userId') userId: string) {
    return this.quotes.vendorQuotes(userId);
  }

  /** { inquiryId } | { eventId, listingType, listingId }, title, lineItems, amountCentavos, depositCentavos?, validUntil?, note?, send? */
  @Post('quotes')
  createQuote(@CurrentUser('userId') userId: string, @Body() body: Row) {
    return this.quotes.create(userId, body ?? {});
  }

  @Patch('quotes/:id')
  updateQuote(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Row) {
    return this.quotes.update(userId, id, body ?? {});
  }

  @Post('quotes/:id/send')
  @HttpCode(200)
  sendQuote(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.quotes.send(userId, id);
  }

  @Post('quotes/:id/withdraw')
  @HttpCode(200)
  withdrawQuote(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.quotes.withdraw(userId, id);
  }

  @Get('orders')
  listOrders(@CurrentUser('userId') userId: string) {
    return this.orders.vendorOrders(userId);
  }

  /** { status: in_progress | fulfilled } */
  @Post('orders/:id/status')
  @HttpCode(200)
  setStatus(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Row) {
    return this.orders.setFulfilment(userId, id, body ?? {});
  }

  /** { amountCentavos?, reason } — omit the amount for a full refund. */
  @Post('orders/:id/refunds')
  @HttpCode(200)
  refund(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Row) {
    return this.orders.refund(userId, id, body ?? {}, 'vendor');
  }
}

/** The host's side: quotes received for an event, accepting/declining, paying, and the Connect webhook. */
@Controller('api')
export class HostOrdersController {
  constructor(
    private readonly quotes: VendorQuotesService,
    private readonly orders: VendorOrdersService,
    private readonly events: EventsService,
    private readonly users: UsersService,
  ) {}

  @Get('events/:id/quotes')
  async list(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    const event = await this.events.findOneFor(userId, id);
    return { ...(await this.quotes.hostQuotes(event)), payments: this.orders.config() };
  }

  /** → { order } (pending_payment). Then POST …/orders/:orderId/checkout. */
  @Post('events/:id/quotes/:quoteId/accept')
  @HttpCode(200)
  async accept(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('quoteId') quoteId: string) {
    const event = await this.events.findOneFor(userId, id);
    return this.quotes.accept(event, quoteId);
  }

  @Post('events/:id/quotes/:quoteId/decline')
  @HttpCode(200)
  async decline(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('quoteId') quoteId: string) {
    const event = await this.events.findOneFor(userId, id);
    return this.quotes.decline(event, quoteId);
  }

  /** → { url } to Stripe Checkout. */
  @Post('events/:id/orders/:orderId/checkout')
  @HttpCode(200)
  async checkout(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('orderId') orderId: string) {
    const event = await this.events.findOneFor(userId, id);
    const me = await this.users.findOne(userId).catch(() => null);
    return this.orders.checkout(event, orderId, me?.email ?? null);
  }

  @Post('events/:id/orders/:orderId/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('orderId') orderId: string) {
    const event = await this.events.findOneFor(userId, id);
    return this.orders.cancel(event, orderId);
  }

  /** { session: cs_… } after the redirect back. */
  @Post('orders/confirm')
  @HttpCode(200)
  confirm(@CurrentUser('userId') userId: string, @Body() body: Row) {
    return this.orders.confirm(userId, body?.session);
  }

  /** Stripe → here. Public; the Stripe signature is the authentication. Separate from /webhooks/stripe (plans). */
  @Public()
  @PlainPayload()
  @Post('webhooks/stripe-connect')
  @HttpCode(200)
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string | undefined) {
    return this.orders.webhook(req.rawBody, signature);
  }
}

/** Reconciliation. */
@Roles('admin')
@Controller('api/admin/vendor-orders')
export class VendorPaymentsAdminController {
  constructor(
    private readonly admin: VendorPaymentsAdminService,
    private readonly orders: VendorOrdersService,
  ) {}

  /** ?status=&vendorId=&from=YYYY-MM-DD&to=YYYY-MM-DD */
  @Get()
  list(@Query('status') status?: string, @Query('vendorId') vendorId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.admin.list({ status, vendorId, from, to });
  }

  /** Stripe balance transactions vs the database. ?from=&to= (default: last 30 days, max 92). */
  @Get('reconcile')
  reconcile(@Query('from') from?: string, @Query('to') to?: string) {
    return this.admin.reconcile({ from, to });
  }

  @Get('commission')
  commission() {
    return this.admin.commission();
  }

  /** { pct } */
  @Patch('commission')
  setCommission(@Body() body: Row) {
    return this.admin.setCommission(body ?? {});
  }

  /** { amountCentavos?, reason } — an admin refund on any paid order. */
  @Post(':id/refunds')
  @HttpCode(200)
  refund(@CurrentUser('userId') adminId: string, @Param('id') id: string, @Body() body: Row) {
    return this.orders.refund(adminId, id, body ?? {}, 'admin');
  }
}
