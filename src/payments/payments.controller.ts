import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { UsersService } from '../users/users.service.js';
import { PaymentsService } from './payments.service.js';

type Body = Record<string, unknown>;

@Controller('api')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly events: EventsService,
    private readonly users: UsersService,
  ) {}

  /** Plans and prices, for the pricing page. Public. */
  @Public()
  @PlainPayload()
  @Get('plans')
  async plans() {
    return { plans: await this.payments.plans(), payments: await this.payments.config() };
  }

  /** Which gateways are on offer and configured, so the UI shows only what works. Public: booleans only. */
  @Public()
  @PlainPayload()
  @Get('payments/config')
  config() {
    return this.payments.config();
  }

  /** { product, gateway? } → { url, attemptId, gateway } to send the host to checkout. */
  @Post('events/:id/checkout')
  @HttpCode(200)
  async checkout(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    const event = await this.events.findOneFor(userId, id);
    const me = await this.users.findOne(userId).catch(() => null);
    return this.payments.checkout(event, body ?? {}, me?.email ?? null);
  }

  /**
   * After the redirect back. Stripe: { session: "cs_…" }. Mercado Pago:
   * { gateway: "mercadopago", paymentId } or ?gateway=mercadopago&payment_id=….
   */
  @Post('checkout/confirm')
  @HttpCode(200)
  confirm(@CurrentUser('userId') userId: string, @Body() body: Body, @Query() query: Record<string, unknown>) {
    const gateway = String(body?.gateway ?? query?.gateway ?? '').toLowerCase();
    if (gateway === 'mercadopago') {
      return this.payments.confirmMercadoPago(userId, body?.paymentId ?? body?.payment_id ?? query?.payment_id);
    }
    return this.payments.confirm(userId, body?.session ?? query?.session);
  }

  @Get('payments')
  history(@CurrentUser('userId') userId: string, @Query('eventId') eventId?: string) {
    return this.payments.history(userId, eventId);
  }

  /** Stripe → here. Public; the Stripe signature is the authentication. */
  @Public()
  @PlainPayload()
  @Post('webhooks/stripe')
  @HttpCode(200)
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature: string | undefined) {
    return this.payments.webhook(req.rawBody, signature);
  }

  /** Mercado Pago → here. Public; the x-signature HMAC is the authentication. */
  @Public()
  @PlainPayload()
  @Post('webhooks/mercadopago')
  @HttpCode(200)
  mercadoPagoWebhook(
    @Body() body: Body,
    @Query() query: Record<string, unknown>,
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    return this.payments.mercadoPagoWebhook(body ?? {}, query ?? {}, { signature, requestId });
  }
}

@Roles('admin')
@Controller('api/admin')
export class PaymentsAdminController {
  constructor(private readonly payments: PaymentsService) {}

  @Get('payments')
  list() {
    return this.payments.adminList();
  }

  /** DB settled attempts vs the gateway's records for a date range. ?from=YYYY-MM-DD&to=YYYY-MM-DD&gateway=stripe|mercadopago */
  @Get('payments/reconcile')
  reconcile(@Query('from') from?: string, @Query('to') to?: string, @Query('gateway') gateway?: string) {
    return this.payments.adminReconcile(from, to, gateway);
  }

  /** Re-read this purchase from its gateway and apply it. */
  @Post('payments/:id/sync')
  @HttpCode(200)
  sync(@Param('id') id: string) {
    return this.payments.adminSync(id);
  }

  /** { amountCentavos?, reason } → refund on the gateway that took the payment. Full refunds take the plan back off. */
  @Post('payments/:id/refund')
  @HttpCode(200)
  refund(@Param('id') id: string, @Body() body: Body) {
    return this.payments.adminRefund(id, body ?? {});
  }

  @Get('services')
  services() {
    return this.payments.services();
  }

  /** { name?, priceCentavos?, active? } */
  @Patch('services/:key')
  update(@Param('key') key: string, @Body() body: Body) {
    return this.payments.updateService(key, body ?? {});
  }
}
