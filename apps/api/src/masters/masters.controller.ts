import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequireAnyPermission, RequirePermissions } from '../auth/decorators.js';
import {
  CreateCollegeDto, CreateCourseDto, CreateStreamDto, ListCollegesDto, ListCoursesDto, ListLocationsDto, ReviewDto, SetOfferedCourseDto,
  UpdateCollegeDto, UpdateCourseDto,
} from './masters.dto.js';
import { MastersService } from './masters.service.js';

class CollegeQueryDto extends createZodDto(z.object({ mode: z.enum(['online', 'regular', 'any']).default('any') })) {}

@ApiTags('masters')
@ApiBearerAuth()
@Controller()
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  @RequirePermissions('master.read')
  @Get('locations')
  locations(@CurrentAuth() auth: AuthContext, @Query() query: ListLocationsDto) {
    return this.masters.locations(auth, query);
  }

  @RequirePermissions('master.read')
  @Get('streams')
  streams(@CurrentAuth() auth: AuthContext) {
    return this.masters.streams(auth);
  }

  @RequirePermissions('master.manage')
  @Post('streams')
  createStream(@CurrentAuth() auth: AuthContext, @Body() body: CreateStreamDto) {
    return this.masters.createStream(auth, body);
  }

  @RequirePermissions('master.read')
  @Get('courses')
  courses(@CurrentAuth() auth: AuthContext, @Query() query: ListCoursesDto) {
    return this.masters.courses(auth, query);
  }

  @RequirePermissions('master.manage')
  @Post('courses')
  createCourse(@CurrentAuth() auth: AuthContext, @Body() body: CreateCourseDto) {
    return this.masters.createCourse(auth, body);
  }

  @RequirePermissions('master.manage')
  @Patch('courses/:id')
  updateCourse(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCourseDto) {
    return this.masters.updateCourse(auth, id, body);
  }

  /** Institutes. Add `leadId` to see only those that suit the lead's study mode (online or regular). */
  @RequirePermissions('master.read')
  @Get('colleges')
  colleges(@CurrentAuth() auth: AuthContext, @Query() query: ListCollegesDto) {
    return this.masters.colleges(auth, query);
  }

  @RequirePermissions('master.read')
  @Get('colleges/:id')
  college(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: CollegeQueryDto) {
    return this.masters.college(auth, id, query.mode);
  }

  /** Someone who manages the lists adds an institute for good; a counsellor's is flagged for review. */
  @RequireAnyPermission('master.manage', 'master.create')
  @Post('colleges')
  createCollege(@CurrentAuth() auth: AuthContext, @Body() body: CreateCollegeDto) {
    return this.masters.createCollege(auth, body);
  }

  @RequirePermissions('master.manage')
  @Patch('colleges/:id')
  updateCollege(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateCollegeDto) {
    return this.masters.updateCollege(auth, id, body);
  }

  @RequirePermissions('master.manage')
  @Put('colleges/:id/courses/:courseId')
  setOfferedCourse(
    @CurrentAuth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Body() body: SetOfferedCourseDto,
  ) {
    return this.masters.setOfferedCourse(auth, id, courseId, body);
  }

  @RequirePermissions('master.manage')
  @Delete('colleges/:id/courses/:courseId')
  removeOfferedCourse(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('courseId', ParseUUIDPipe) courseId: string) {
    return this.masters.removeOfferedCourse(auth, id, courseId);
  }

  @RequirePermissions('master.review')
  @Post('colleges/:id/review')
  review(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReviewDto) {
    return this.masters.review(auth, id, body.decision);
  }
}
