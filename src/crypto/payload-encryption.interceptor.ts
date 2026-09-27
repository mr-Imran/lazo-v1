import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';
import { PLAIN_PAYLOAD_KEY } from './plain-payload.decorator.js';
import { PayloadCryptoService, isEnvelope } from './payload-crypto.service.js';
import type { PayloadContext } from './payload-crypto.service.js';

/** Set by a client to say "this body is encrypted, encrypt the reply too". */
export const ENCRYPTION_HEADER = 'x-lazo-encrypted';

/** Only API traffic is wrapped; the static pages are served as-is. */
const API_PREFIX = '/api';

/**
 * Handles both directions of payload encryption in one place.
 *
 * Runs after the guards, so authentication still works off headers alone, and
 * before the handler's parameters are resolved — which is why replacing
 * `request.body` here is enough for @Body() to receive plaintext.
 */
@Injectable()
export class PayloadEncryptionInterceptor implements NestInterceptor {
  constructor(
    private readonly crypto: PayloadCryptoService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http' || !this.crypto.enabled) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path ?? request.url ?? '';

    if (!path.startsWith(API_PREFIX)) {
      return next.handle();
    }

    const isPlain = this.reflector.getAllAndOverride<boolean>(PLAIN_PAYLOAD_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPlain) {
      return next.handle();
    }

    const payload: PayloadContext = { method: request.method, path };
    const declared = request.headers[ENCRYPTION_HEADER];
    const encryptedRequest = isEnvelope(request.body);

    if (declared && !encryptedRequest && hasBody(request)) {
      throw new BadRequestException(
        `${ENCRYPTION_HEADER} was sent but the body is not an encrypted envelope`,
      );
    }

    if (encryptedRequest) {
      // Replace the envelope with the real body before @Body() sees it.
      request.body = this.crypto.decrypt(request.body, payload);
    } else if (this.crypto.mode === 'required') {
      throw new BadRequestException(
        'This endpoint requires an encrypted payload. Send an envelope and the ' +
          `${ENCRYPTION_HEADER} header.`,
      );
    }

    // Reply in kind: encrypted if the caller spoke encrypted, or if the server
    // insists on it. A GET has no body to decrypt, so the header alone opts in.
    const encryptResponse =
      this.crypto.mode === 'required' || encryptedRequest || Boolean(declared);

    if (!encryptResponse) {
      return next.handle();
    }

    return next.handle().pipe(
      map((body) =>
        // @Res() routes resolve to undefined — they wrote the response
        // themselves and there is nothing left to wrap.
        body === undefined ? body : this.crypto.encrypt(body, payload),
      ),
    );
  }
}

function hasBody(request: Request): boolean {
  return request.body !== undefined && request.body !== null && request.method !== 'GET';
}
