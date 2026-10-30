import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { createFieldSchema, CustomFieldsService, updateFieldSchema } from './custom-fields.service.js';

class CreateDto extends createZodDto(createFieldSchema) {}
class UpdateDto extends createZodDto(updateFieldSchema) {}
class ListDto extends createZodDto(z.object({ includeInactive: z.enum(['true', 'false']).transform((v) => v === 'true').optional() })) {}
class ValuesDto extends createZodDto(z.object({ values: z.record(z.string(), z.unknown()).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 50, 'Send between 1 and 50 values') })) {}

@ApiTags('custom fields')
@ApiBearerAuth()
@Controller()
export class CustomFieldsController {
  constructor(private readonly fields: CustomFieldsService) {}

  /** The field definitions. Anyone who works with leads needs them to draw the form. */
  @RequirePermissions('lead.read')
  @Get('custom-fields')
  list(@CurrentAuth() auth: AuthContext, @Query() q: ListDto) {
    return this.fields.list(auth, !!q.includeInactive && auth.permissions.has('settings.manage'));
  }

  @RequirePermissions('settings.manage')
  @Post('custom-fields')
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateDto) {
    return this.fields.create(auth, body);
  }

  @RequirePermissions('settings.manage')
  @Patch('custom-fields/:id')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateDto) {
    return this.fields.update(auth, id, body);
  }

  @RequirePermissions('lead.read')
  @Get('leads/:id/custom-fields')
  forLead(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fields.forLead(auth, id);
  }

  @RequirePermissions('lead.update')
  @Put('leads/:id/custom-fields')
  setForLead(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ValuesDto) {
    return this.fields.setForLead(auth, id, body.values);
  }
}
