import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { EventsService } from '../events/events.service.js';
import { InvoicesService } from './invoices.service.js';

type Body = Record<string, unknown>;

/** A host's receipts for paid plans. Owner-only; the invoice page prints them. */
@Controller('api')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly events: EventsService,
  ) {}

  @Get('events/:id/invoices')
  async forEvent(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    const event = await this.events.findOneFor(userId, id);
    return this.invoices.listForEvent(userId, event.id);
  }

  @Get('invoices/:id')
  findOne(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.invoices.findOne(userId, id);
  }

  /** { rfc?, razonSocial?, cfdiUso? } — fiscal data for a factura (no CFDI is stamped). */
  @Patch('invoices/:id/billing')
  billing(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.invoices.updateBilling(userId, id, body ?? {});
  }
}

@Roles('admin')
@Controller('api/admin')
export class InvoicesAdminController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('invoices')
  list() {
    return this.invoices.adminList();
  }
}
