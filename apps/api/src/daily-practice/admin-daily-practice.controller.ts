import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role, type User } from '@prisma/client';
import { CurrentUser, Roles } from '../common/auth';
import {
  DailyPracticeCycleQueryDto,
  DailyPracticePageQueryDto,
  DailyPracticeServicePauseCreateDto,
  DailyPracticeSettingsUpdateDto,
  DailyPracticeTestAccessDto,
  FixedAssignmentPublishDto,
  FixedQuestionCandidateQueryDto,
  TeachingProgressQueryDto,
} from './daily-practice.dto';
import { DailyPracticeService } from './daily-practice.service';

@ApiTags('admin-daily-practice')
@Roles(Role.EDITOR, Role.ADMIN)
@Controller('admin/daily-practice')
export class AdminDailyPracticeController {
  constructor(private readonly dailyPractice: DailyPracticeService) {}

  @Roles(Role.ADMIN)
  @Get('test-access')
  testAccess() {
    return this.dailyPractice.getTestAccess();
  }

  @Roles(Role.ADMIN)
  @Patch('test-access/:userId')
  updateTestAccess(@Param('userId') userId: string, @Body() dto: DailyPracticeTestAccessDto, @CurrentUser() user: User) {
    return this.dailyPractice.updateTestAccess(user, userId, dto);
  }

  @Get('settings')
  settings() {
    return this.dailyPractice.getSettings();
  }

  @Patch('settings')
  updateSettings(
    @Body() dto: DailyPracticeSettingsUpdateDto,
    @CurrentUser() user: User,
  ) {
    return this.dailyPractice.updateSettings(user, dto);
  }

  @Get('service-pauses')
  pauses(@Query() query: DailyPracticePageQueryDto) {
    return this.dailyPractice.listServicePauses(query);
  }

  @Post('service-pauses')
  createPause(
    @Body() dto: DailyPracticeServicePauseCreateDto,
    @CurrentUser() user: User,
  ) {
    return this.dailyPractice.createServicePause(user, dto);
  }

  @Post('service-pauses/:id/cancel')
  cancelPause(@Param('id') id: string, @CurrentUser() user: User) {
    return this.dailyPractice.cancelServicePause(user, id);
  }

  @Get('teaching-progress')
  teachingProgress(@Query() query: TeachingProgressQueryDto) {
    return this.dailyPractice.listTeachingProgress(query);
  }

  @Get('teaching-progress/:id')
  teachingProgressDetail(@Param('id') id: string) {
    return this.dailyPractice.teachingProgressDetail(id);
  }

  @Get('fixed-question-candidates')
  fixedQuestionCandidates(@Query() query: FixedQuestionCandidateQueryDto) {
    return this.dailyPractice.fixedQuestionCandidates(query);
  }

  @Get('fixed-assignments/:practiceDate')
  fixedAssignments(@Param('practiceDate') practiceDate: string) {
    return this.dailyPractice.fixedAssignments(practiceDate);
  }

  @Post('fixed-assignments')
  publishFixedAssignment(
    @Body() dto: FixedAssignmentPublishDto,
    @CurrentUser() user: User,
  ) {
    return this.dailyPractice.publishFixedAssignment(user, dto);
  }

  @Get('cycles')
  cycles(@Query() query: DailyPracticeCycleQueryDto) {
    return this.dailyPractice.listCycles(query);
  }

  @Get('cycles/:practiceDate')
  cycle(@Param('practiceDate') practiceDate: string) {
    return this.dailyPractice.cycleAggregate(practiceDate);
  }

  @Post('cycles/:practiceDate/refreeze')
  requestCycleRefreeze(
    @Param('practiceDate') practiceDate: string,
    @CurrentUser() user: User,
  ) {
    return this.dailyPractice.requestCycleRefreeze(user, practiceDate);
  }
}
