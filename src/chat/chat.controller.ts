import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { UserRoleService } from '../auth/user-role.service.js';
import { getAuthContext } from '../auth/auth-context.js';
import { ChatService, MAX_CHAT_FILE_BYTES, visitorId } from './chat.service.js';
import type { UploadedFile as ChatFile } from './chat.service.js';
import { ChatEventsService } from './chat.events.js';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { SitesService } from '../sites/sites.service.js';

type Body = Record<string, unknown>;

/** Host ↔ vendor and support conversations. Every route needs a session. */
@Controller('api/chats')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly roles: UserRoleService,
    private readonly events: ChatEventsService,
  ) {}

  /**
   * Server-sent events for my conversations: `message` and `conversation`
   * events as they happen. Opened with fetch + Authorization (EventSource
   * can't send headers). Admins also hear everything on the 'admin' channel.
   */
  @PlainPayload()
  @Get('stream')
  async stream(@Req() req: Request, @CurrentUser('userId') userId: string, @Res() res: Response) {
    const caller = await this.caller(req, userId);
    this.events.stream(res, caller.isAdmin ? [userId, 'admin'] : [userId, 'presence:admin']);
  }

  /** Admin powers need a live session (never an API key), same rule as RolesGuard. */
  private async caller(req: Request, userId: string) {
    const auth = getAuthContext(req);
    const isAdmin = auth?.via !== 'apiKey' && (await this.roles.resolve(userId, auth?.sessionClaims)) === 'admin';
    return { userId, isAdmin };
  }

  @Get()
  async inbox(@Req() req: Request, @CurrentUser('userId') userId: string) {
    return this.chat.inbox(await this.caller(req, userId));
  }

  /** Is Lazo support online, and (with ?vendorId=) is that vendor? */
  @Public()
  @PlainPayload()
  @Get('presence')
  presence(@Query('vendorId') vendorId?: string) {
    return this.chat.presence(vendorId);
  }

  @Get('shortcuts')
  async shortcuts(@Req() req: Request, @CurrentUser('userId') userId: string) {
    return this.chat.shortcuts(await this.caller(req, userId));
  }

  /** { shortcut, body } */
  @Post('shortcuts')
  async addShortcut(@Req() req: Request, @CurrentUser('userId') userId: string, @Body() body: Body) {
    return this.chat.addShortcut(await this.caller(req, userId), body ?? {});
  }

  @Post('shortcuts/:id/delete')
  @HttpCode(200)
  async removeShortcut(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.chat.removeShortcut(await this.caller(req, userId), id);
  }

  @Post(':id/typing')
  @HttpCode(200)
  async typing(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.chat.typing(await this.caller(req, userId), id, body ?? {});
  }

  @Post(':id/rate')
  @HttpCode(200)
  async rate(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.chat.rate(await this.caller(req, userId), id, body ?? {});
  }

  @Post(':id/transcript')
  @HttpCode(200)
  async transcript(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.chat.transcript(await this.caller(req, userId), id, body ?? {});
  }

  /** Admin: { release?: true } to hand a support thread back. */
  @Roles('admin')
  @Post(':id/assign')
  @HttpCode(200)
  assign(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.chat.assign(userId, id, body ?? {});
  }

  /** { kind: 'vendor', eventId, vendorId } or { kind: 'support', eventId?, subject? } */
  @Post()
  @HttpCode(200)
  async start(@Req() req: Request, @CurrentUser('userId') userId: string, @Body() body: Body) {
    return this.chat.start(await this.caller(req, userId), body ?? {});
  }

  @Get(':id')
  async thread(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string, @Query('since') since?: string) {
    return this.chat.thread(await this.caller(req, userId), id, since);
  }

  @Post(':id/messages')
  async send(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.chat.send(await this.caller(req, userId), id, body ?? {});
  }

  @Post(':id/close')
  @HttpCode(200)
  async close(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.chat.close(await this.caller(req, userId), id);
  }

  /** multipart "file" (JPEG/PNG/WebP/PDF, <= 10 MB) -> { attachment } to include in a message. */
  @PlainPayload()
  @Post(':id/attachments')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CHAT_FILE_BYTES, files: 1 } }))
  async attach(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string, @UploadedFile() file: ChatFile | undefined) {
    return this.chat.upload(await this.caller(req, userId), id, file);
  }

  /** Vendor: { title, lineItems, amountCentavos, depositCentavos?, validUntil?, note? } -> an offer card in the thread. */
  @Post(':id/offer')
  @HttpCode(200)
  async offer(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.chat.offer(await this.caller(req, userId), id, body ?? {});
  }

  /** { starred: boolean } */
  @Post(':id/star')
  @HttpCode(200)
  async star(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.chat.star(await this.caller(req, userId), id, body ?? {});
  }

  /** { archived: boolean } */
  @Post(':id/archive')
  @HttpCode(200)
  async archive(@Req() req: Request, @CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.chat.archive(await this.caller(req, userId), id, body ?? {});
  }
}

