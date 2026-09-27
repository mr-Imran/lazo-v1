import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { join } from 'node:path';
import { AppService } from './app.service.js';
import { CurrentUser } from './auth/current-user.decorator.js';
import { Public } from './auth/public.decorator.js';

// Resolves to <project root>/public, from dist/ at runtime.
const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Public()
  @Get('login')
  login(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'login.html'));
  }

  @Public()
  @Get('dashboard')
  dashboard(@Res() res: Response): void {
    // The shell is public; Clerk gates it in the browser and the /api/events
    // routes stay guarded, so nothing is exposed by serving the markup.
    res.sendFile(join(PUBLIC_DIR, 'dashboard.html'));
  }

  @Public()
  @Get('event')
  newEvent(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'event.html'));
  }

  // The dashboard is one app with hash routing; /keys is a friendly entry
  // point that opens it on the keys section.
  @Public()
  @Get('keys')
  apiKeys(@Res() res: Response): void {
    res.sendFile(join(PUBLIC_DIR, 'dashboard.html'));
  }

  // Lives under /api so payload encryption covers it — the interceptor keys off
  // that prefix. Duplicates GET /api/auth/session; kept for convenience.
  @Get('api/me')
  getMe(@CurrentUser('userId') userId: string): { userId: string } {
    return { userId };
  }
}
