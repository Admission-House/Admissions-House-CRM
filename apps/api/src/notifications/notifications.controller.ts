import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { pageQuerySchema } from '../common/pagination.js';
import { NotificationsService } from './notifications.service.js';

class ListNotificationsDto extends createZodDto(
  pageQuerySchema.extend({ unreadOnly: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') }),
) {}

class MarkReadDto extends createZodDto(
  z
    .object({
      ids: z.array(z.string().regex(/^\d{1,18}$/)).min(1).max(200).optional(),
      all: z.boolean().optional(),
    })
    .refine((v) => (v.ids ? !v.all : v.all === true), 'Give either a list of ids or all: true'),
) {}

/** A person's own notifications. Every signed-in person has them, so no extra permission is needed. */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListNotificationsDto) {
    return this.notifications.list(auth, query);
  }

  @Get('unread-count')
  unread(@CurrentAuth() auth: AuthContext) {
    return this.notifications.unreadCount(auth);
  }

  @Post('read')
  @HttpCode(200)
  markRead(@CurrentAuth() auth: AuthContext, @Body() body: MarkReadDto) {
    return this.notifications.markRead(auth, body);
  }
}