@Roles('admin')
@Controller('api/admin/chats')
export class ChatAdminController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  list(@Query('kind') kind?: string) {
    return this.chat.adminList(kind);
  }

  /** JSONL of every message for training. ?anonymize=1 also drops event and vendor ids. */
  @Get('export')
  async export(@Query('anonymize') anonymize: string | undefined, @Res() res: Response) {
    const body = await this.chat.exportJsonl(anonymize === '1' || anonymize === 'true');
    res
      .status(200)
      .type('application/x-ndjson; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="lazo-chats-${new Date().toISOString().slice(0, 10)}.jsonl"`)
      .send(body);
  }
}

/**
 * Chat without an account: the browser sends X-Visitor-Token (random, kept
 * in localStorage) and becomes 'visitor:<hash>'. Support threads with Lazo
 * from any page; guest threads with the hosts of a live event site (which
 * also need the site token when the site is private).
 */
@Controller('api/public/chats')
export class PublicChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly sites: SitesService,
    private readonly events: ChatEventsService,
  ) {}

  private caller(token: string | undefined) {
    return { userId: visitorId(token), isAdmin: false };
  }

  @Public()
  @PlainPayload()
  @Get('stream')
  stream(@Headers('x-visitor-token') token: string | undefined, @Res() res: Response) {
    this.events.stream(res, [visitorId(token), 'presence:admin']);
  }

  @Public()
  @PlainPayload()
  @Get()
  inbox(@Headers('x-visitor-token') token: string | undefined) {
    return this.chat.inbox(this.caller(token));
  }

  /** { kind: 'support', name?, email? } or { kind: 'guest', slug, name?, email? } */
  @Public()
  @PlainPayload()
  @Post()
  @HttpCode(200)
  async start(@Headers('x-visitor-token') token: string | undefined, @Headers('x-site-token') siteToken: string | undefined, @Body() body: Body) {
    if (body?.kind === 'guest') await this.sites.openGate(String(body.slug ?? ''), siteToken);
    if (body?.kind !== 'guest' && body?.kind !== 'support') throw new BadRequestException('kind must be support or guest');
    return this.chat.start(this.caller(token), body);
  }

  @Public()
  @PlainPayload()
  @Get(':id')
  thread(@Headers('x-visitor-token') token: string | undefined, @Param('id') id: string, @Query('since') since?: string) {
    return this.chat.thread(this.caller(token), id, since);
  }

  @Public()
  @PlainPayload()
  @Post(':id/messages')
  async send(@Headers('x-visitor-token') token: string | undefined, @Param('id') id: string, @Body() body: Body) {
    const caller = this.caller(token);
    if (body?.context && typeof body.context === 'object') await this.chat.context(caller, id, body.context as Body);
    return this.chat.send(caller, id, body ?? {});
  }

  @Public()
  @PlainPayload()
  @Post(':id/typing')
  @HttpCode(200)
  typing(@Headers('x-visitor-token') token: string | undefined, @Param('id') id: string, @Body() body: Body) {
    return this.chat.typing(this.caller(token), id, body ?? {});
  }

  @Public()
  @PlainPayload()
  @Post(':id/rate')
  @HttpCode(200)
  rate(@Headers('x-visitor-token') token: string | undefined, @Param('id') id: string, @Body() body: Body) {
    return this.chat.rate(this.caller(token), id, body ?? {});
  }

  @Public()
  @PlainPayload()
  @Post(':id/transcript')
  @HttpCode(200)
  transcript(@Headers('x-visitor-token') token: string | undefined, @Param('id') id: string, @Body() body: Body) {
    return this.chat.transcript(this.caller(token), id, body ?? {});
  }
}
