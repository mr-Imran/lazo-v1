import { Controller, Get, Injectable, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Req } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth/public.decorator.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import type { AppRole } from '../auth/roles.decorator.js';
import { PLAIN_PAYLOAD_KEY } from '../crypto/plain-payload.decorator.js';
import { Public } from '../auth/public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';
import { ENCRYPTION_HEADER, PayloadCryptoService } from '../crypto/index.js';

export interface ApiRoute {
  method: string;
  url: string;
  auth: 'public' | 'session' | AppRole;
  encrypted: boolean;
}

export interface ApiIndex {
  baseUrl: string;
  encryption: {
    mode: string;
    header: string;
    envelope: string;
  };
  routes: ApiRoute[];
}

/**
 * The API's own index: every route, its URL, what it needs to be called, and
 * whether its payload is wrapped. Read off the decorators at request time, so
 * it cannot drift from the real routing table the way a hand-kept list would.
 */
@Injectable()
@Controller('api')
export class ApiController {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly crypto: PayloadCryptoService,
  ) {}

  @Public()
  @PlainPayload()
  @Get()
  index(@Req() request: Request): ApiIndex {
    return {
      baseUrl: `${request.protocol}://${request.get('host') ?? 'localhost'}`,
      encryption: {
        mode: this.crypto.mode,
        header: ENCRYPTION_HEADER,
        envelope: '{ "enc": "v1", "ts": <ms>, "iv": <b64>, "data": <b64>, "tag": <b64> }',
      },
      routes: this.collect(),
    };
  }

  private collect(): ApiRoute[] {
    const routes: ApiRoute[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const { instance, metatype } = wrapper;

      if (!instance || !metatype) {
        continue;
      }

      const prefix = normalise(this.reflector.get<string>(PATH_METADATA, metatype) ?? '');
      const prototype = Object.getPrototypeOf(instance) as object;

      for (const key of Object.getOwnPropertyNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[key];

        if (key === 'constructor' || typeof handler !== 'function') {
          continue;
        }

        const verb = this.reflector.get<RequestMethod>(METHOD_METADATA, handler);
        const suffix = this.reflector.get<string>(PATH_METADATA, handler);

        if (verb === undefined || suffix === undefined) {
          continue;
        }

        const url = join(prefix, normalise(suffix));

        // The index describes the API, not the static pages.
        if (!url.startsWith('/api')) {
          continue;
        }

        routes.push({
          method: RequestMethod[verb] ?? String(verb),
          url,
          auth: this.authOf(handler, metatype),
          encrypted: this.encryptedOf(handler, metatype),
        });
      }
    }

    return routes.sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
  }

  private authOf(handler: unknown, metatype: unknown): ApiRoute['auth'] {
    const targets = [handler, metatype] as Parameters<Reflector['getAllAndOverride']>[1];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return 'public';
    }

    const roles = this.reflector.getAllAndOverride<AppRole[]>(ROLES_KEY, targets);

    return roles?.length ? roles[0]! : 'session';
  }

  private encryptedOf(handler: unknown, metatype: unknown): boolean {
    if (!this.crypto.enabled) {
      return false;
    }

    const targets = [handler, metatype] as Parameters<Reflector['getAllAndOverride']>[1];

    return !this.reflector.getAllAndOverride<boolean>(PLAIN_PAYLOAD_KEY, targets);
  }
}

const normalise = (path: string): string =>
  path === '/' || path === '' ? '' : `/${path.replace(/^\/+|\/+$/g, '')}`;

const join = (prefix: string, suffix: string): string => `${prefix}${suffix}` || '/';
