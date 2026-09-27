import { Module } from '@nestjs/common';
import { QuizModule } from '../quiz/quiz.module';
import { AdminDailyPracticeUsersController } from './admin-daily-practice-users.controller';
import { AdminDailyPracticeController } from './admin-daily-practice.controller';
import { DailyPracticeController } from './daily-practice.controller';
import { DailyPracticeService } from './daily-practice.service';
import { CurriculumController } from './curriculum.controller';
import { CurriculumService } from './curriculum.service';

@Module({
  imports: [QuizModule],
  controllers: [
    CurriculumController,
    DailyPracticeController,
    AdminDailyPracticeController,
    AdminDailyPracticeUsersController,
  ],
  providers: [DailyPracticeService, CurriculumService],
  exports: [DailyPracticeService],
})
export class DailyPracticeModule {}
