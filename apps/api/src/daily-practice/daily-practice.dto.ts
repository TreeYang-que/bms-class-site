import {
  AccountStatus,
  DailyPracticeDayStatus,
  DailyPracticeGenerationSource,
  DailyPracticeSuggestionStatus,
  QuestionType,
  Role,
  TeachingProgressChangeType,
  UserPracticeInitializationStatus,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const PRACTICE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

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

export class DailyPracticePageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

export class DailyPracticeSuggestionDto {
  @IsIn(['LIGHT', 'STANDARD', 'CHALLENGING'])
  intensity!: 'LIGHT' | 'STANDARD' | 'CHALLENGING';

  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(10)
  desiredQuestionCount!: number;

  @IsArray()
  @ArrayMaxSize(2)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  focusSubjectIds!: string[];

  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  focusChapterIds!: string[];

  @IsOptional() @IsString() @Length(1, 300) note?: string;
}

export class DailyPracticeSettingsUpdateDto {
  @IsBoolean() enabled!: boolean;
  @Type(() => Number) @IsInt() @Min(0) expectedRevision!: number;
  @IsString() @Length(1, 200) reason!: string;
}

export class DailyPracticeTestAccessDto {
  @IsBoolean() enabled!: boolean;
  @Type(() => Number) @IsInt() @Min(0) expectedRevision!: number;
}

export class DailyPracticeServicePauseCreateDto {
  @IsISO8601({ strict: true, strictSeparator: true }) startsAt!: string;
  @IsISO8601({ strict: true, strictSeparator: true }) endsAt!: string;
  @IsString() @Length(1, 200) reason!: string;
}

export class TeachingProgressNodeDto {
  @IsString() @Length(1, 191) knowledgeNodeId!: string;
  @Matches(PRACTICE_DATE_PATTERN) firstTaughtDate!: string;
}

export class TeachingProgressPublishDto {
  @IsString() @Length(1, 191) subjectId!: string;
  @Matches(PRACTICE_DATE_PATTERN) effectivePracticeDate!: string;
  @IsEnum(TeachingProgressChangeType)
  changeType!: TeachingProgressChangeType;
  @IsOptional() @IsString() @Length(1, 191) basedOnProgressId?: string;
  @Type(() => Number) @IsInt() @Min(0) expectedVersion!: number;
  @IsOptional() @IsString() @Length(1, 1000) note?: string;
  @IsOptional() @IsString() @Length(1, 1000) correctionReason?: string;

  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => TeachingProgressNodeDto)
  nodes!: TeachingProgressNodeDto[];
}

export class TeachingProgressQueryDto extends DailyPracticePageQueryDto {
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;
}

export class DailyPracticeCycleQueryDto {
  @IsOptional() @Matches(PRACTICE_DATE_PATTERN) from?: string;
  @IsOptional() @Matches(PRACTICE_DATE_PATTERN) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize = 20;
}

export class FixedQuestionCandidateQueryDto extends DailyPracticePageQueryDto {
  @IsOptional() @Matches(PRACTICE_DATE_PATTERN) practiceDate?: string;
  @IsOptional() @IsString() @Length(1, 191) subjectId?: string;

  @IsOptional()
  @Transform(({ value }) => queryArray(value))
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  chapterIds?: string[];

  @IsOptional() @IsIn(['ANY', 'ALL']) chapterMatch: 'ANY' | 'ALL' = 'ANY';

  @IsOptional()
  @Transform(({ value }) => optionalBoolean(value))
  @IsBoolean()
  includeCrossChapter?: boolean;

  @IsOptional() @IsEnum(QuestionType) gradingType?: QuestionType;
  @IsOptional() @IsString() @Length(1, 100) typeLabel?: string;
  @IsOptional() @IsIn(['ALL', 'EXCLUDE', 'ONLY']) pastPaper?:
    'ALL' | 'EXCLUDE' | 'ONLY';
  @IsOptional() @IsString() @Length(1, 191) paperId?: string;
  @IsOptional() @IsString() @Length(1, 200) search?: string;
}

export class FixedAssignmentPublishDto {
  @Matches(PRACTICE_DATE_PATTERN) practiceDate!: string;
  @Type(() => Number) @IsInt() @Min(0) expectedRevision!: number;

  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 191, { each: true })
  questionIds!: string[];

  @IsOptional() @IsString() @Length(1, 1000) note?: string;
}

export class AdminDailyPracticeUsersQueryDto extends DailyPracticePageQueryDto {
  @IsOptional() @IsString() @Length(1, 80) search?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsEnum(AccountStatus) status?: AccountStatus;
  @IsOptional()
  @IsEnum(UserPracticeInitializationStatus)
  initializationStatus?: UserPracticeInitializationStatus;
  @IsOptional()
  @IsEnum(DailyPracticeDayStatus)
  planStatus?: DailyPracticeDayStatus;
  @IsOptional()
  @IsEnum(DailyPracticeDayStatus)
  todayStatus?: DailyPracticeDayStatus;
  @IsOptional()
  @IsEnum(DailyPracticeGenerationSource)
  generationSource?: DailyPracticeGenerationSource;
  @IsOptional()
  @IsEnum(DailyPracticeSuggestionStatus)
  suggestionStatus?: DailyPracticeSuggestionStatus;

  @IsOptional()
  @Transform(({ value }) => optionalBoolean(value))
  @IsBoolean()
  completed?: boolean;

  @IsOptional()
  @Transform(({ value }) => optionalBoolean(value))
  @IsBoolean()
  hasSuggestion?: boolean;

  @IsOptional()
  @Transform(({ value }) => optionalBoolean(value))
  @IsBoolean()
  hasGap?: boolean;
}

export class AdminDailyPracticeSuggestionDto extends DailyPracticeSuggestionDto {
  @Matches(PRACTICE_DATE_PATTERN) targetPracticeDate!: string;
}
