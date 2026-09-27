import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImageUploadAdmission, IMAGE_UPLOAD_LIMITS } from '../media/image-upload-admission';
import { ApiTags } from '@nestjs/swagger';
import { QuestionType, QuizQuestionCategory, Role, User } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { CurrentUser, Roles } from '../common/auth';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { MediaService } from '../media/media.service';
import { QuestionInput } from './quiz-question';
import {
  PastPaperScope,
  QuizService,
  serializeImages,
} from './quiz.service';

function optionalBoolean(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
}

function queryArray(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

class StartQuizDto {
  @IsOptional() @IsInt() @Min(1) @Max(100) count?: number;
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;
  @IsOptional()
  @Transform(({ value }) => queryArray(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  chapterIds?: string[];
  @IsOptional() @IsIn(['ANY', 'ALL']) chapterMatch?: 'ANY' | 'ALL';
  @IsOptional()
  @Transform(({ value }) => optionalBoolean(value))
  @IsBoolean()
  includeCrossChapter?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 100, { each: true })
  typeLabels?: string[];
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsEnum(QuestionType, { each: true })
  types?: QuestionType[];
  @IsOptional() @IsIn(['AI', 'NON_AI']) source?: 'AI' | 'NON_AI';
  @IsOptional()
  @Transform(({ value }) => optionalBoolean(value))
  @IsBoolean()
  includePastPapers?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  questionIds?: string[];
}

class SubmitQuizDto {
  @IsObject() answers!: Record<string, unknown>;
}

class SaveQuizDraftDto extends SubmitQuizDto {
  @IsInt() @Min(0) revision!: number;
  @IsInt() @Min(0) position!: number;
}

class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

class QuestionDto {
  @IsOptional() @IsEnum(QuestionType) type?: QuestionType;
  @IsOptional() @IsEnum(QuestionType) gradingType?: QuestionType;
  @IsOptional() @IsString() @Length(1, 100) typeLabel?: string;
  @IsString() @Length(1, 191) subjectId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  chapterIds!: string[];
  @IsOptional()
  @IsEnum(QuizQuestionCategory)
  category?: QuizQuestionCategory;
  @IsString() @Length(2, 10_000) prompt!: string;
  @IsArray() options!: Array<{ id: string; text: string }>;
  @IsArray() correctAnswer!: string[];
  @IsOptional() @IsObject() gradingRubric?: Record<string, unknown>;
  @IsString() @Length(0, 10_000) explanation!: string;
  @IsOptional() @IsString() @Length(1, 191) pastPaperId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10_000) paperOrder?: number;
}

class QuestionLibraryQueryDto {
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;
  @IsOptional()
  @Transform(({ value }) => queryArray(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  chapterIds?: string[];
  @IsOptional() @IsIn(['ANY', 'ALL']) chapterMatch: 'ANY' | 'ALL' = 'ANY';
  @IsOptional()
  @Transform(({ value }) => optionalBoolean(value))
  @IsBoolean()
  includeCrossChapter?: boolean;
  @IsOptional() @IsString() @Length(1, 100) typeLabel?: string;
  @IsOptional() @IsIn(['AI', 'NON_AI']) source?: 'AI' | 'NON_AI';
  @IsOptional()
  @IsIn(['ALL', 'EXCLUDE', 'ONLY'])
  pastPaper?: PastPaperScope;
  @IsOptional() @IsString() @Length(1, 191) paperId?: string;
  @IsOptional() @IsString() @Length(1, 200) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 30;
}

class WrongQuestionQueryDto extends PageQueryDto {
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;
  @IsOptional()
  @Transform(({ value }) => queryArray(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  chapterIds?: string[];
  @IsOptional() @IsIn(['ANY', 'ALL']) chapterMatch: 'ANY' | 'ALL' = 'ANY';
  @IsOptional()
  @Transform(({ value }) => optionalBoolean(value))
  @IsBoolean()
  includeCrossChapter?: boolean;
  @IsOptional() @IsString() @Length(1, 100) typeLabel?: string;
  @IsOptional() @IsIn(['AI', 'NON_AI']) source?: 'AI' | 'NON_AI';
  @IsOptional() @IsString() @Length(1, 200) search?: string;
}

class PaperListQueryDto {
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;
}

class QuestionImageDto {
  @IsOptional() @IsString() @Length(0, 300) caption?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder = 0;
}

function serializeMutationQuestion(question: {
  type: QuestionType;
  photos?: Parameters<typeof serializeImages>[0];
  subjectId: string;
  subject: { name: string };
  chapters: Array<{ chapter: { id: string; name: string } }>;
  pastPaper: null | {
    subject: { name: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}) {
  const chapters = question.chapters.map(({ chapter }) => chapter);
  const { photos, ...fields } = question;
  return {
    ...fields,
    gradingType: question.type,
    images: serializeImages(photos ?? []),
    subject: question.subject.name,
    chapterIds: chapters.map(({ id }) => id),
    chapter: chapters[0]?.name ?? '',
    chapters,
    pastPaper: question.pastPaper
      ? {
          ...question.pastPaper,
          subject: question.pastPaper.subject.name,
        }
      : null,
  };
}

@ApiTags('quizzes')
@Controller('quizzes')
export class QuizController {
  constructor(
    private readonly quizzes: QuizService,
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
  ) {}

  @Post('start')
  start(@Body() dto: StartQuizDto, @CurrentUser() user: User) {
    return this.quizzes.start(user.id, dto.count, {
      subjectId: dto.subjectId,
      chapterIds: dto.chapterIds,
      chapterMatch: dto.chapterMatch,
      includeCrossChapter: dto.includeCrossChapter,
      typeLabels: dto.typeLabels,
      types: dto.types,
      source: dto.source,
      includePastPapers: dto.includePastPapers,
      questionIds: dto.questionIds,
    });
  }

  @Post('papers/:paperId/start')
  startPaper(@Param('paperId') paperId: string, @CurrentUser() user: User) {
    return this.quizzes.startPaper(user.id, paperId);
  }

  @Get('attempts/active')
  activeAttempts(@CurrentUser() user: User) {
    return this.quizzes.activeAttempts(user.id);
  }

  @Get('attempts/:attemptId')
  attempt(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: User,
  ) {
    return this.quizzes.getAttempt(user.id, attemptId);
  }

  @Patch('attempts/:attemptId/draft')
  saveDraft(
    @Param('attemptId') attemptId: string,
    @Body() dto: SaveQuizDraftDto,
    @CurrentUser() user: User,
  ) {
    return this.quizzes.saveDraft(
      user.id,
      attemptId,
      dto.revision,
      dto.position,
      dto.answers,
    );
  }

  @Post('attempts/:attemptId/abandon')
  abandonAttempt(
    @Param('attemptId') attemptId: string,
    @CurrentUser() user: User,
  ) {
    return this.quizzes.abandonAttempt(user.id, attemptId);
  }

  @Post(':attemptId/submit')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Param('attemptId') id: string,
    @Body() dto: SubmitQuizDto,
    @CurrentUser() user: User,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.quizzes.submit(user.id, id, dto.answers);
    if ('pending' in result && result.pending) response.status(202);
    return result;
  }

  @Get('filters')
  filters() {
    return this.quizzes.filters();
  }

  @Get('questions')
  questions(@Query() query: QuestionLibraryQueryDto) {
    return this.quizzes.listQuestions({
      subjectId: query.subjectId,
      chapterIds: query.chapterIds,
      chapterMatch: query.chapterMatch,
      includeCrossChapter: query.includeCrossChapter,
      typeLabel: query.typeLabel,
      source: query.source,
      pastPaper: query.pastPaper ?? 'ALL',
      paperId: query.paperId,
      search: query.search,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get('papers')
  papers(@Query() query: PaperListQueryDto) {
    return this.quizzes.listPapers(query.subjectId);
  }

  @Get('history')
  async history(@CurrentUser() user: User, @Query() query: PageQueryDto) {
    const where = { userId: user.id, submittedAt: { not: null } };
    const [items, total] = await Promise.all([
      this.prisma.quizAttempt.findMany({
        where,
        select: {
          id: true,
          score: true,
          total: true,
          submittedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.quizAttempt.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  @Get('wrong')
  wrongQuestions(
    @CurrentUser() user: User,
    @Query() query: WrongQuestionQueryDto,
  ) {
    return this.quizzes.wrongQuestions(user.id, query);
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post('questions')
  async createQuestion(@Body() dto: QuestionDto, @CurrentUser() user: User) {
    const input: QuestionInput = {
      ...dto,
      gradingType: dto.gradingType ?? dto.type,
    };
    const question = await this.quizzes.createQuestion(
      user.id,
      input,
      {
        pastPaperId: dto.pastPaperId,
        paperOrder: dto.paperOrder,
      },
      (transaction, created) =>
        this.audit.record(
          user.id,
          'quiz.question.create',
          'QuizQuestion',
          created.id,
          {
            subjectId: dto.subjectId,
            typeLabel: dto.typeLabel,
            pastPaperId: dto.pastPaperId,
          },
          transaction,
        ),
    );
    return serializeMutationQuestion(question);
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Get('questions/:id')
  async questionForEdit(@Param('id') id: string) {
    const question = await this.quizzes.getQuestionForEdit(id);
    return serializeMutationQuestion(question);
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Patch('questions/:id')
  async updateQuestion(
    @Param('id') id: string,
    @Body() dto: QuestionDto,
    @CurrentUser() user: User,
  ) {
    const input: QuestionInput = {
      ...dto,
      gradingType: dto.gradingType ?? dto.type,
    };
    const question = await this.quizzes.updateQuestion(
      id,
      input,
      (transaction) =>
        this.audit.record(
          user.id,
          'quiz.question.update',
          'QuizQuestion',
          id,
          { subjectId: dto.subjectId },
          transaction,
        ),
    );
    return serializeMutationQuestion(question);
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Delete('questions/:id')
  async disableQuestion(@Param('id') id: string, @CurrentUser() user: User) {
    const result = await this.quizzes.disableQuestion(id, (transaction) =>
      this.audit.record(
        user.id,
        'quiz.question.disable',
        'QuizQuestion',
        id,
        undefined,
        transaction,
      ),
    );
    return { id: result.id, deleted: result.deleted };
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Post('questions/:id/images')
  @UseInterceptors(
    ImageUploadAdmission(),
    FileInterceptor('file', { limits: { ...IMAGE_UPLOAD_LIMITS, files: 1, parts: 14 } }),
  )
  async uploadQuestionImage(
    @Param('id') questionId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: QuestionImageDto,
    @CurrentUser() user: User,
  ) {
    await this.prisma.quizQuestion.findUniqueOrThrow({
      where: { id: questionId },
      select: { id: true },
    });
    return this.media.createImage(
      file,
      user.id,
      { caption: dto.caption },
      async (transaction, photo) => {
        await transaction.quizQuestion.findUniqueOrThrow({
          where: { id: questionId },
          select: { id: true },
        });
        await transaction.quizQuestionPhoto.create({
          data: {
            questionId,
            photoId: photo.id,
            sortOrder: dto.sortOrder,
          },
        });
        await transaction.quizQuestion.update({
          where: { id: questionId },
          data: { contentRevision: { increment: 1 } },
        });
        await this.audit.record(
          user.id,
          'quiz.question.image.attach',
          'QuizQuestion',
          questionId,
          { photoId: photo.id },
          transaction,
        );
      },
    );
  }

  @Roles(Role.EDITOR, Role.ADMIN)
  @Delete('questions/:questionId/images/:photoId')
  async detachQuestionImage(
    @Param('questionId') questionId: string,
    @Param('photoId') photoId: string,
    @CurrentUser() user: User,
  ) {
    await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.quizQuestionPhoto.deleteMany({
        where: { questionId, photoId },
      });
      if (!result.count) throw new NotFoundException('题目配图不存在');
      await transaction.quizQuestion.update({
        where: { id: questionId },
        data: { contentRevision: { increment: 1 } },
      });
      await this.audit.record(
        user.id,
        'quiz.question.image.detach',
        'QuizQuestion',
        questionId,
        { photoId },
        transaction,
      );
    });
    return { deleted: true };
  }

}
