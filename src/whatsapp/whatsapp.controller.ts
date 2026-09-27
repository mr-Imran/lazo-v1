import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { EventsService } from '../events/events.service.js';
import { WhatsAppService } from './whatsapp.service.js';

type Body = Record<string, unknown>;

/** Template sends to a host's guests. Owner-only, Premium plan. */
@Controller('api/events/:id/whatsapp')
export class WhatsAppController {
  constructor(
    private readonly events: EventsService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  @Get()
  async overview(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.whatsapp.overview(await this.events.findOneFor(userId, id));
  }

  /** ?templateId&audience → reach and the first recipient's rendered text. */
  @Get('preview')
  async preview(@CurrentUser('userId') userId: string, @Param('id') id: string, @Query('templateId') templateId: string, @Query('audience') audience: string) {
    return this.whatsapp.preview(await this.events.findOneFor(userId, id), templateId, audience);
  }

  /** { templateId, audience, values? } */
  @Post('send')
  @HttpCode(200)
  async send(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.whatsapp.send(await this.events.findOneFor(userId, id), body ?? {});
  }

  /** { consent: boolean } — the host records consent given in person. */
  @Patch('consent/:householdId')
  async consent(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('householdId') householdId: string, @Body() body: Body) {
    return this.whatsapp.setConsent(await this.events.findOneFor(userId, id), householdId, body?.consent);
  }
}

/** Public config booleans, and Meta's webhook. */
@Controller('api')
export class WhatsAppPublicController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  @Public()
  @PlainPayload()
  @Get('whatsapp/config')
  config() {
    return this.whatsapp.config();
  }

  /** Meta's subscription handshake. Must answer with the plain challenge string. */
  @Public()
  @PlainPayload()
  @Get('webhooks/whatsapp')
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string) {
    return this.whatsapp.verify(mode, token, challenge);
  }

  /** Meta → here. Public; X-Hub-Signature-256 with the app secret is the authentication. */
  @Public()
  @PlainPayload()
  @Post('webhooks/whatsapp')
  @HttpCode(200)
  webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string | undefined) {
    return this.whatsapp.webhook(req.rawBody, signature);
  }
}

@Roles('admin')
@Controller('api/admin/whatsapp')
export class WhatsAppAdminController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  @Get()
  overview() {
    return this.whatsapp.adminOverview();
  }

  @Post('templates/sync')
  @HttpCode(200)
  sync() {
    return this.whatsapp.syncTemplates();
  }

  @Post('templates/:templateId/submit')
  @HttpCode(200)
  submit(@Param('templateId') templateId: string) {
    return this.whatsapp.submitTemplate(templateId);
  }
}
