import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { pageQuerySchema } from '../common/pagination.js';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import {
  AssignDto, BulkAssignDto, BulkStatusDto, ChangeStatusDto, CreateLeadDto, ExportLeadsDto, ListLeadsDto, NoteDto, UpdateLeadDto,
} from './leads.dto.js';
import { LeadsService } from './leads.service.js';

class ActivitiesQueryDto extends createZodDto(pageQuerySchema) {}

@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @RequirePermissions('lead.read')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: ListLeadsDto) {
    return this.leads.list(auth, query);
  }

  /** Every lead matching the filters, as a CSV or Excel file. */
  @RequirePermissions('lead.export')
  @Get('export')
  async export(@CurrentAuth() auth: AuthContext, @Query() query: ExportLeadsDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const file = await this.leads.exportFile(auth, query);
    reply.header('content-type', file.contentType).header('content-disposition', `attachment; filename="${file.fileName}"`).header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff');
    return file.body;
  }

  /** Counts for the queue tabs. */
  @RequirePermissions('lead.read')
  @Get('queues')
  queues(@CurrentAuth() auth: AuthContext) {
    return this.leads.queues(auth);
  }

  @RequirePermissions('lead.create')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateLeadDto) {
    return this.leads.create(auth, body);
  }

  // Bulk routes come before ":id" so that "bulk" is not read as a lead id.

  @RequirePermissions('lead.assign')
  @Post('bulk/assign')
  @HttpCode(200)
  bulkAssign(@CurrentAuth() auth: AuthContext, @Body() body: BulkAssignDto) {
    return this.leads.bulkAssign(auth, body);
  }

  @RequirePermissions('lead.assign')
  @Post('bulk/status')
  @HttpCode(200)
  bulkStatus(@CurrentAuth() auth: AuthContext, @Body() body: BulkStatusDto) {
    return this.leads.bulkStatus(auth, body);
  }

  @RequirePermissions('lead.read')
  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.leads.get(auth, id);
  }

  @RequirePermissions('lead.update')
  @Patch(':id')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateLeadDto) {
    return this.leads.update(auth, id, body);
  }

  @RequirePermissions('lead.update')
  @Post(':id/status')
  @HttpCode(200)
  changeStatus(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ChangeStatusDto) {
    return this.leads.changeStatus(auth, id, body);
  }

  @RequirePermissions('lead.assign')
  @Post(':id/assign')
  @HttpCode(200)
  assign(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: AssignDto) {
    return this.leads.assign(auth, id, body);
  }

  @RequirePermissions('lead.update')
  @Post(':id/notes')
  addNote(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: NoteDto) {
    return this.leads.addNote(auth, id, body.remark);
  }

  @RequirePermissions('lead.read')
  @Get(':id/activities')
  activities(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: ActivitiesQueryDto) {
    return this.leads.activities(auth, id, query);
  }

  @RequirePermissions('lead.delete')
  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.leads.remove(auth, id);
  }
}
