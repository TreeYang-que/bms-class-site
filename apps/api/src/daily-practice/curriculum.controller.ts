import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role, type User } from '@prisma/client';
import { CurrentUser, Roles } from '../common/auth';
import { CurriculumService } from './curriculum.service';
import {
  PracticeCourseUpdateDto,
  PracticeMappingQueryDto,
  PracticeMappingRevisionDto,
  PracticeMappingUpdateDto,
} from './curriculum.dto';

@ApiTags('admin-daily-practice')
@Roles(Role.EDITOR, Role.ADMIN)
@Controller('admin/daily-practice')
export class CurriculumController {
  constructor(private readonly curriculum: CurriculumService) {}
  @Get('curriculum') list() {
    return this.curriculum.list();
  }
  @Post('curriculum/initialize') initialize(@CurrentUser() user: User) {
    return this.curriculum.initialize(user);
  }
  @Patch('curriculum/:id') update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: PracticeCourseUpdateDto,
  ) {
    return this.curriculum.update(user, id, dto);
  }
  @Get('curriculum/:id/history') history(@Param('id') id: string) {
    return this.curriculum.history(id);
  }
  @Post('curriculum/:id/queue-mappings') queue(@CurrentUser() user: User, @Param('id') id: string) {
    return this.curriculum.queueMappings(user, id);
  }
  @Get('question-mappings') mappings(@Query() dto: PracticeMappingQueryDto) {
    return this.curriculum.mappings(dto);
  }
  @Patch('question-mappings/:id') updateMapping(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: PracticeMappingUpdateDto,
  ) {
    return this.curriculum.updateMapping(user, id, dto);
  }
  @Post('question-mappings/:id/retry') retry(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: PracticeMappingRevisionDto,
  ) {
    return this.curriculum.retryMapping(user, id, dto.expectedRevision);
  }
}
