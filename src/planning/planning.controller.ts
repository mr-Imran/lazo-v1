import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { EventsService } from '../events/events.service.js';
import { PlanningService } from './planning.service.js';

type Body = Record<string, unknown>;

/** The host's planning workspace for one event. Owner-only. */
@Controller('api/events/:id')
export class PlanningController {
  constructor(
    private readonly planning: PlanningService,
    private readonly events: EventsService,
  ) {}

  private async ctx(userId: string, id: string) {
    const e = await this.events.findOneFor(userId, id);
    return { id: e.id, mode: e.mode, date: e.date, ownerId: e.ownerId };
  }

  @Get('planning')
  async overview(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.planning.overview(await this.ctx(userId, id));
  }

  @Get('stats')
  async stats(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.planning.stats(await this.ctx(userId, id));
  }

  @Post('tasks/suggested')
  @HttpCode(200)
  async suggested(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.planning.addSuggested(await this.ctx(userId, id));
  }

  /** { title, category?, dueDate?, notes? } */
  @Post('tasks')
  async createTask(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.planning.createTask(await this.ctx(userId, id), body ?? {});
  }

  /** Any of the above, plus { done: boolean }. */
  @Patch('tasks/:taskId')
  async updateTask(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body() body: Body,
  ) {
    return this.planning.updateTask(await this.ctx(userId, id), taskId, body ?? {});
  }

  @Delete('tasks/:taskId')
  async removeTask(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('taskId') taskId: string) {
    return this.planning.removeTask(await this.ctx(userId, id), taskId);
  }

  /** { totalCents } */
  @Patch('budget')
  async budget(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.planning.setBudget(await this.ctx(userId, id), body ?? {});
  }

  /** { name, category?, estimatedCents?, actualCents?, paidCents?, notes? } */
  @Post('budget-items')
  async createItem(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.planning.createBudgetItem(await this.ctx(userId, id), body ?? {});
  }

  @Patch('budget-items/:itemId')
  async updateItem(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: Body,
  ) {
    return this.planning.updateBudgetItem(await this.ctx(userId, id), itemId, body ?? {});
  }

  @Delete('budget-items/:itemId')
  async removeItem(@CurrentUser('userId') userId: string, @Param('id') id: string, @Param('itemId') itemId: string) {
    return this.planning.removeBudgetItem(await this.ctx(userId, id), itemId);
  }

  @Get('inquiries')
  async inquiries(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.planning.hostInquiries(await this.ctx(userId, id));
  }

  /** { type, listingId, message, guestCount?, date?, email?, phone? } */
  @Post('inquiries')
  async inquire(@CurrentUser('userId') userId: string, @Param('id') id: string, @Body() body: Body) {
    return this.planning.createInquiry(await this.ctx(userId, id), body ?? {});
  }
}

/** A vendor's inbox of quote requests. */
@Controller('api/vendor/inquiries')
export class VendorInquiriesController {
  constructor(private readonly planning: PlanningService) {}

  @Get()
  list(@CurrentUser('userId') userId: string) {
    return this.planning.vendorInquiries(userId);
  }

  /** { message, totalCents? } */
  @Post(':quoteId/reply')
  @HttpCode(200)
  reply(@CurrentUser('userId') userId: string, @Param('quoteId') quoteId: string, @Body() body: Body) {
    return this.planning.reply(userId, quoteId, body ?? {});
  }
}
