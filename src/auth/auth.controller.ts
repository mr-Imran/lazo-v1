import { Controller, Get, Logger } from '@nestjs/common';
import { CurrentUser } from './current-user.decorator.js';
import { Public } from './public.decorator.js';
import { PlainPayload } from '../crypto/plain-payload.decorator.js';

/** What the sign-in / sign-up screens may offer, as configured in Clerk. */
export interface SignInMethods {
  /** Enabled social strategies, e.g. ["oauth_google", "oauth_apple"]. */
  social: string[];
  enterpriseSso: boolean;
  /** Clerk's minimum password length, or null if Clerk did not say. */
  passwordMinLength: number | null;
}

const METHODS_TTL_MS = 5 * 60 * 1000;
const NO_METHODS: SignInMethods = { social: [], enterpriseSso: false, passwordMinLength: null };

interface ClerkEnvironment {
  user_settings?: {
    social?: Record<string, { enabled?: boolean; strategy?: string }>;
    enterprise_sso?: { enabled?: boolean };
    password_settings?: { min_length?: number };
  };
}

@Controller('api/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private methods: { value: SignInMethods; expires: number } | null = null;

  /**
   * The browser needs the publishable key to boot Clerk. It is public by
   * design — only the secret key must stay on the server. `methods` mirrors
   * the Clerk dashboard, so a provider switched on or off there shows up or
   * disappears in the UI without a code change.
   */
  @Public()
  @PlainPayload()
  @Get('config')
  async getConfig(): Promise<{
    publishableKey: string;
    configured: boolean;
    methods: SignInMethods;
  }> {
    const publishableKey = process.env.CLERK_PUBLISHABLE_KEY ?? '';

    return {
      publishableKey,
      configured: Boolean(publishableKey),
      methods: publishableKey ? await this.signInMethods(publishableKey) : NO_METHODS,
    };
  }

  @Get('session')
  getSession(@CurrentUser('userId') userId: string): { userId: string } {
    return { userId };
  }

  /**
   * Reads the instance's public environment from Clerk's Frontend API — the
   * same document clerk-js loads in the browser. Cached briefly; on failure the
   * UI falls back to email + password, which every instance here supports.
   */
  private async signInMethods(publishableKey: string): Promise<SignInMethods> {
    if (this.methods && this.methods.expires > Date.now()) {
      return this.methods.value;
    }

    try {
      // pk_test_<base64("<frontend api host>$")>
      const host = Buffer.from(publishableKey.split('_')[2] ?? '', 'base64')
        .toString('utf8')
        .replace(/\$$/, '');
      const res = await fetch(`https://${host}/v1/environment`);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const settings = ((await res.json()) as ClerkEnvironment).user_settings ?? {};
      const value: SignInMethods = {
        social: Object.entries(settings.social ?? {})
          .filter(([, provider]) => provider.enabled)
          .map(([key, provider]) => provider.strategy ?? key),
        enterpriseSso: Boolean(settings.enterprise_sso?.enabled),
        passwordMinLength: settings.password_settings?.min_length ?? null,
      };

      this.methods = { value, expires: Date.now() + METHODS_TTL_MS };

      return value;
    } catch (error) {
      this.logger.warn(
        `Could not read sign-in methods from Clerk: ${error instanceof Error ? error.message : error}`,
      );

      return NO_METHODS;
    }
  }
}
