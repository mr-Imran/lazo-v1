import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { UserRoleService } from '../auth/user-role.service.js';
import { DynamicService } from './dynamic.service.js';
import type { Caller, Page } from './dynamic.service.js';
import { RESOURCES } from './resources.registry.js';
import { ALL_OPERATIONS } from './resource.types.js';

/**
 * One controller for every resource in the registry.
 *
 * `:resource` is resolved against the registry, so an unknown name is a 404
 * rather than a route that happens not to exist. Adding a table to the API is
 * a registry entry; nothing here changes.
 */
@Controller('api/v1')
export class DynamicController {
  constructor(
    private readonly dynamic: DynamicService,
    private readonly roles: UserRoleService,
  ) {}

  /**
   * The registry itself: resources, fields, types, constraints and which
   * operations each supports. A client can build forms and validation from
   * this instead of hard-coding a copy of the schema.
   */
  @Get('_schema')
  async schema(
    @CurrentUser('userId') userId: string,
    @CurrentUser('sessionClaims') claims: unknown,
  ): Promise<{ resources: unknown[] }> {
    const role = await this.roles.resolve(userId, claims);

    return {
      resources: RESOURCES.filter(
        (resource) =>
          role === 'admin' || !(resource.roles?.includes('admin') || resource.scope.by === 'admin'),
      ).map((resource) => ({
        name: resource.name,
        url: `/api/v1/${resource.name}`,
        scope: resource.scope.by,
        operations: resource.operations ?? ALL_OPERATIONS,
        fields: resource.fields,
        defaultSort: resource.defaultSort ?? { column: 'created_at', ascending: false },
      })),
    };
  }

  @Get(':resource')
  async list(
    @Param('resource') resource: string,
    @Query() query: Record<string, unknown>,
    @CurrentUser('userId') userId: string,
    @CurrentUser('sessionClaims') claims: unknown,
  ): Promise<Page> {
    return this.dynamic.list(resource, query, await this.caller(userId, claims));
  }

  @Get(':resource/:id')
  async read(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @CurrentUser('sessionClaims') claims: unknown,
  ): Promise<Record<string, unknown>> {
    return this.dynamic.read(resource, id, await this.caller(userId, claims));
  }

  @Post(':resource')
  async create(
    @Param('resource') resource: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser('userId') userId: string,
    @CurrentUser('sessionClaims') claims: unknown,
  ): Promise<Record<string, unknown>> {
    return this.dynamic.create(resource, body ?? {}, await this.caller(userId, claims));
  }

  @Patch(':resource/:id')
  async update(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser('userId') userId: string,
    @CurrentUser('sessionClaims') claims: unknown,
  ): Promise<Record<string, unknown>> {
    return this.dynamic.update(resource, id, body ?? {}, await this.caller(userId, claims));
  }

  @Delete(':resource/:id')
  @HttpCode(204)
  async remove(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @CurrentUser('sessionClaims') claims: unknown,
  ): Promise<void> {
    return this.dynamic.remove(resource, id, await this.caller(userId, claims));
  }

  /** Resolves role and event scope once, for this request only. */
  private async caller(userId: string, claims: unknown): Promise<Caller> {
    return this.dynamic.resolveCaller(userId, await this.roles.resolve(userId, claims));
  }
}
