import { SetMetadata } from '@nestjs/common';

export const PLAIN_PAYLOAD_KEY = 'plainPayload';

/**
 * Opts a route out of payload encryption, even in "required" mode.
 *
 * Reserved for the handful of endpoints a client must be able to call before it
 * can encrypt anything — configuration and the route index. Never put anything
 * user-specific behind this.
 */
export const PlainPayload = () => SetMetadata(PLAIN_PAYLOAD_KEY, true);
