import {
  BadRequestException,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { verifyWebhook } from '@clerk/express/webhooks';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { UsersService } from './users.service.js';

/**
 * Clerk → public.users, for changes that do not pass through the frontend
 * (dashboard edits, profile updates, deletions).
 *
 * Public because Clerk has no session; authenticity comes from the Svix
 * signature instead, checked against CLERK_WEBHOOK_SIGNING_SECRET.
 * Point the endpoint at https://<api host>/api/webhooks/clerk and subscribe
 * to user.created, user.updated and user.deleted.
 */
@Controller('api/webhooks/clerk')
export class ClerkWebhookController {
  private readonly logger = new Logger(ClerkWebhookController.name);

  constructor(private readonly users: UsersService) {}

  @Public()
  @PlainPayload()
  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>): Promise<{ received: true }> {
    if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) {
      throw new ServiceUnavailableException('CLERK_WEBHOOK_SIGNING_SECRET is not set');
    }

    // The signature covers the exact bytes Clerk sent. Hand those over rather
    // than the parsed JSON, which would be re-serialized and could differ.
    if (req.rawBody) {
      req.body = req.rawBody;
    }

    let event: Awaited<ReturnType<typeof verifyWebhook>>;

    try {
      event = await verifyWebhook(req);
    } catch {
      throw new BadRequestException('Webhook signature verification failed');
    }

    switch (event.type) {
      case 'user.created':
      case 'user.updated':
        // Re-read from Clerk instead of trusting the payload's copy, so the
        // mirror has one mapping and never goes backwards on a late delivery.
        await this.users.syncFromClerk(event.data.id);
        break;
      case 'user.deleted':
        if (event.data.id) {
          await this.users.remove(event.data.id);
        }
        break;
      default:
        this.logger.debug(`Ignoring Clerk webhook ${event.type}`);
    }

    return { received: true };
  }
}
