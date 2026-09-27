import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { FulfilmentService } from './fulfilment.service.js';

type Body = Record<string, unknown>;

/** Where partners post status updates for an order, built from this request's host. */
function statusUrl(req: Request) {
  const base = (process.env.API_PUBLIC_URL ?? `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return (orderId: string) => `${base}/api/partners/fulfilment/${orderId}/status`;
}

/** Partner orders for one event. Owner-only. */
@Controller('api/events/:id/fulfilment')
export class EventFulfilmentController {
  constructor(
    private readonly events: EventsService,
    private readonly fulfilment: FulfilmentService,
  ) {}

  private own(userId: string, id: string) {
    return this.events.findOneFor(userId, id);
  }

  @Get()
  async list(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.fulfilment.list(await this.own(userId, id));
  }

  /** ?city= → partners and products that actually deliver there. */
  @Get('options')
  async options(@CurrentUser('userId') userId: string, @Param('id') id: string, @Query('city') city: string | undefined) {
    await this.own(userId, id);
    return this.fulfilment.options(city);
  }

  /** { partnerId, productKey, quantity, city, deliveryAddress?, neededBy?, notes? } */
  @Post('orders')
  async create(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body, @Req() req: Request) {
    return this.fulfilment.create(await this.own(userId, id), body ?? {}, statusUrl(req));
  }

  /** { reason? } — only while submitted or confirmed. */
  @Post('orders/:orderId/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('orderId') orderId: string, @Body() body: Body, @Req() req: Request) {
    return this.fulfilment.cancel(await this.own(userId, id), orderId, body ?? {}, statusUrl(req));
  }
}

/**
 * Partners report progress here. Public, no Clerk session: the raw JSON body
 * is signed with the partner's secret (X-Lazo-Signature: sha256=<hmac hex>).
 */
@Controller('api/partners/fulfilment')
export class PartnerFulfilmentController {
  constructor(private readonly fulfilment: FulfilmentService) {}

  @Public()
  @PlainPayload()
  @Post(':orderId/status')
  @HttpCode(200)
  status(@Param('orderId') orderId: string, @Req() req: RawBodyRequest<Request>, @Headers('x-lazo-signature') signature: string | undefined) {
    return this.fulfilment.partnerStatus(orderId, req.rawBody, signature);
  }
}

@Roles('admin')
@Controller('api/admin/fulfilment')
export class FulfilmentAdminController {
  constructor(private readonly fulfilment: FulfilmentService) {}

  @Get('partners')
  partners() {
    return this.fulfilment.adminPartners();
  }

  @Post('partners')
  createPartner(@Body() body: Body) {
    return this.fulfilment.adminCreatePartner(body ?? {});
  }

  @Patch('partners/:partnerId')
  updatePartner(@Param('partnerId') partnerId: string, @Body() body: Body) {
    return this.fulfilment.adminUpdatePartner(partnerId, body ?? {});
  }

  @Delete('partners/:partnerId')
  removePartner(@Param('partnerId') partnerId: string) {
    return this.fulfilment.adminRemovePartner(partnerId);
  }

  @Get('orders')
  orders() {
    return this.fulfilment.adminOrders();
  }

  /** { status?, note?, partnerReference?, paymentStatus? } */
  @Patch('orders/:orderId')
  updateOrder(@Param('orderId') orderId: string, @Body() body: Body) {
    return this.fulfilment.adminUpdateOrder(orderId, body ?? {});
  }
}
