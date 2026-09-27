import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { DailyPracticePageQueryDto } from './daily-practice.dto';

export class PracticeCourseTopicDto {
  @IsString() @Matches(/^[a-z0-9-]{1,80}$/u) id!: string;
  @IsString() @Length(1, 200) title!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({ each: true }) sessionDates!: string[];
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) sourceRefs!: string[];
  @IsBoolean() paused!: boolean;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/u) taughtOnOverride!: string | null;
}

export class PracticeCourseUpdateDto {
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/u) examDate?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => PracticeCourseTopicDto)
  topics?: PracticeCourseTopicDto[];
  @IsString() @Length(1, 1000) reason!: string;
}

export class PracticeMappingQueryDto extends DailyPracticePageQueryDto {
  @IsOptional() @IsString() @Length(1, 191) courseId?: string;
  @IsOptional() @IsIn(['PENDING', 'PROCESSING', 'READY', 'NEEDS_REVIEW', 'STALE']) status?: string;
}

export class PracticeMappingRevisionDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) expectedRevision!: number;
}

export class PracticeMappingUpdateDto extends PracticeMappingRevisionDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) expectedContentRevision?: number;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ArrayUnique()
  @IsString({ each: true })
  topicIds!: string[];
  @IsString() @Length(1, 1000) reason!: string;
}
