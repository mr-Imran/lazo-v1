import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ApiKeysService } from './api-keys.service.js';
import type { ApiKeyRecord, CreateApiKeyInput, CreatedApiKey } from './api-key.entity.js';

/**
 * Key management, scoped to the caller.
 *
 * Minting and revoking require a real browser session: a key may not create
 * more keys, so one leaked key cannot be used to entrench access.
 */
@Controller('api/keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  async list(@CurrentUser('userId') userId: string): Promise<{ keys: ApiKeyRecord[] }> {
    return { keys: await this.keys.findAllFor(userId) };
  }

  @Post()
  create(
    @CurrentUser('via') via: string,
    @CurrentUser('userId') userId: string,
    @Body() body: CreateApiKeyInput,
  ): Promise<CreatedApiKey> {
    requireSession(via);

    return this.keys.create(userId, body ?? {});
  }

  /** Keeps the row, so the audit trail survives. Permanent. */
  @Post(':id/revoke')
  revoke(
    @CurrentUser('via') via: string,
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<ApiKeyRecord> {
    requireSession(via);

    return this.keys.revoke(userId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser('via') via: string,
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<void> {
    requireSession(via);

    return this.keys.remove(userId, id);
  }
}

function requireSession(via: string): void {
  if (via !== 'session') {
    throw new ForbiddenException('API keys can only be managed from a signed-in session');
  }
}
