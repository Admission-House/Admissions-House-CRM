import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { CreateShortlistDto, ListShortlistsDto, NiDnpDto, PaymentDto, RecommendDto, UpdateShortlistDto } from './admissions.dto.js';
import { AdmissionsService } from './admissions.service.js';

@ApiTags('admissions')
@ApiBearerAuth()
@Controller('leads/:id')
export class AdmissionsController {
  constructor(private readonly admissions: AdmissionsService) {}

  @RequirePermissions('lead.read')
  @Get('recommendations')
  recommendations(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.recommendations(auth, id);
  }

  @RequirePermissions('shortlist.manage')
  @Post('recommendations')
  recommend(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RecommendDto) {
    return this.admissions.recommend(auth, id, body.collegeId);
  }

  @RequirePermissions('shortlist.manage')
  @Delete('recommendations/:collegeId')
  @HttpCode(204)
  unrecommend(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('collegeId', ParseUUIDPipe) collegeId: string): Promise<void> {
    return this.admissions.unrecommend(auth, id, collegeId);
  }

  /** The shortlisted institutes. `view` picks the tab: all, active, ni_dnp or reconciled. */
  @RequirePermissions('lead.read')
  @Get('shortlists')
  list(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: ListShortlistsDto) {
    return this.admissions.list(auth, id, query);
  }

  @RequirePermissions('shortlist.manage')
  @Post('shortlists')
  create(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateShortlistDto) {
    return this.admissions.create(auth, id, body);
  }

  @RequirePermissions('shortlist.manage')
  @Patch('shortlists/:sid')
  update(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string, @Body() body: UpdateShortlistDto) {
    return this.admissions.update(auth, id, sid, body);
  }

  @RequirePermissions('shortlist.manage')
  @Delete('shortlists/:sid')
  @HttpCode(204)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string): Promise<void> {
    return this.admissions.remove(auth, id, sid);
  }

  @RequirePermissions('shortlist.manage')
  @Put('shortlists/:sid/payment')
  recordPayment(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string, @Body() body: PaymentDto) {
    return this.admissions.recordPayment(auth, id, sid, body);
  }

  @RequirePermissions('shortlist.manage')
  @Delete('shortlists/:sid/payment')
  clearPayment(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string) {
    return this.admissions.clearPayment(auth, id, sid);
  }

  @RequirePermissions('shortlist.manage')
  @Put('shortlists/:sid/ni-dnp')
  markNiDnp(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string, @Body() body: NiDnpDto) {
    return this.admissions.markNiDnp(auth, id, sid, body);
  }

  @RequirePermissions('shortlist.manage')
  @Delete('shortlists/:sid/ni-dnp')
  clearNiDnp(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('sid', ParseUUIDPipe) sid: string) {
    return this.admissions.clearNiDnp(auth, id, sid);
  }
}
