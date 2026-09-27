import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route (or a whole controller) out of the global Clerk guard.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
