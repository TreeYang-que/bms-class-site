import { hasDailyPracticeAccess, internalTestUsers } from '@bmc3/daily-practice-core';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  ContentStatus,
  DailyPracticeCycleStatus,
  DailyPracticeDayStatus,
  DailyPracticeGenerationSource,
  DailyPracticePlanItemSource,
  DailyPracticePlanTrigger,
  DailyPracticeSuggestionStatus,
  IndexStatus,
  KnowledgeKind,
  KnowledgeLibraryScope,
  KnowledgeRenderStatus,
  Prisma,
  QuestionType,
  QuizQuestionCategory,
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
  TeachingProgressChangeType,
  UserPracticeInitializationStatus,
  Role,
  type User,
} from '@prisma/client';
import {
  DAILY_PRACTICE_SPREAD_WINDOW_MS,
  courseStatus,
  learnedCourseTopics,
  PRACTICE_SUBJECT_SLUGS,
  DAILY_PERSONALIZATION_PROMPT_VERSION,
  nextPracticeDate,
  practiceDateForInstant,
  practiceDateFromDbDate,
  practiceDateToDbDate,
  practiceDayWindow,
} from '@bmc3/daily-practice-core';
import { createHash } from 'node:crypto';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../database/prisma.service';
import { QuizService } from '../quiz/quiz.service';
import {
  AdminDailyPracticeSuggestionDto,
  AdminDailyPracticeUsersQueryDto,
  DailyPracticeCycleQueryDto,
  DailyPracticePageQueryDto,
  DailyPracticeServicePauseCreateDto,
  DailyPracticeSettingsUpdateDto,
  DailyPracticeSuggestionDto,
  FixedAssignmentPublishDto,
  FixedQuestionCandidateQueryDto,
  TeachingProgressPublishDto,
  TeachingProgressQueryDto,
} from './daily-practice.dto';
import {
  DAILY_PRACTICE_ERROR_CODES,
  type DailyPracticeErrorCode,
  dailyPracticeBadRequest,
  dailyPracticeConflict,
  dailyPracticeNotFound,
} from './daily-practice.errors';
import { lockDailyPracticeSettings } from './daily-practice-gate';
import { assertDailyQuestionEligibility, dailyCurriculumEligibilitySql, loadEligiblePracticeQuestions, loadPracticeCourses } from '@bmc3/daily-practice-prisma';
import { CurriculumService } from './curriculum.service';

const PUBLIC_USER_SELECT = {
  id: true,
  displayName: true,
} satisfies Prisma.UserSelect;

const SUBJECT_SELECT = {
  id: true,
  name: true,
  slug: true,
} satisfies Prisma.SubjectSelect;

const CHAPTER_SELECT = {
  id: true,
  name: true,
  slug: true,
} satisfies Prisma.SubjectChapterSelect;

const PLAN_QUESTION_SELECT = {
  id: true,
  type: true,
  typeLabel: true,
  subjectId: true,
  subject: { select: SUBJECT_SELECT },
  chapters: {
    select: { chapter: { select: CHAPTER_SELECT } },
    orderBy: [
      { chapter: { sortOrder: 'asc' as const } },
      { createdAt: 'asc' as const },
    ],
  },
  prompt: true,
  options: true,
  maxScore: true,
  enabled: true,
  origin: true,
  reviewStatus: true,
  reviewRevision: true,
  sourceRevision: true,
  sourceReviewStatus: true,
  photos: {
    select: {
      photo: {
        select: {
          id: true,
          caption: true,
          mimeType: true,
          size: true,
          width: true,
          height: true,
        },
      },
    },
    orderBy: { sortOrder: 'asc' as const },
  },
} satisfies Prisma.QuizQuestionSelect;

const PLAN_ITEMS_INCLUDE = {
  items: {
    include: { question: { select: PLAN_QUESTION_SELECT } },
    orderBy: { ordinal: 'asc' as const },
  },
  quizAttempt: {
    select: {
      id: true,
      score: true,
      total: true,
      results: true,
      submittedAt: true,
    },
  },
} satisfies Prisma.DailyPracticePlanRevisionInclude;

const FIXED_QUESTION_SELECT = {
  id: true,
  type: true,
  typeLabel: true,
  subjectId: true,
  subject: { select: { name: true } },
  chapters: {
    select: { chapter: { select: CHAPTER_SELECT } },
    orderBy: [
      { chapter: { sortOrder: 'asc' as const } },
      { createdAt: 'asc' as const },
    ],
  },
  prompt: true,
  origin: true,
  pastPaperId: true,
} satisfies Prisma.QuizQuestionSelect;

const fixedAssignmentInclude = {
  publishedBy: { select: PUBLIC_USER_SELECT },
  questions: {
    include: { question: { select: FIXED_QUESTION_SELECT } },
    orderBy: { ordinal: 'asc' as const },
  },
} satisfies Prisma.DailyPracticeFixedAssignmentInclude;

type PlanQuestion = Prisma.QuizQuestionGetPayload<{
  select: typeof PLAN_QUESTION_SELECT;
}>;

type PlanRevisionWithItems = Prisma.DailyPracticePlanRevisionGetPayload<{
  include: typeof PLAN_ITEMS_INCLUDE;
}>;

type FixedAssignmentWithQuestions =
  Prisma.DailyPracticeFixedAssignmentGetPayload<{
    include: typeof fixedAssignmentInclude;
  }>;

type DatabaseClient = PrismaService | Prisma.TransactionClient;

interface ServiceState {
  enabled: boolean;
  paused: boolean;
  reason: string | null;
  resumesAt: string | null;
  settingsRevision: number;
}

interface NormalizedTeachingNode {
  libraryId: string;
  documentId: string;
  nodePathHash: string;
  currentKnowledgeNodeId: string;
  titleSnapshot: string;
  breadcrumbSnapshot: string;
  firstTaughtDate: Date;
  sourceDocumentVersionId: string;
  contentHashSnapshot: string;
}

interface ResolvedTeachingNode {
  id: string;
  title: string;
  breadcrumb: string;
  remapped: boolean;
  resolvedDocumentId: string;
}

const rebuildableDayStatuses: DailyPracticeDayStatus[] = [
  DailyPracticeDayStatus.PENDING,
  DailyPracticeDayStatus.PROCESSING,
  DailyPracticeDayStatus.READY,
  DailyPracticeDayStatus.LIMITED_CONTENT,
  DailyPracticeDayStatus.NO_CONTENT,
  DailyPracticeDayStatus.DEGRADED_READY,
  DailyPracticeDayStatus.FAILED,
  DailyPracticeDayStatus.PAUSED,
  DailyPracticeDayStatus.STALE,
];

const availableDayStatuses: DailyPracticeDayStatus[] = [
  DailyPracticeDayStatus.READY,
  DailyPracticeDayStatus.LIMITED_CONTENT,
  DailyPracticeDayStatus.DEGRADED_READY,
  DailyPracticeDayStatus.STARTED,
  DailyPracticeDayStatus.COMPLETED,
];

const startableDayStatuses = new Set<DailyPracticeDayStatus>([
  DailyPracticeDayStatus.READY,
  DailyPracticeDayStatus.LIMITED_CONTENT,
  DailyPracticeDayStatus.DEGRADED_READY,
]);

@Injectable()
export class DailyPracticeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly quizzes: QuizService,
    private readonly curriculum: CurriculumService,
  ) {}

  async today(user: User) {
    const now = new Date();
    const practiceDate = practiceDateForInstant(now);
    const window = practiceDayWindow(practiceDate);
    const targetSuggestionDate = nextPracticeDate(practiceDate);
    const practiceDateDb = practiceDateToDbDate(practiceDate);
    const targetSuggestionDateDb = practiceDateToDbDate(targetSuggestionDate);
    const curriculum = await this.curriculum.list(practiceDate);

    if (user.status === AccountStatus.ACTIVE) {
      await this.prisma.userPracticeProfile.createMany({
        data: [{ userId: user.id }],
        skipDuplicates: true,
      });
    }

    const [service, profile, totalAttempts, suggestion, initialDay] =
      await Promise.all([
        this.serviceState(now, this.prisma, user.id),
        this.prisma.userPracticeProfile.findUnique({
          where: { userId: user.id },
          select: {
            initializationStatus: true,
            attemptCount: true,
          },
        }),
        this.prisma.quizAttempt.count({
          where: { userId: user.id, submittedAt: { not: null } },
        }),
        this.prisma.dailyPracticeSuggestion.findUnique({
          where: {
            userQuotaKey: `USER:${user.id}:${targetSuggestionDate}`,
          },
          select: {
            id: true,
            targetPracticeDate: true,
            payload: true,
            status: true,
            createdAt: true,
            submittedBy: { select: { role: true } },
          },
        }),
        this.prisma.dailyPracticeDay.findUnique({
          where: {
            userId_practiceDate: {
              userId: user.id,
              practiceDate: practiceDateDb,
            },
          },
          select: {
            id: true,
            status: true,
            createdAt: true,
            activeRevisionId: true,
            cycle: { select: { deadlineAt: true } },
            activeRevision: {
              include: PLAN_ITEMS_INCLUDE,
            },
          },
        }),
      ]);

    let day = initialDay;
    if (
      !day &&
      user.status === AccountStatus.ACTIVE &&
      service.enabled &&
      !service.paused &&
      profile?.initializationStatus === UserPracticeInitializationStatus.READY &&
      now >= window.deadlineAt
    ) {
      day = await this.createLatePracticeDay(user.id, practiceDate);
    }

    let status: string;
    if (!service.enabled || service.paused) {
      status = 'SERVICE_PAUSED';
    } else if (
      !profile ||
      profile.initializationStatus !== UserPracticeInitializationStatus.READY
    ) {
      status = 'INITIALIZING';
    } else if (curriculum.initialized && curriculum.courses.every((course) => practiceDate > course.examDate) &&
      !['STARTED', 'COMPLETED'].includes(day?.status ?? '')) {
      status = 'TERM_COMPLETED';
    } else if (!day) {
      status = curriculum.courses.some((course) => course.status === 'ACTIVE' && course.topics.some((topic) => topic.learned))
        ? 'GENERATING' : 'NO_TEACHING_PROGRESS';
    } else if (
      day.status === DailyPracticeDayStatus.PENDING ||
      day.status === DailyPracticeDayStatus.PROCESSING
    ) {
      status = 'GENERATING';
    } else if (day.status === DailyPracticeDayStatus.PAUSED) {
      status = 'SERVICE_PAUSED';
    } else {
      status = day.status;
    }

    const revision = day?.activeRevision ?? null;
    const items = revision ? serializePlanItems(revision) : [];
    const personalizedItems = items.filter(
      (item) => item.source === DailyPracticePlanItemSource.PERSONALIZED,
    );
    const fixedItems = items.filter(
      (item) => item.source === DailyPracticePlanItemSource.ADMIN_FIXED,
    );

    return {
      practiceDate,
      curriculum,
      timeZone: window.timeZone,
      dayStartedAt: window.dayStartedAt.toISOString(),
      nextDayStartsAt: window.nextDayStartsAt.toISOString(),
      status,
      service,
      dayId: day?.id ?? null,
      supplemental: Boolean(
        day && day.createdAt.getTime() >= day.cycle.deadlineAt.getTime(),
      ),
      planRevisionId: revision?.id ?? null,
      generationSource: revision?.generationSource ?? null,
      generatedAt: revision?.generatedAt?.toISOString() ?? null,
      degradedReason: revision?.degradedReason ?? null,
      summary: sanitizeLearningSummary(revision?.summarySnapshot),
      personalizedItems,
      fixedItems,
      counts: {
        personalized: personalizedItems.length,
        fixed: fixedItems.length,
        total: items.length,
      },
      attempt: revision?.quizAttempt
        ? serializeAttempt(revision.quizAttempt)
        : null,
      suggestion: {
        targetPracticeDate: targetSuggestionDate,
        available: service.enabled && !service.paused && !suggestion && status !== 'TERM_COMPLETED',
        current: suggestion ? serializeSuggestion(suggestion) : null,
      },
      initialization: {
        status:
          profile?.initializationStatus ??
          UserPracticeInitializationStatus.PENDING,
        appliedAttempts: profile?.attemptCount ?? 0,
        totalAttempts,
      },
    };
  }

  async start(user: User, planRevisionId: string) {
    const revision = await this.prisma.dailyPracticePlanRevision.findFirst({
      where: { id: planRevisionId, day: { userId: user.id } },
      include: {
        day: {
          select: {
            id: true,
            practiceDate: true,
            activeRevisionId: true,
            status: true,
          },
        },
        items: {
          include: {
            question: {
              select: {
                id: true,
                type: true,
                enabled: true,
                origin: true,
                reviewStatus: true,
                reviewRevision: true,
                sourceRevision: true,
                sourceReviewStatus: true,
                knowledgeSources: {
                  where: { current: true },
                  select: { id: true },
                },
              },
            },
          },
        },
        quizAttempt: { select: { id: true } },
      },
    });
    if (!revision) {
      dailyPracticeNotFound(
        DAILY_PRACTICE_ERROR_CODES.planStale,
        '每日练习计划不存在或不属于当前用户',
      );
    }

    if (!revision.quizAttempt) {
      const service = await this.serviceState(new Date(), this.prisma, user.id);
      if (!service.enabled || service.paused) {
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.paused,
          service.reason ?? '每日一练服务当前已暂停',
        );
      }
      if (user.status !== AccountStatus.ACTIVE) {
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.planStale,
          '当前账号状态不能开始每日练习',
        );
      }
      const currentPracticeDate = practiceDateForInstant(new Date());
      if (
        practiceDateFromDbDate(revision.day.practiceDate) !==
        currentPracticeDate
      ) {
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.planStale,
          '只能开始当前练习日的每日计划',
        );
      }
      if (
        revision.day.activeRevisionId !== revision.id ||
        !revision.publishedAt ||
        revision.trigger === DailyPracticePlanTrigger.ADMIN_PREVIEW
      ) {
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.planStale,
          '每日练习计划已更新，请刷新后重试',
        );
      }
      const fixedOnlyNoContent =
        revision.day.status === DailyPracticeDayStatus.NO_CONTENT &&
        revision.items.length > 0 &&
        revision.items.every(
          (item) => item.source === DailyPracticePlanItemSource.ADMIN_FIXED,
        );
      if (
        !startableDayStatuses.has(revision.day.status) &&
        !fixedOnlyNoContent
      ) {
        if (
          revision.day.status === DailyPracticeDayStatus.PENDING ||
          revision.day.status === DailyPracticeDayStatus.PROCESSING
        ) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.generating,
            '每日练习计划仍在生成中',
          );
        }
        if (revision.day.status === DailyPracticeDayStatus.NO_CONTENT) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.noContent,
            '当前教学范围内没有可开始的每日练习题目',
          );
        }
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.planStale,
          '当前每日练习计划状态不能开始答题',
        );
      }
      try {
        this.assertStartableItems(revision.items);
        if (!await assertDailyQuestionEligibility(this.prisma, currentPracticeDate, revision.items)) {
          dailyPracticeConflict(DAILY_PRACTICE_ERROR_CODES.planStale, '题目内容或教学范围已变化，请等待重新生成');
        }
      } catch (error) {
        await this.prisma.dailyPracticeDay.updateMany({
          where: {
            id: revision.day.id,
            activeRevisionId: revision.id,
            status: {
              notIn: [
                DailyPracticeDayStatus.STARTED,
                DailyPracticeDayStatus.COMPLETED,
              ],
            },
          },
          data: {
            status: DailyPracticeDayStatus.STALE,
            lastErrorCategory: 'PLAN_ITEM_INVALIDATED',
            lastErrorMessage: '计划题目在开始前发生变化，等待安全重建',
          },
        });
        throw error;
      }
    }

    const result = await this.quizzes.startDailyPractice(user.id, revision.id);
    return { ...result, planRevisionId: revision.id };
  }

  async submitUserSuggestion(user: User, dto: DailyPracticeSuggestionDto) {
    const payload = normalizeSuggestionPayload(dto);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await lockDailyPracticeSettings(transaction);
        const now = new Date();
        const service = await this.serviceState(now, transaction, user.id);
        if (!service.enabled || service.paused) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.paused,
            service.reason ?? '每日一练服务当前已暂停',
          );
        }
        const targetPracticeDate = nextPracticeDate(
          practiceDateForInstant(now),
        );
        await this.validateSuggestionScope(
          transaction,
          payload,
          targetPracticeDate,
        );
        const suggestion = await transaction.dailyPracticeSuggestion.create({
          data: {
            targetUserId: user.id,
            submittedById: user.id,
            targetPracticeDate: practiceDateToDbDate(targetPracticeDate),
            userQuotaKey: `USER:${user.id}:${targetPracticeDate}`,
            payload: payload as unknown as Prisma.InputJsonValue,
          },
          select: {
            id: true,
            targetPracticeDate: true,
            payload: true,
            status: true,
            createdAt: true,
            submittedBy: { select: { role: true } },
          },
        });
        return serializeSuggestion(suggestion);
      }, serializableTransaction);
    } catch (error) {
      if (isUniqueConstraint(error, 'userQuotaKey')) {
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.suggestionLimit,
          '当前练习日已提交过一次明日建议',
        );
      }
      throw error;
    }
  }

  async history(user: User, query: DailyPracticePageQueryDto) {
    const skip = (query.page - 1) * query.pageSize;
    const where: Prisma.DailyPracticePlanRevisionWhereInput = {
      day: { userId: user.id, activeRevisionId: { not: null } },
      activeForDay: { isNot: null },
      generatedAt: { not: null },
    };
    const [total, revisions] = await Promise.all([
      this.prisma.dailyPracticePlanRevision.count({ where }),
      this.prisma.dailyPracticePlanRevision.findMany({
        where,
        include: {
          day: { select: { practiceDate: true, status: true } },
          ...PLAN_ITEMS_INCLUDE,
        },
        orderBy: [{ day: { practiceDate: 'desc' } }, { revision: 'desc' }],
        skip,
        take: query.pageSize,
      }),
    ]);
    return {
      items: revisions.map((revision) => serializeHistoryItem(revision)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async historyDetail(user: User, planRevisionId: string) {
    const revision = await this.prisma.dailyPracticePlanRevision.findFirst({
      where: {
        id: planRevisionId,
        trigger: { not: DailyPracticePlanTrigger.ADMIN_PREVIEW },
        activeForDay: { is: { userId: user.id } },
      },
      include: {
        day: { select: { practiceDate: true, status: true } },
        ...PLAN_ITEMS_INCLUDE,
      },
    });
    if (!revision || !revision.generatedAt) {
      throw new NotFoundException('每日练习历史不存在');
    }
    const items = serializePlanItems(revision);
    return {
      ...serializeHistoryItem(revision),
      personalizedItems: items.filter(
        (item) => item.source === DailyPracticePlanItemSource.PERSONALIZED,
      ),
      fixedItems: items.filter(
        (item) => item.source === DailyPracticePlanItemSource.ADMIN_FIXED,
      ),
      resultSummary: sanitizeResultSummary(revision.quizAttempt?.results),
    };
  }

  async getTestAccess() {
    const settings = await this.prisma.dailyPracticeSettings.findUniqueOrThrow({ where: { singletonId: 1 } });
    return { globalEnabled: settings.enabled, revision: settings.revision, userIds: internalTestUsers(settings.internalTestUserIds) };
  }

  async updateTestAccess(actor: User, targetUserId: string, dto: { enabled: boolean; expectedRevision: number }) {
    if (actor.role !== Role.ADMIN) throw new ForbiddenException('仅管理员可管理内部测试');
    await this.prisma.$transaction(async (transaction) => {
      await lockDailyPracticeSettings(transaction);
      const settings = await transaction.dailyPracticeSettings.findUniqueOrThrow({ where: { singletonId: 1 } });
      if (settings.enabled) throw new ConflictException('请先关闭每日一练总开关，再设置内部测试用户');
      if (settings.revision !== dto.expectedRevision) throw new ConflictException('服务设置已变化，请刷新后重试');
      const target = await transaction.user.findUnique({ where: { id: targetUserId }, select: { status: true } });
      if (!target || (dto.enabled && target.status !== AccountStatus.ACTIVE)) throw new BadRequestException('只能为活动用户开启内部测试');
      const ids = new Set(internalTestUsers(settings.internalTestUserIds));
      if (dto.enabled) ids.add(targetUserId); else ids.delete(targetUserId);
      await transaction.dailyPracticeSettings.update({ where: { singletonId: 1 }, data: { internalTestUserIds: [...ids].sort(), revision: { increment: 1 }, updatedById: actor.id } });
      await transaction.dailyPracticeDay.updateMany({
        where: { userId: targetUserId, status: { in: dto.enabled ? ['PAUSED'] : ['PENDING', 'PROCESSING', 'STALE'] }, practiceDate: practiceDateToDbDate(practiceDateForInstant(new Date())) },
        data: dto.enabled ? { status: 'PENDING', scheduledAt: new Date(), deadlineAt: new Date(Date.now() + DAILY_PRACTICE_SPREAD_WINDOW_MS) } : { status: 'PAUSED' },
      });
      await this.audit.record(actor.id, 'daily-practice.test-access.update', 'User', targetUserId, { enabled: dto.enabled, previousRevision: settings.revision }, transaction);
    }, serializableTransaction);
    return this.getTestAccess();
  }

  async getSettings() {
    const settings = await this.prisma.dailyPracticeSettings.findUniqueOrThrow({
      where: { singletonId: 1 },
      include: { updatedBy: { select: PUBLIC_USER_SELECT } },
    });
    return serializeSettings(settings, await this.serviceState(new Date()));
  }

  async updateSettings(user: User, dto: DailyPracticeSettingsUpdateDto) {
    const settings = await this.prisma.$transaction(async (transaction) => {
      await lockDailyPracticeSettings(transaction);
      const updated = await transaction.dailyPracticeSettings.updateMany({
        where: { singletonId: 1, revision: dto.expectedRevision },
        data: {
          enabled: dto.enabled,
          revision: { increment: 1 },
          reason: dto.reason.trim(),
          updatedById: user.id,
        },
      });
      if (!updated.count) {
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.serviceRevisionConflict,
          '每日一练服务设置已被其他管理员修改，请刷新后重试',
        );
      }
      const current = await transaction.dailyPracticeSettings.findUniqueOrThrow(
        {
          where: { singletonId: 1 },
          include: { updatedBy: { select: PUBLIC_USER_SELECT } },
        },
      );
      await this.audit.record(
        user.id,
        'daily-practice.settings.update',
        'DailyPracticeSettings',
        String(current.singletonId),
        {
          actorRole: user.role,
          enabled: current.enabled,
          previousRevision: dto.expectedRevision,
          revision: current.revision,
        },
        transaction,
      );
      return current;
    }, serializableTransaction);
    return serializeSettings(settings, await this.serviceState(new Date()));
  }

  async listServicePauses(query: DailyPracticePageQueryDto) {
    const skip = (query.page - 1) * query.pageSize;
    const [total, pauses] = await Promise.all([
      this.prisma.dailyPracticeServicePause.count(),
      this.prisma.dailyPracticeServicePause.findMany({
        include: {
          createdBy: { select: PUBLIC_USER_SELECT },
          cancelledBy: { select: PUBLIC_USER_SELECT },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: query.pageSize,
      }),
    ]);
    return {
      items: pauses.map(serializePause),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async createServicePause(
    user: User,
    dto: DailyPracticeServicePauseCreateDto,
  ) {
    const startsAt = parseInstant(dto.startsAt, '停服开始时间无效');
    const endsAt = parseInstant(dto.endsAt, '停服恢复时间无效');
    if (endsAt <= startsAt) {
      throw new BadRequestException('恢复时间必须晚于停服开始时间');
    }
    return this.prisma.$transaction(async (transaction) => {
      await lockDailyPracticeSettings(transaction);
      const overlap = await transaction.dailyPracticeServicePause.findFirst({
        where: {
          cancelledAt: null,
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
        select: { id: true },
      });
      if (overlap) {
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.serviceRevisionConflict,
          '停服时段与现有未取消时段重叠',
        );
      }
      const pause = await transaction.dailyPracticeServicePause.create({
        data: {
          startsAt,
          endsAt,
          reason: dto.reason.trim(),
          createdById: user.id,
        },
        include: {
          createdBy: { select: PUBLIC_USER_SELECT },
          cancelledBy: { select: PUBLIC_USER_SELECT },
        },
      });
      await this.audit.record(
        user.id,
        'daily-practice.service-pause.create',
        'DailyPracticeServicePause',
        pause.id,
        {
          actorRole: user.role,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
        transaction,
      );
      return serializePause(pause);
    }, serializableTransaction);
  }

  async cancelServicePause(user: User, id: string) {
    return this.prisma.$transaction(async (transaction) => {
      await lockDailyPracticeSettings(transaction);
      const existing = await transaction.dailyPracticeServicePause.findUnique({
        where: { id },
        include: {
          createdBy: { select: PUBLIC_USER_SELECT },
          cancelledBy: { select: PUBLIC_USER_SELECT },
        },
      });
      if (!existing) throw new NotFoundException('停服记录不存在');
      if (existing.cancelledAt) return serializePause(existing);
      const cancellation =
        await transaction.dailyPracticeServicePause.updateMany({
          where: { id, cancelledAt: null },
          data: { cancelledAt: new Date(), cancelledById: user.id },
        });
      const pause =
        await transaction.dailyPracticeServicePause.findUniqueOrThrow({
          where: { id },
          include: {
            createdBy: { select: PUBLIC_USER_SELECT },
            cancelledBy: { select: PUBLIC_USER_SELECT },
          },
        });
      if (!cancellation.count) return serializePause(pause);
      await this.audit.record(
        user.id,
        'daily-practice.service-pause.cancel',
        'DailyPracticeServicePause',
        id,
        { actorRole: user.role },
        transaction,
      );
      return serializePause(pause);
    }, serializableTransaction);
  }

  async listTeachingProgress(query: TeachingProgressQueryDto) {
    const where: Prisma.TeachingProgressWhereInput = query.subjectId
      ? { subjectId: query.subjectId }
      : {};
    const skip = (query.page - 1) * query.pageSize;
    const [total, progresses] = await Promise.all([
      this.prisma.teachingProgress.count({ where }),
      this.prisma.teachingProgress.findMany({
        where,
        include: {
          subject: { select: SUBJECT_SELECT },
          publishedBy: { select: PUBLIC_USER_SELECT },
          _count: { select: { nodes: true } },
        },
        orderBy: [
          { effectivePracticeDate: 'desc' },
          { subjectId: 'asc' },
          { version: 'desc' },
        ],
        skip,
        take: query.pageSize,
      }),
    ]);
    return {
      items: progresses.map(serializeTeachingProgressSummary),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async publishTeachingProgress(user: User, dto: TeachingProgressPublishDto) {
    const effectivePracticeDate = parsePracticeDate(
      dto.effectivePracticeDate,
      DAILY_PRACTICE_ERROR_CODES.progressConflict,
    );
    if (
      dto.changeType === TeachingProgressChangeType.CORRECTION &&
      !dto.correctionReason?.trim()
    ) {
      dailyPracticeBadRequest(
        DAILY_PRACTICE_ERROR_CODES.progressConflict,
        '更正教学进度必须填写更正原因',
      );
    }

    const progressId = await this.prisma
      .$transaction(async (transaction) => {
        await lockDailyPracticeSettings(transaction);
        const earliest = practiceDateForInstant(new Date());
        if (dto.effectivePracticeDate < earliest) {
          dailyPracticeBadRequest(
            DAILY_PRACTICE_ERROR_CODES.progressConflict,
            `教学进度最早只能从 ${earliest} 练习日生效`,
          );
        }
        const latest = await transaction.teachingProgress.findFirst({
          where: { subjectId: dto.subjectId },
          include: { nodes: true },
          orderBy: { version: 'desc' },
        });
        const currentVersion = latest?.version ?? 0;
        if (currentVersion !== dto.expectedVersion) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.progressConflict,
            '教学进度版本已变化，请刷新后重试',
          );
        }
        if (!latest && dto.changeType !== TeachingProgressChangeType.INITIAL) {
          dailyPracticeBadRequest(
            DAILY_PRACTICE_ERROR_CODES.progressConflict,
            '首个教学进度必须使用 INITIAL',
          );
        }
        if (latest && dto.changeType === TeachingProgressChangeType.INITIAL) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.progressConflict,
            '该学科已经发布过初始教学进度',
          );
        }
        if (
          latest &&
          (!dto.basedOnProgressId || dto.basedOnProgressId !== latest.id)
        ) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.progressConflict,
            '新修订必须基于该学科的最新教学进度',
          );
        }
        if (!latest && dto.basedOnProgressId) {
          dailyPracticeBadRequest(
            DAILY_PRACTICE_ERROR_CODES.progressConflict,
            '初始教学进度不能指定 basedOnProgressId',
          );
        }
        if (
          latest &&
          dto.effectivePracticeDate <
            practiceDateFromDbDate(latest.effectivePracticeDate)
        ) {
          dailyPracticeBadRequest(
            DAILY_PRACTICE_ERROR_CODES.progressConflict,
            '新修订的生效练习日不能早于所基于版本',
          );
        }

        const nodes = await this.normalizeTeachingNodes(
          transaction,
          dto,
          effectivePracticeDate,
        );
        if (dto.changeType === TeachingProgressChangeType.ADD && latest) {
          assertAddPreservesPreviousScope(latest.nodes, nodes);
        }
        const scopeHash = stableHash(
          nodes.map((node) => ({
            libraryId: node.libraryId,
            documentId: node.documentId,
            nodePathHash: node.nodePathHash,
            firstTaughtDate: practiceDateFromDbDate(node.firstTaughtDate),
            sourceDocumentVersionId: node.sourceDocumentVersionId,
            contentHashSnapshot: node.contentHashSnapshot,
          })),
        );
        const progress = await transaction.teachingProgress.create({
          data: {
            subjectId: dto.subjectId,
            version: currentVersion + 1,
            effectivePracticeDate,
            basedOnProgressId: latest?.id,
            changeType: dto.changeType,
            scopeHash,
            note: dto.note?.trim() || null,
            correctionReason: dto.correctionReason?.trim() || null,
            publishedById: user.id,
            nodes: { createMany: { data: nodes } },
          },
          select: { id: true, version: true },
        });
        await this.audit.record(
          user.id,
          'daily-practice.teaching-progress.publish',
          'TeachingProgress',
          progress.id,
          {
            actorRole: user.role,
            subjectId: dto.subjectId,
            version: progress.version,
            changeType: dto.changeType,
            nodeCount: nodes.length,
            effectivePracticeDate: dto.effectivePracticeDate,
          },
          transaction,
        );
        return progress.id;
      }, serializableTransaction)
      .catch((error: unknown) => {
        if (isPrismaWriteConflict(error)) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.progressConflict,
            '教学进度版本已变化，请刷新后重试',
          );
        }
        throw error;
      });
    return this.teachingProgressDetail(progressId);
  }

  async teachingProgressDetail(id: string) {
    const progress = await this.prisma.teachingProgress.findUnique({
      where: { id },
      include: {
        subject: { select: SUBJECT_SELECT },
        publishedBy: { select: PUBLIC_USER_SELECT },
        nodes: { orderBy: [{ documentId: 'asc' }, { nodePathHash: 'asc' }] },
        _count: { select: { nodes: true } },
      },
    });
    if (!progress) throw new NotFoundException('教学进度不存在');

    const resolved = await this.resolveTeachingNodes(
      progress.nodes,
      progress.subjectId,
    );
    const eligibleQuestionCount = await this.eligibleQuestionCountForProgress(
      progress.id,
    );
    return {
      ...serializeTeachingProgressSummary(progress),
      basedOnProgressId: progress.basedOnProgressId,
      nodes: progress.nodes.map((node) => {
        const current = resolved.get(
          `${node.documentId}\u0000${node.nodePathHash}`,
        );
        return {
          id: node.id,
          libraryId: node.libraryId,
          documentId: node.documentId,
          nodePathHash: node.nodePathHash,
          currentKnowledgeNodeId: current?.id ?? null,
          title: current?.title ?? node.titleSnapshot,
          breadcrumb: current?.breadcrumb ?? node.breadcrumbSnapshot,
          firstTaughtDate: practiceDateFromDbDate(node.firstTaughtDate),
          resolved: Boolean(current),
          remapped: current?.remapped ?? false,
          resolvedDocumentId: current?.resolvedDocumentId ?? null,
        };
      }),
      unresolvedNodeCount: progress.nodes.length - resolved.size,
      eligibleQuestionCount,
    };
  }

  async fixedQuestionCandidates(query: FixedQuestionCandidateQueryDto) {
    const practiceDate = query.practiceDate ?? nextPracticeDate(practiceDateForInstant(new Date()));
    parsePracticeDate(practiceDate, DAILY_PRACTICE_ERROR_CODES.fixedQuestionInvalid);
    const courses = await loadPracticeCourses(this.prisma);
    const courseScopeSql = dailyCurriculumEligibilitySql(courses, practiceDate);
    const skip = (query.page - 1) * query.pageSize;
    const whereSql = fixedQuestionCandidateWhereSql(query);
    const [countRows, idRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
        SELECT COUNT(*) AS total
        FROM QuizQuestion AS question
        INNER JOIN KnowledgeSubject AS subject ON subject.id = question.subjectId
        ${whereSql} AND ${courseScopeSql}
      `),
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT question.id
        FROM QuizQuestion AS question
        INNER JOIN KnowledgeSubject AS subject ON subject.id = question.subjectId
        ${whereSql} AND ${courseScopeSql}
        ORDER BY question.createdAt DESC, question.id DESC
        LIMIT ${query.pageSize} OFFSET ${skip}
      `),
    ]);
    const ids = idRows.map(({ id }) => id);
    const questions = ids.length
      ? await this.prisma.quizQuestion.findMany({
          where: { id: { in: ids } },
          select: FIXED_QUESTION_SELECT,
        })
      : [];
    const byId = new Map(questions.map((question) => [question.id, question]));
    return {
      items: ids.map((id) => serializeFixedQuestionCandidate(byId.get(id)!)),
      total: Number(countRows[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async fixedAssignments(practiceDate: string) {
    parsePracticeDate(
      practiceDate,
      DAILY_PRACTICE_ERROR_CODES.fixedAssignmentLocked,
    );
    const where = { practiceDate: practiceDateToDbDate(practiceDate) };
    const [historyTotal, assignments] = await Promise.all([
      this.prisma.dailyPracticeFixedAssignment.count({ where }),
      this.prisma.dailyPracticeFixedAssignment.findMany({
        where,
        include: fixedAssignmentInclude,
        orderBy: { revision: 'desc' },
        take: 50,
      }),
    ]);
    if (!assignments[0])
      throw new NotFoundException('该练习日尚未发布固定附加题');
    return {
      ...serializeFixedAssignment(assignments[0]),
      history: assignments.map(serializeFixedAssignment),
      historyTotal,
    };
  }

  async publishFixedAssignment(user: User, dto: FixedAssignmentPublishDto) {
    const practiceDate = parsePracticeDate(
      dto.practiceDate,
      DAILY_PRACTICE_ERROR_CODES.fixedAssignmentLocked,
    );
    if (new Set(dto.questionIds).size !== dto.questionIds.length) {
      dailyPracticeBadRequest(
        DAILY_PRACTICE_ERROR_CODES.fixedQuestionInvalid,
        '固定附加题不能重复选择同一道题',
      );
    }

    const assignmentId = await this.prisma
      .$transaction(async (transaction) => {
        await lockDailyPracticeSettings(transaction);
        const earliest = nextPracticeDate(practiceDateForInstant(new Date()));
        if (dto.practiceDate < earliest) {
          dailyPracticeBadRequest(
            DAILY_PRACTICE_ERROR_CODES.fixedAssignmentLocked,
            `固定附加题只能为 ${earliest} 或更晚的练习日发布`,
          );
        }
        const frozenCycle = await transaction.dailyPracticeCycle.findUnique({
          where: { practiceDate },
          select: { id: true },
        });
        if (frozenCycle) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.fixedAssignmentLocked,
            '目标练习日已经建立周期，固定附加题已冻结',
          );
        }
        const latest = await transaction.dailyPracticeFixedAssignment.findFirst(
          {
            where: { practiceDate },
            orderBy: { revision: 'desc' },
            select: { id: true, revision: true },
          },
        );
        const currentRevision = latest?.revision ?? 0;
        if (currentRevision !== dto.expectedRevision) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.fixedAssignmentLocked,
            '固定附加题修订已变化，请刷新后重试',
          );
        }
        const questions = await transaction.quizQuestion.findMany({
          where: { id: { in: dto.questionIds } },
          select: {
            id: true,
            type: true,
            prompt: true,
            enabled: true,
            origin: true,
            reviewStatus: true,
            reviewRevision: true,
            subject: { select: { active: true } },
            chapters: { select: { chapter: { select: { active: true } } } },
          },
        });
        if (
          questions.length !== dto.questionIds.length ||
          questions.some(
            (question) =>
              !question.enabled ||
              question.reviewStatus !== QuizQuestionReviewStatus.APPROVED ||
              (question.origin !== QuizQuestionOrigin.MANUAL &&
                question.origin !== QuizQuestionOrigin.CSV) ||
              !question.subject.active ||
              question.chapters.length < 1 ||
              question.chapters.some(({ chapter }) => !chapter.active),
          )
        ) {
          dailyPracticeBadRequest(
            DAILY_PRACTICE_ERROR_CODES.fixedQuestionInvalid,
            '固定附加题只能选择启用、已审核的 MANUAL/CSV 非 AI 题',
          );
        }
        const eligible = await loadEligiblePracticeQuestions(transaction, dto.practiceDate, { questionIds: dto.questionIds });
        if (questions.filter((question) => question.type === QuestionType.SHORT_ANSWER).length > 1) {
          dailyPracticeBadRequest(DAILY_PRACTICE_ERROR_CODES.fixedQuestionInvalid, '整份每日练习最多包含一道简答题，固定题中不能选择多道简答题');
        }
        if (eligible.length !== dto.questionIds.length) {
          dailyPracticeBadRequest(DAILY_PRACTICE_ERROR_CODES.fixedQuestionInvalid, '固定题必须属于目标练习日两科已学的有效主题');
        }
        const byId = new Map(
          questions.map((question) => [question.id, question]),
        );
        const snapshots = dto.questionIds.map((questionId, index) => {
          const question = byId.get(questionId)!;
          return {
            ordinal: index + 1,
            questionId,
            questionReviewRevision: question.reviewRevision,
            promptHash: sha256Utf8(question.prompt),
          };
        });
        const assignmentHash = stableHash({
          practiceDate: dto.practiceDate,
          questions: snapshots,
        });
        const assignment =
          await transaction.dailyPracticeFixedAssignment.create({
            data: {
              practiceDate,
              revision: currentRevision + 1,
              basedOnAssignmentId: latest?.id,
              assignmentHash,
              note: dto.note?.trim() || null,
              publishedById: user.id,
              ...(snapshots.length
                ? { questions: { createMany: { data: snapshots } } }
                : {}),
            },
            select: { id: true, revision: true },
          });
        await this.audit.record(
          user.id,
          'daily-practice.fixed-assignment.publish',
          'DailyPracticeFixedAssignment',
          assignment.id,
          {
            actorRole: user.role,
            practiceDate: dto.practiceDate,
            revision: assignment.revision,
            questionCount: snapshots.length,
          },
          transaction,
        );
        return assignment.id;
      }, serializableTransaction)
      .catch((error: unknown) => {
        if (isPrismaWriteConflict(error)) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.fixedAssignmentLocked,
            '固定附加题修订已变化，请刷新后重试',
          );
        }
        throw error;
      });
    const assignment =
      await this.prisma.dailyPracticeFixedAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
        include: fixedAssignmentInclude,
      });
    return serializeFixedAssignment(assignment);
  }

  async cycleAggregate(practiceDate: string) {
    const practiceDateDb = parsePracticeDate(
      practiceDate,
      DAILY_PRACTICE_ERROR_CODES.noContent,
    );
    const cycle = await this.prisma.dailyPracticeCycle.findUnique({
      where: { practiceDate: practiceDateDb },
      select: {
        id: true,
        practiceDate: true,
        status: true,
        baselineAt: true,
        deadlineAt: true,
        progressSetHash: true,
        progressSnapshot: true,
        poolStats: true,
        refreezeRequestedAt: true,
      },
    });
    if (!cycle) throw new NotFoundException('每日练习周期不存在');

    const now = new Date();
    const currentAccess = practiceDate === practiceDateForInstant(now);
    const settings = currentAccess
      ? await this.prisma.dailyPracticeSettings.findUniqueOrThrow({
        where: { singletonId: 1 },
        select: { enabled: true, internalTestUserIds: true },
      })
      : null;
    const testIds = settings && !settings.enabled ? internalTestUsers(settings.internalTestUserIds) : null;
    const userWhere: Prisma.UserWhereInput = {
      status: AccountStatus.ACTIVE,
      ...(testIds ? { id: { in: testIds } } : {}),
    };
    const dayWhere: Prisma.DailyPracticeDayWhereInput = {
      cycleId: cycle.id,
      ...(currentAccess ? { user: userWhere } : {}),
    };
    const accessSql = !currentAccess ? Prisma.empty : Prisma.sql`
      AND day.userId IN (SELECT id FROM User WHERE status = 'ACTIVE'
        ${testIds ? (testIds.length ? Prisma.sql`AND id IN (${Prisma.join(testIds)})` : Prisma.sql`AND 1 = 0`) : Prisma.empty})
    `;
    const [statusRows, generationRows, latencyRows, usageRows, targetUsers, nextDay] =
      await Promise.all([
        this.prisma.dailyPracticeDay.groupBy({
          by: ['status'],
          where: dayWhere,
          _count: { _all: true },
        }),
        this.prisma.$queryRaw<
          Array<{
            generationSource: DailyPracticeGenerationSource;
            total: bigint | number;
          }>
        >(Prisma.sql`
          SELECT revision.generationSource, COUNT(*) AS total
          FROM DailyPracticeDay AS day
          INNER JOIN DailyPracticePlanRevision AS revision
            ON revision.id = day.activeRevisionId
          WHERE day.cycleId = ${cycle.id}
            ${accessSql}
            AND day.status IN (${Prisma.join(availableDayStatuses)})
            AND EXISTS (SELECT 1 FROM DailyPracticePlanItem item WHERE item.revisionId = revision.id)
          GROUP BY revision.generationSource
        `),
        this.prisma.$queryRaw<
          Array<{ p50: number | null; p95: number | null }>
        >(Prisma.sql`
          SELECT
            MAX(CASE WHEN ranked.rowNumber = CEIL(ranked.totalRows * 0.50)
              THEN ranked.latencyMs END) AS p50,
            MAX(CASE WHEN ranked.rowNumber = CEIL(ranked.totalRows * 0.95)
              THEN ranked.latencyMs END) AS p95
          FROM (
            SELECT
              invocation.latencyMs,
              ROW_NUMBER() OVER (ORDER BY invocation.latencyMs) AS rowNumber,
              COUNT(*) OVER () AS totalRows
            FROM AiInvocation AS invocation
            INNER JOIN DailyPracticePlanRevision AS revision
              ON invocation.correlationType = 'DailyPracticePlanRevision'
              AND invocation.correlationId = revision.id
            INNER JOIN DailyPracticeDay AS day
              ON day.id = revision.dayId
            WHERE day.cycleId = ${cycle.id}
              AND invocation.latencyMs IS NOT NULL
          ) AS ranked
        `),
        this.prisma.$queryRaw<
          Array<{
            calls: bigint | number;
            inputTokens: bigint | number;
            outputTokens: bigint | number;
          }>
        >(Prisma.sql`
          SELECT
            COUNT(invocation.id) AS calls,
            COALESCE(SUM(invocation.inputTokens), 0) AS inputTokens,
            COALESCE(SUM(invocation.outputTokens), 0) AS outputTokens
          FROM AiInvocation AS invocation
          INNER JOIN DailyPracticePlanRevision AS revision
            ON invocation.correlationType = 'DailyPracticePlanRevision'
            AND invocation.correlationId = revision.id
          INNER JOIN DailyPracticeDay AS day
            ON day.id = revision.dayId
          WHERE day.cycleId = ${cycle.id}
        `),
        currentAccess ? this.prisma.user.count({ where: userWhere }) : Promise.resolve(null),
        this.prisma.dailyPracticeDay.findFirst({
          where: { ...dayWhere, status: { in: ['PENDING', 'STALE'] }, scheduledAt: { gt: now } },
          select: { scheduledAt: true },
          orderBy: { scheduledAt: 'asc' },
        }),
      ]);

    const statusCounts = Object.fromEntries(
      statusRows.map((row) => [row.status, row._count._all]),
    );
    const generationCounts = Object.fromEntries(
      generationRows.map((row) => [row.generationSource, Number(row.total)]),
    );
    const enqueuedUsers = statusRows.reduce(
      (sum, row) => sum + row._count._all,
      0,
    );
    const totalUsers = Math.max(targetUsers ?? enqueuedUsers, enqueuedUsers);
    const availableUsers = generationRows.reduce((sum, row) => sum + Number(row.total), 0);
    const fallbackReadyUsers = generationCounts.DETERMINISTIC ?? 0;
    const poolStats = jsonObject(cycle.poolStats);
    const usage = usageRows[0];
    return {
      practiceDate: practiceDateFromDbDate(cycle.practiceDate),
      status: cycle.status,
      baselineAt: cycle.baselineAt.toISOString(),
      deadlineAt: cycle.deadlineAt.toISOString(),
      totalUsers,
      statusCounts,
      generationCounts,
      progressPercent:
        totalUsers > 0
          ? Math.round((availableUsers / totalUsers) * 10_000) / 100
          : 0,
      progress: {
        scope: currentAccess ? 'CURRENT_ACCESS' as const : 'CYCLE' as const,
        checkedAt: now.toISOString(),
        enqueuedUsers,
        missingUsers: totalUsers - enqueuedUsers,
        availableUsers,
        aiReadyUsers: availableUsers - fallbackReadyUsers - (generationCounts.NO_MODEL ?? 0),
        fallbackReadyUsers,
        nextScheduledAt: nextDay?.scheduledAt.toISOString() ?? null,
      },
      latencyMs: {
        p50: nullableNumber(latencyRows[0]?.p50),
        p95: nullableNumber(latencyRows[0]?.p95),
      },
      usage: {
        calls: Number(usage?.calls ?? 0),
        inputTokens: String(usage?.inputTokens ?? 0),
        outputTokens: String(usage?.outputTokens ?? 0),
      },
      gapSummary: sanitizeGapSummary(poolStats?.gapSummary),
      invalidFixedQuestionCount: stringArray(
        poolStats?.invalidFixedQuestionIds,
        20,
        191,
      ).length,
      progressSetHash: cycle.progressSetHash,
      refreezeRequestedAt: cycle.refreezeRequestedAt?.toISOString() ?? null,
      pool: summarizeCyclePool(cycle.progressSnapshot, poolStats),
    };
  }

  async listCycles(query: DailyPracticeCycleQueryDto) {
    const currentPracticeDate = practiceDateForInstant(new Date());
    const to = query.to
      ? parsePracticeDate(query.to, DAILY_PRACTICE_ERROR_CODES.noContent)
      : practiceDateToDbDate(currentPracticeDate);
    const from = query.from
      ? parsePracticeDate(query.from, DAILY_PRACTICE_ERROR_CODES.noContent)
      : new Date(to.getTime() - 13 * 86_400_000);
    const where: Prisma.DailyPracticeCycleWhereInput = {
      practiceDate: { gte: from, lte: to },
    };
    const skip = (query.page - 1) * query.pageSize;
    const [total, cycles] = await Promise.all([
      this.prisma.dailyPracticeCycle.count({ where }),
      this.prisma.dailyPracticeCycle.findMany({
        where,
        select: {
          practiceDate: true,
          status: true,
          baselineAt: true,
          deadlineAt: true,
          refreezeRequestedAt: true,
          counts: true,
          poolStats: true,
        },
        orderBy: { practiceDate: 'desc' },
        skip,
        take: query.pageSize,
      }),
    ]);
    return {
      items: cycles.map(serializeCycleListItem),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async requestCycleRefreeze(user: User, practiceDate: string) {
    const practiceDateDb = parsePracticeDate(
      practiceDate,
      DAILY_PRACTICE_ERROR_CODES.noContent,
    );
    if (practiceDate !== practiceDateForInstant(new Date())) {
      dailyPracticeConflict(
        DAILY_PRACTICE_ERROR_CODES.cycleRefreezeDateConflict,
        '仅当前练习日可请求重新冻结',
      );
    }
    const cycle = await this.prisma.dailyPracticeCycle.findUnique({
      where: { practiceDate: practiceDateDb },
      select: { id: true, status: true },
    });
    if (!cycle) throw new NotFoundException('每日练习周期不存在');
    const rebuildableDayCount = await this.prisma.dailyPracticeDay.count({
      where: {
        cycleId: cycle.id,
        startedAt: null,
        completedAt: null,
        status: { in: rebuildableDayStatuses },
      },
    });
    if (!rebuildableDayCount) {
      dailyPracticeConflict(
        DAILY_PRACTICE_ERROR_CODES.cycleNoRebuildableDays,
        '该练习日周期内没有可重建的每日计划，无法请求重新冻结',
      );
    }
    return this.prisma.$transaction(async (transaction) => {
      const requestedAt = new Date();
      const claimed = await transaction.dailyPracticeCycle.updateMany({
        where: { id: cycle.id, refreezeRequestedAt: null },
        data: {
          refreezeRequestedAt: requestedAt,
          refreezeRequestedById: user.id,
        },
      });
      if (!claimed.count) {
        const current = await transaction.dailyPracticeCycle.findUniqueOrThrow({
          where: { id: cycle.id },
          select: { refreezeRequestedAt: true },
        });
        return {
          practiceDate,
          status: cycle.status,
          refreezeRequestedAt:
            current.refreezeRequestedAt?.toISOString() ?? null,
          rebuildableDayCount,
          alreadyRequested: true,
        };
      }
      await this.audit.record(
        user.id,
        'daily-practice.cycle.refreeze',
        'DailyPracticeCycle',
        cycle.id,
        {
          actorRole: user.role,
          practiceDate,
          rebuildableDayCount,
        },
        transaction,
      );
      return {
        practiceDate,
        status: cycle.status,
        refreezeRequestedAt: requestedAt.toISOString(),
        rebuildableDayCount,
        alreadyRequested: false,
      };
    }, serializableTransaction);
  }

  async adminUsers(query: AdminDailyPracticeUsersQueryDto) {
    const practiceDate = practiceDateForInstant(new Date());
    const practiceDateDb = practiceDateToDbDate(practiceDate);
    const targetSuggestionDateDb = practiceDateToDbDate(
      nextPracticeDate(practiceDate),
    );
    const and: Prisma.UserWhereInput[] = [];
    if (query.initializationStatus) {
      if (
        query.initializationStatus === UserPracticeInitializationStatus.PENDING
      ) {
        and.push({
          OR: [
            { practiceProfile: { is: null } },
            {
              practiceProfile: {
                is: { initializationStatus: query.initializationStatus },
              },
            },
          ],
        });
      } else {
        and.push({
          practiceProfile: {
            is: { initializationStatus: query.initializationStatus },
          },
        });
      }
    }
    const requestedDayStatus = query.todayStatus ?? query.planStatus;
    const dayFilter: Prisma.DailyPracticeDayWhereInput = {
      practiceDate: practiceDateDb,
      ...(requestedDayStatus ? { status: requestedDayStatus } : {}),
      ...(query.generationSource
        ? {
            activeRevision: {
              is: { generationSource: query.generationSource },
            },
          }
        : {}),
    };
    if (requestedDayStatus || query.generationSource) {
      and.push({ dailyPracticeDays: { some: dayFilter } });
    }
    if (query.completed !== undefined) {
      and.push({
        dailyPracticeDays: query.completed
          ? {
              some: {
                practiceDate: practiceDateDb,
                status: DailyPracticeDayStatus.COMPLETED,
              },
            }
          : {
              none: {
                practiceDate: practiceDateDb,
                status: DailyPracticeDayStatus.COMPLETED,
              },
            },
      });
    }
    if (query.suggestionStatus) {
      and.push({
        dailySuggestionsReceived: {
          some: {
            targetPracticeDate: targetSuggestionDateDb,
            status: query.suggestionStatus,
          },
        },
      });
    }
    if (query.hasSuggestion !== undefined) {
      and.push({
        dailySuggestionsReceived: query.hasSuggestion
          ? { some: { targetPracticeDate: targetSuggestionDateDb } }
          : { none: { targetPracticeDate: targetSuggestionDateDb } },
      });
    }
    if (query.hasGap !== undefined) {
      const gapStatuses = [
        DailyPracticeDayStatus.LIMITED_CONTENT,
        DailyPracticeDayStatus.NO_CONTENT,
        DailyPracticeDayStatus.DEGRADED_READY,
        DailyPracticeDayStatus.FAILED,
      ];
      and.push({
        dailyPracticeDays: query.hasGap
          ? {
              some: {
                practiceDate: practiceDateDb,
                status: { in: gapStatuses },
              },
            }
          : {
              none: {
                practiceDate: practiceDateDb,
                status: { in: gapStatuses },
              },
            },
      });
    }
    const where: Prisma.UserWhereInput = {
      ...(query.search
        ? { displayName: { contains: query.search.trim() } }
        : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(and.length ? { AND: and } : {}),
    };
    const skip = (query.page - 1) * query.pageSize;
    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          displayName: true,
          role: true,
          status: true,
          practiceProfile: {
            select: {
              initializationStatus: true,
              attemptCount: true,
            },
          },
          dailyPracticeDays: {
            where: { practiceDate: practiceDateDb },
            select: {
              status: true,
              activeRevision: {
                select: {
                  generationSource: true,
                  generatedAt: true,
                },
              },
            },
            take: 1,
          },
          dailySuggestionsReceived: {
            where: { targetPracticeDate: targetSuggestionDateDb },
            select: { status: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          _count: {
            select: {
              quizAttempts: { where: { submittedAt: { not: null } } },
            },
          },
        },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        skip,
        take: query.pageSize,
      }),
    ]);
    return {
      items: users.map(serializeAdminUserSummary),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async adminUserDetail(userId: string) {
    const practiceDate = practiceDateForInstant(new Date());
    const practiceDateDb = practiceDateToDbDate(practiceDate);
    const targetSuggestionDateDb = practiceDateToDbDate(
      nextPracticeDate(practiceDate),
    );
    const [
      user,
      today,
      knowledgeStates,
      chapterStates,
      revisions,
      suggestions,
      knowledgeStatesTotal,
      chapterStatesTotal,
      planRevisionsTotal,
      suggestionsTotal,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          displayName: true,
          role: true,
          status: true,
          practiceProfile: {
            select: {
              initializationStatus: true,
              attemptCount: true,
              stateRevision: true,
            },
          },
          _count: {
            select: {
              quizAttempts: { where: { submittedAt: { not: null } } },
            },
          },
        },
      }),
      this.prisma.dailyPracticeDay.findUnique({
        where: {
          userId_practiceDate: { userId, practiceDate: practiceDateDb },
        },
        select: {
          id: true,
          practiceDate: true,
          status: true,
          profileRevision: true,
          progressSetHash: true,
          candidateSnapshot: true,
          fixedQuestionSnapshot: true,
          candidateHash: true,
          activeRevisionId: true,
          activeRevision: {
            include: PLAN_ITEMS_INCLUDE,
          },
          cycle: {
            select: {
              fixedAssignmentId: true,
              frozenFixedAssignmentHash: true,
              poolStats: true,
            },
          },
        },
      }),
      this.prisma.userQuestionState.findMany({
        where: { userId, question: { subject: { slug: { in: [...PRACTICE_SUBJECT_SLUGS] } } } },
        select: {
          id: true,
          question: { select: { subjectId: true, prompt: true, subject: { select: { name: true } } } },
          masteryBps: true,
          attemptCount: true,
          wrongCount: true,
          nextReviewAt: true,
          lastPracticedAt: true,
        },
        orderBy: [{ wrongCount: 'desc' }, { updatedAt: 'desc' }],
        take: 100,
      }),
      this.prisma.userChapterState.findMany({
        where: { userId, subjectChapter: { subject: { slug: { in: [...PRACTICE_SUBJECT_SLUGS] } } } },
        select: {
          id: true,
          subjectChapter: {
            select: {
              name: true,
              subjectId: true,
              subject: { select: { name: true } },
            },
          },
          masteryBps: true,
          attemptCount: true,
          wrongCount: true,
          nextReviewAt: true,
          lastPracticedAt: true,
        },
        orderBy: [{ wrongCount: 'desc' }, { updatedAt: 'desc' }],
        take: 100,
      }),
      this.prisma.dailyPracticePlanRevision.findMany({
        where: { day: { userId }, generatedAt: { not: null } },
        select: {
          id: true,
          revision: true,
          trigger: true,
          generationSource: true,
          generatedAt: true,
          createdAt: true,
          day: { select: { practiceDate: true, activeRevisionId: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.dailyPracticeSuggestion.findMany({
        where: { targetUserId: userId },
        select: {
          id: true,
          targetPracticeDate: true,
          payload: true,
          status: true,
          createdAt: true,
          submittedBy: { select: { role: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.userQuestionState.count({ where: { userId, question: { subject: { slug: { in: [...PRACTICE_SUBJECT_SLUGS] } } } } }),
      this.prisma.userChapterState.count({ where: { userId, subjectChapter: { subject: { slug: { in: [...PRACTICE_SUBJECT_SLUGS] } } } } }),
      this.prisma.dailyPracticePlanRevision.count({
        where: { day: { userId }, generatedAt: { not: null } },
      }),
      this.prisma.dailyPracticeSuggestion.count({
        where: { targetUserId: userId },
      }),
    ]);
    if (!user) throw new NotFoundException('用户不存在');
    const nextSuggestion = await this.prisma.dailyPracticeSuggestion.findFirst({
      where: {
        targetUserId: userId,
        targetPracticeDate: targetSuggestionDateDb,
      },
      select: { status: true },
      orderBy: { createdAt: 'desc' },
    });
    const summary = serializeAdminUserSummary({
      ...user,
      dailyPracticeDays: today ? [today] : [],
      dailySuggestionsReceived: nextSuggestion ? [nextSuggestion] : [],
    });
    const candidateQuestions = sanitizeAdminCandidateQuestions(
      today?.candidateSnapshot,
    );
    const frozenFixedQuestions = sanitizeAdminFrozenFixedQuestions(
      today?.fixedQuestionSnapshot,
    );
    const invalidFixedQuestionIds = stringArray(
      jsonObject(today?.cycle.poolStats)?.invalidFixedQuestionIds,
      20,
      191,
    );
    const finalItems = today?.activeRevision
      ? serializePlanItems(today.activeRevision)
      : [];
    return {
      ...summary,
      profileRevision: user.practiceProfile?.stateRevision ?? 0,
      summary: sanitizeLearningSummary(today?.activeRevision?.summarySnapshot),
      knowledgeStatesTotal,
      knowledgeStates: knowledgeStates.map((state) => ({
        id: state.id,
        subjectId: state.question.subjectId,
        subject: state.question.subject.name,
        label: state.question.prompt.slice(0, 200),
        masteryBps: state.masteryBps,
        attemptCount: state.attemptCount,
        wrongCount: state.wrongCount,
        nextReviewAt: state.nextReviewAt?.toISOString() ?? null,
        lastPracticedAt: state.lastPracticedAt?.toISOString() ?? null,
      })),
      chapterStatesTotal,
      chapterStates: chapterStates.map((state) => ({
        id: state.id,
        subjectId: state.subjectChapter.subjectId,
        subject: state.subjectChapter.subject.name,
        label: state.subjectChapter.name,
        masteryBps: state.masteryBps,
        attemptCount: state.attemptCount,
        wrongCount: state.wrongCount,
        nextReviewAt: state.nextReviewAt?.toISOString() ?? null,
        lastPracticedAt: state.lastPracticedAt?.toISOString() ?? null,
      })),
      todayPlan: today
        ? {
            dayId: today.id,
            practiceDate: practiceDateFromDbDate(today.practiceDate),
            profileRevision: today.profileRevision,
            progressSetHash: today.progressSetHash,
            candidateHash: today.candidateHash,
            inputHash: today.activeRevision?.inputHash ?? null,
            outputHash: today.activeRevision?.outputHash ?? null,
            candidateQuestions,
            personalizedItems: finalItems.filter(
              (item) =>
                item.source === DailyPracticePlanItemSource.PERSONALIZED,
            ),
            fixedItems: finalItems.filter(
              (item) => item.source === DailyPracticePlanItemSource.ADMIN_FIXED,
            ),
            fixedAssignment:
              today.cycle.fixedAssignmentId ||
              frozenFixedQuestions.length ||
              invalidFixedQuestionIds.length
                ? {
                    assignmentId: today.cycle.fixedAssignmentId,
                    hash: today.cycle.frozenFixedAssignmentHash,
                    validCount: frozenFixedQuestions.length,
                    invalidCount: invalidFixedQuestionIds.length,
                    invalidQuestionIds: invalidFixedQuestionIds,
                    questions: frozenFixedQuestions,
                  }
                : null,
          }
        : null,
      planRevisionsTotal,
      planRevisions: revisions.map((revision) => ({
        id: revision.id,
        practiceDate: practiceDateFromDbDate(revision.day.practiceDate),
        revision: revision.revision,
        trigger: revision.trigger,
        generationSource: revision.generationSource,
        generatedAt: (revision.generatedAt ?? revision.createdAt).toISOString(),
        active: revision.day.activeRevisionId === revision.id,
      })),
      suggestionsTotal,
      suggestions: suggestions.map(serializeSuggestion),
    };
  }

  async submitAdminSuggestion(
    user: User,
    targetUserId: string,
    dto: AdminDailyPracticeSuggestionDto,
  ) {
    const targetDate = parsePracticeDate(
      dto.targetPracticeDate,
      DAILY_PRACTICE_ERROR_CODES.suggestionOutOfScope,
    );
    const payload = normalizeSuggestionPayload(dto);

    const suggestionId = await this.prisma.$transaction(async (transaction) => {
      await lockDailyPracticeSettings(transaction);
      const earliest = nextPracticeDate(practiceDateForInstant(new Date()));
      if (dto.targetPracticeDate < earliest) {
        dailyPracticeBadRequest(
          DAILY_PRACTICE_ERROR_CODES.suggestionOutOfScope,
          `管理员建议只能面向 ${earliest} 或更晚的练习日`,
        );
      }
      const lockedUsers = await transaction.$queryRaw<
        Array<{ id: string; status: AccountStatus }>
      >(
        Prisma.sql`
            SELECT id, status
            FROM User
            WHERE id = ${targetUserId}
            FOR UPDATE
          `,
      );
      if (lockedUsers[0]?.status !== AccountStatus.ACTIVE) {
        throw new NotFoundException('活动用户不存在');
      }
      await this.validateSuggestionScope(
        transaction,
        payload,
        dto.targetPracticeDate,
      );
      const previous = await transaction.dailyPracticeSuggestion.findFirst({
        where: {
          targetUserId,
          targetPracticeDate: targetDate,
          userQuotaKey: null,
          status: DailyPracticeSuggestionStatus.PENDING,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      await transaction.dailyPracticeSuggestion.updateMany({
        where: {
          targetUserId,
          targetPracticeDate: targetDate,
          userQuotaKey: null,
          status: DailyPracticeSuggestionStatus.PENDING,
        },
        data: { status: DailyPracticeSuggestionStatus.SUPERSEDED },
      });
      const suggestion = await transaction.dailyPracticeSuggestion.create({
        data: {
          targetUserId,
          submittedById: user.id,
          targetPracticeDate: targetDate,
          userQuotaKey: null,
          payload: payload as unknown as Prisma.InputJsonValue,
          supersedesId: previous?.id,
        },
        select: { id: true },
      });
      await this.audit.record(
        user.id,
        'daily-practice.admin-suggestion.create',
        'DailyPracticeSuggestion',
        suggestion.id,
        {
          actorRole: user.role,
          targetUserId,
          targetPracticeDate: dto.targetPracticeDate,
          supersedesId: previous?.id ?? null,
        },
        transaction,
      );
      return suggestion.id;
    }, serializableTransaction);
    const suggestion =
      await this.prisma.dailyPracticeSuggestion.findUniqueOrThrow({
        where: { id: suggestionId },
        select: {
          id: true,
          targetPracticeDate: true,
          payload: true,
          status: true,
          createdAt: true,
          submittedBy: { select: { role: true } },
        },
      });
    return serializeSuggestion(suggestion);
  }

  async createAdminPlanRevision(
    user: User,
    targetUserId: string,
    practiceDate: string,
    trigger:
      | typeof DailyPracticePlanTrigger.ADMIN_REGENERATE
      | typeof DailyPracticePlanTrigger.ADMIN_PREVIEW,
  ) {
    const practiceDateDb = parsePracticeDate(
      practiceDate,
      DAILY_PRACTICE_ERROR_CODES.planStale,
    );
    return this.prisma.$transaction(async (transaction) => {
      await lockDailyPracticeSettings(transaction);
      const lockedUsers = await transaction.$queryRaw<
        Array<{ id: string; status: AccountStatus }>
      >(
        Prisma.sql`
            SELECT id, status
            FROM User
            WHERE id = ${targetUserId}
            FOR UPDATE
          `,
      );
      if (lockedUsers[0]?.status !== AccountStatus.ACTIVE) {
        throw new NotFoundException('活动用户不存在');
      }
      {
        const service = await this.serviceState(new Date(), transaction, targetUserId);
        if (!service.enabled || service.paused) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.paused,
            service.reason ?? '每日一练服务当前已暂停',
          );
        }
      }
      const lockedDays = await transaction.$queryRaw<
        Array<{
          id: string;
          status: DailyPracticeDayStatus;
          startedAt: Date | null;
          completedAt: Date | null;
          activeRevisionId: string | null;
        }>
      >(Prisma.sql`
          SELECT id, status, startedAt, completedAt, activeRevisionId
          FROM DailyPracticeDay
          WHERE userId = ${targetUserId}
            AND practiceDate = ${practiceDateDb}
          FOR UPDATE
        `);
      const day = lockedDays[0];
      if (!day) {
        dailyPracticeNotFound(
          DAILY_PRACTICE_ERROR_CODES.noContent,
          '目标用户在该练习日尚无每日计划任务',
        );
      }
      const activeAttempt = day.activeRevisionId
        ? await transaction.quizAttempt.findUnique({
            where: {
              dailyPracticePlanRevisionId: day.activeRevisionId,
            },
            select: { id: true },
          })
        : null;
      if (
        trigger === DailyPracticePlanTrigger.ADMIN_REGENERATE &&
        (day.startedAt ||
          day.completedAt ||
          activeAttempt ||
          day.status === DailyPracticeDayStatus.STARTED ||
          day.status === DailyPracticeDayStatus.COMPLETED)
      ) {
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.planAlreadyStarted,
          '已经开始或完成的计划不能替换，只能创建诊断预览',
        );
      }
      const latest = await transaction.dailyPracticePlanRevision.findFirst({
        where: { dayId: day.id },
        orderBy: { revision: 'desc' },
        select: { revision: true },
      });
      const revision = await transaction.dailyPracticePlanRevision.create({
        data: {
          dayId: day.id,
          revision: (latest?.revision ?? 0) + 1,
          trigger,
          promptVersion: DAILY_PERSONALIZATION_PROMPT_VERSION,
          generationSource: DailyPracticeGenerationSource.NO_MODEL,
          createdById: user.id,
        },
        select: { id: true, revision: true },
      });
      let status = day.status;
      if (trigger === DailyPracticePlanTrigger.ADMIN_REGENERATE) {
        const updated = await transaction.dailyPracticeDay.update({
          where: { id: day.id },
          data: {
            status: DailyPracticeDayStatus.PENDING,
            lastErrorCategory: null,
            lastErrorMessage: null,
          },
          select: { status: true },
        });
        status = updated.status;
      }
      await this.audit.record(
        user.id,
        trigger === DailyPracticePlanTrigger.ADMIN_REGENERATE
          ? 'daily-practice.plan.regenerate'
          : 'daily-practice.plan.preview',
        'DailyPracticePlanRevision',
        revision.id,
        {
          actorRole: user.role,
          targetUserId,
          practiceDate,
          revision: revision.revision,
        },
        transaction,
      );
      return {
        dayId: day.id,
        practiceDate,
        revision: revision.revision,
        trigger,
        status,
      };
    }, serializableTransaction);
  }

  private async serviceState(
    now: Date,
    client: DatabaseClient = this.prisma,
    userId?: string,
  ): Promise<ServiceState> {
    const [settings, pause] = await Promise.all([
      client.dailyPracticeSettings.findUnique({
        where: { singletonId: 1 },
        select: { enabled: true, revision: true, reason: true, internalTestUserIds: true },
      }),
      client.dailyPracticeServicePause.findFirst({
        where: {
          cancelledAt: null,
          startsAt: { lte: now },
          endsAt: { gt: now },
        },
        orderBy: { endsAt: 'asc' },
        select: { reason: true, endsAt: true },
      }),
    ]);
    return {
      enabled: hasDailyPracticeAccess(settings, userId),
      paused: Boolean(pause),
      reason:
        pause?.reason ??
        (hasDailyPracticeAccess(settings, userId)
          ? null
          : (settings?.reason ?? '每日一练服务尚未开放')),
      resumesAt: pause?.endsAt.toISOString() ?? null,
      settingsRevision: settings?.revision ?? 0,
    };
  }

  private async createLatePracticeDay(userId: string, practiceDate: string) {
    const practiceDateDb = practiceDateToDbDate(practiceDate);
    await this.prisma.$transaction(async (transaction) => {
      await lockDailyPracticeSettings(transaction);
      const now = new Date();
      if (practiceDateForInstant(now) !== practiceDate) return;
      const [service, user, profile, cycle, existing] = await Promise.all([
        this.serviceState(now, transaction, userId),
        transaction.user.findUnique({
          where: { id: userId },
          select: { status: true },
        }),
        transaction.userPracticeProfile.findUnique({
          where: { userId },
          select: { stateRevision: true, initializationStatus: true },
        }),
        transaction.dailyPracticeCycle.findUnique({
          where: { practiceDate: practiceDateDb },
          select: {
            id: true,
            status: true,
            deadlineAt: true,
            progressSetHash: true,
            poolStats: true,
            counts: true,
          },
        }),
        transaction.dailyPracticeDay.findUnique({
          where: { userId_practiceDate: { userId, practiceDate: practiceDateDb } },
          select: { id: true },
        }),
      ]);
      if (
        existing ||
        !service.enabled ||
        service.paused ||
        user?.status !== AccountStatus.ACTIVE ||
        profile?.initializationStatus !== UserPracticeInitializationStatus.READY ||
        !cycle ||
        ![
          'GENERATING',
          'READY',
          'DEGRADED',
        ].includes(cycle.status)
      ) {
        return;
      }
      const poolStats = jsonObject(cycle.poolStats);
      const frozenFixedQuestions = Array.isArray(
        poolStats?.frozenFixedQuestions,
      )
        ? poolStats.frozenFixedQuestions
        : [];
      const created = await transaction.dailyPracticeDay.createMany({
        data: [
          {
            cycleId: cycle.id,
            userId,
            practiceDate: practiceDateDb,
            scheduledAt: now,
            deadlineAt: new Date(
              now.getTime() + DAILY_PRACTICE_SPREAD_WINDOW_MS,
            ),
            status: DailyPracticeDayStatus.PENDING,
            profileRevision: profile.stateRevision,
            progressSetHash: cycle.progressSetHash,
            fixedQuestionSnapshot:
              frozenFixedQuestions as Prisma.InputJsonValue,
          },
        ],
        skipDuplicates: true,
      });
      if (created.count !== 1) return;
      const currentCounts = jsonObject(cycle.counts) ?? {};
      const { finalizedAt: _finalizedAt, ...counts } = currentCounts;
      await transaction.dailyPracticeCycle.updateMany({
        where: { id: cycle.id },
        data: {
          status:
            cycle.status === 'READY'
              ? 'GENERATING'
              : cycle.status,
          counts: counts as Prisma.InputJsonValue,
        },
      });
    }, serializableTransaction);
    return this.prisma.dailyPracticeDay.findUnique({
      where: { userId_practiceDate: { userId, practiceDate: practiceDateDb } },
      select: {
        id: true,
        status: true,
        createdAt: true,
        activeRevisionId: true,
        cycle: { select: { deadlineAt: true } },
        activeRevision: { include: PLAN_ITEMS_INCLUDE },
      },
    });
  }

  private assertStartableItems(
    items: Array<{
      source: DailyPracticePlanItemSource;
      questionReviewRevision: number;
      sourceRevision: number | null;
      question: {
        type: QuestionType;
        enabled: boolean;
        origin: QuizQuestionOrigin;
        reviewStatus: QuizQuestionReviewStatus;
        reviewRevision: number;
        sourceRevision: number;
        sourceReviewStatus: QuizQuestionSourceReviewStatus;
        knowledgeSources: Array<{ id: string }>;
      };
    }>,
  ) {
    let shortAnswers = 0;
    for (const item of items) {
      const question = item.question;
      const commonValid =
        question.enabled &&
        question.reviewStatus === QuizQuestionReviewStatus.APPROVED &&
        question.reviewRevision === item.questionReviewRevision;
      if (!commonValid) {
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.planStale,
          '计划中的题目已更新，请等待计划重新生成',
        );
      }
      if (question.type === QuestionType.SHORT_ANSWER) shortAnswers += 1;
      if (item.source === DailyPracticePlanItemSource.ADMIN_FIXED) {
        if (
          question.origin !== QuizQuestionOrigin.MANUAL &&
          question.origin !== QuizQuestionOrigin.CSV
        ) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.planStale,
            '管理员固定题已失效',
          );
        }
        continue;
      }
      if (
        question.origin !== QuizQuestionOrigin.MANUAL &&
        question.origin !== QuizQuestionOrigin.CSV
      ) {
        dailyPracticeConflict(
          DAILY_PRACTICE_ERROR_CODES.planStale,
          '个性化题目已退役，请等待计划重新生成',
        );
      }
    }
    if (shortAnswers > 1) {
      dailyPracticeConflict(
        DAILY_PRACTICE_ERROR_CODES.planStale,
        '每日练习中的简答题数量超过安全上限',
      );
    }
  }

  private async normalizeTeachingNodes(
    transaction: Prisma.TransactionClient,
    dto: TeachingProgressPublishDto,
    effectivePracticeDate: Date,
  ): Promise<NormalizedTeachingNode[]> {
    const inputIds = dto.nodes.map((node) => node.knowledgeNodeId);
    if (!inputIds.length) {
      dailyPracticeBadRequest(
        DAILY_PRACTICE_ERROR_CODES.progressConflict,
        '教学进度至少需要一个知识节点',
      );
    }
    if (new Set(inputIds).size !== inputIds.length) {
      dailyPracticeBadRequest(
        DAILY_PRACTICE_ERROR_CODES.progressConflict,
        '教学进度不能重复选择同一知识节点',
      );
    }
    const selected = await transaction.knowledgeNode.findMany({
      where: { id: { in: inputIds }, level: { gte: 2, lte: 6 } },
      select: {
        id: true,
        parentId: true,
        level: true,
        title: true,
        breadcrumb: true,
        pathHash: true,
        documentVersionId: true,
        documentVersion: {
          select: {
            contentHash: true,
            indexStatus: true,
            renderStatus: true,
            document: {
              select: {
                id: true,
                subjectId: true,
                libraryId: true,
                activeVersionId: true,
                kind: true,
                status: true,
                indexStatus: true,
                deletedAt: true,
                subject: { select: { active: true } },
                library: {
                  select: {
                    scope: true,
                    active: true,
                    deletedAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (selected.length !== inputIds.length) {
      dailyPracticeBadRequest(
        DAILY_PRACTICE_ERROR_CODES.progressConflict,
        '部分知识节点不存在或不是可选的 H2-H6 节点',
      );
    }
    for (const node of selected) {
      const version = node.documentVersion;
      const document = version.document;
      if (
        document.subjectId !== dto.subjectId ||
        !document.subject.active ||
        document.library.scope !== KnowledgeLibraryScope.SHARED ||
        !document.library.active ||
        document.library.deletedAt ||
        document.deletedAt ||
        document.kind !== KnowledgeKind.MARKDOWN ||
        document.status !== ContentStatus.PUBLISHED ||
        document.indexStatus !== IndexStatus.READY ||
        version.indexStatus !== IndexStatus.READY ||
        version.renderStatus !== KnowledgeRenderStatus.READY ||
        document.activeVersionId !== node.documentVersionId
      ) {
        dailyPracticeBadRequest(
          DAILY_PRACTICE_ERROR_CODES.progressConflict,
          '知识节点必须来自同学科、共享、活动、已发布且 READY 的当前 Markdown 版本',
        );
      }
    }

    const versionIds = [
      ...new Set(selected.map((node) => node.documentVersionId)),
    ];
    const allNodes = await transaction.knowledgeNode.findMany({
      where: {
        documentVersionId: { in: versionIds },
        level: { gte: 2, lte: 6 },
      },
      select: {
        id: true,
        parentId: true,
        title: true,
        breadcrumb: true,
        pathHash: true,
        documentVersionId: true,
        documentVersion: {
          select: {
            contentHash: true,
            document: { select: { id: true, libraryId: true } },
          },
        },
      },
    });
    const allById = new Map(allNodes.map((node) => [node.id, node]));
    const children = new Map<string, string[]>();
    for (const node of allNodes) {
      if (!node.parentId || !allById.has(node.parentId)) continue;
      const values = children.get(node.parentId) ?? [];
      values.push(node.id);
      children.set(node.parentId, values);
    }
    const selectedById = new Map(selected.map((node) => [node.id, node]));
    const firstTaughtByKey = new Map<string, Date>();
    const normalizedByKey = new Map<string, NormalizedTeachingNode>();
    for (const input of dto.nodes) {
      const firstTaughtDate = parsePracticeDate(
        input.firstTaughtDate,
        DAILY_PRACTICE_ERROR_CODES.progressConflict,
      );
      if (firstTaughtDate > effectivePracticeDate) {
        dailyPracticeBadRequest(
          DAILY_PRACTICE_ERROR_CODES.progressConflict,
          '首次讲授日期不能晚于教学进度生效日期',
        );
      }
      const root = selectedById.get(input.knowledgeNodeId)!;
      const leaves = collectLeafNodes(root.id, children, allById);
      for (const leaf of leaves) {
        const document = leaf.documentVersion.document;
        const key = `${document.id}\u0000${leaf.pathHash}`;
        const previousDate = firstTaughtByKey.get(key);
        if (
          previousDate &&
          practiceDateFromDbDate(previousDate) !== input.firstTaughtDate
        ) {
          dailyPracticeBadRequest(
            DAILY_PRACTICE_ERROR_CODES.progressConflict,
            '重叠节点展开后产生了不同的首次讲授日期',
          );
        }
        firstTaughtByKey.set(key, firstTaughtDate);
        normalizedByKey.set(key, {
          libraryId: document.libraryId,
          documentId: document.id,
          nodePathHash: leaf.pathHash,
          currentKnowledgeNodeId: leaf.id,
          titleSnapshot: leaf.title,
          breadcrumbSnapshot: leaf.breadcrumb,
          firstTaughtDate,
          sourceDocumentVersionId: leaf.documentVersionId,
          contentHashSnapshot: leaf.documentVersion.contentHash,
        });
      }
    }
    const normalized = [...normalizedByKey.values()].sort((left, right) =>
      `${left.documentId}\u0000${left.nodePathHash}`.localeCompare(
        `${right.documentId}\u0000${right.nodePathHash}`,
      ),
    );
    if (normalized.length > 5000) {
      dailyPracticeBadRequest(
        DAILY_PRACTICE_ERROR_CODES.progressConflict,
        '教学进度展开后最多包含 5000 个末级知识节点',
      );
    }
    return normalized;
  }

  private async resolveTeachingNodes(
    nodes: Array<{
      libraryId: string;
      documentId: string;
      nodePathHash: string;
    }>,
    subjectId: string,
  ) {
    if (!nodes.length) {
      return new Map<string, ResolvedTeachingNode>();
    }
    const current = await this.prisma.knowledgeNode.findMany({
      where: {
        pathHash: { in: [...new Set(nodes.map((node) => node.nodePathHash))] },
        documentVersion: {
          documentId: {
            in: [...new Set(nodes.map((node) => node.documentId))],
          },
          document: {
            status: ContentStatus.PUBLISHED,
            indexStatus: IndexStatus.READY,
            deletedAt: null,
            library: {
              scope: KnowledgeLibraryScope.SHARED,
              active: true,
              deletedAt: null,
            },
          },
        },
      },
      select: {
        id: true,
        title: true,
        breadcrumb: true,
        pathHash: true,
        documentVersion: {
          select: {
            documentId: true,
            document: { select: { activeVersionId: true } },
          },
        },
        documentVersionId: true,
      },
    });
    const resolved = new Map<string, ResolvedTeachingNode>(
      current
        .filter(
          (node) =>
            node.documentVersion.document.activeVersionId ===
            node.documentVersionId,
        )
        .map((node) => [
          `${node.documentVersion.documentId}\u0000${node.pathHash}`,
          {
            id: node.id,
            title: node.title,
            breadcrumb: node.breadcrumb,
            remapped: false,
            resolvedDocumentId: node.documentVersion.documentId,
          },
        ]),
    );
    const unresolved = nodes.filter(
      (node) => !resolved.has(`${node.documentId}\0${node.nodePathHash}`),
    );
    if (unresolved.length) {
      const replacements = await this.prisma.knowledgeDocument.findMany({
        where: {
          libraryId: {
            in: uniqueIds(unresolved.map((node) => node.libraryId)),
          },
          subjectId,
          status: ContentStatus.PUBLISHED,
          indexStatus: IndexStatus.READY,
          kind: KnowledgeKind.MARKDOWN,
          deletedAt: null,
          subject: { active: true },
          library: {
            scope: KnowledgeLibraryScope.SHARED,
            active: true,
            deletedAt: null,
          },
          activeVersion: {
            is: {
              indexStatus: IndexStatus.READY,
              renderStatus: KnowledgeRenderStatus.READY,
            },
          },
        },
        select: {
          id: true,
          libraryId: true,
          activeVersion: {
            select: {
              nodes: {
                where: {
                  pathHash: {
                    in: uniqueIds(unresolved.map((node) => node.nodePathHash)),
                  },
                  libraryChapter: { active: true },
                },
                select: {
                  id: true,
                  pathHash: true,
                  title: true,
                  breadcrumb: true,
                },
              },
            },
          },
        },
      });
      const candidatesByScope = new Map<
        string,
        Array<{
          documentId: string;
          id: string;
          title: string;
          breadcrumb: string;
        }>
      >();
      for (const document of replacements) {
        for (const node of document.activeVersion?.nodes ?? []) {
          const scopeKey = `${document.libraryId}\0${node.pathHash}`;
          const candidates = candidatesByScope.get(scopeKey) ?? [];
          candidates.push({
            documentId: document.id,
            id: node.id,
            title: node.title,
            breadcrumb: node.breadcrumb,
          });
          candidatesByScope.set(scopeKey, candidates);
        }
      }
      for (const node of unresolved) {
        const candidates =
          candidatesByScope.get(`${node.libraryId}\0${node.nodePathHash}`) ??
          [];
        const documentIds = new Set(
          candidates.map((candidate) => candidate.documentId),
        );
        if (documentIds.size !== 1) continue;
        const candidate = candidates[0]!;
        resolved.set(`${node.documentId}\0${node.nodePathHash}`, {
          id: candidate.id,
          title: candidate.title,
          breadcrumb: candidate.breadcrumb,
          remapped: true,
          resolvedDocumentId: candidate.documentId,
        });
      }
    }
    return resolved;
  }

  private async eligibleQuestionCountForProgress(progressId: string) {
    const progress = await this.prisma.teachingProgress.findUnique({
      where: { id: progressId },
      select: {
        subjectId: true,
        nodes: {
          select: { libraryId: true, documentId: true, nodePathHash: true },
        },
      },
    });
    if (!progress) return 0;
    const resolved = await this.resolveTeachingNodes(
      progress.nodes,
      progress.subjectId,
    );
    const resolvedEntries = progress.nodes.flatMap((node) => {
      const current = resolved.get(`${node.documentId}\0${node.nodePathHash}`);
      return current
        ? [
            {
              documentId: current.resolvedDocumentId,
              nodePathHash: node.nodePathHash,
            },
          ]
        : [];
    });
    if (!resolvedEntries.length) return 0;
    const sourceKeys = new Set(
      resolvedEntries.map((node) => `${node.documentId}\0${node.nodePathHash}`),
    );
    const sourceScope: Prisma.QuizQuestionKnowledgeSourceWhereInput[] =
      resolvedEntries.map((node) => ({
        documentId: node.documentId,
        OR: [
          { nodePathHash: node.nodePathHash },
          {
            nodePathHash: null,
            knowledgeNode: { pathHash: node.nodePathHash },
          },
        ],
      }));
    let count = 0;
    let cursor: string | undefined;
    while (true) {
      const rows = await this.prisma.quizQuestion.findMany({
        where: {
          enabled: true,
          origin: QuizQuestionOrigin.AI_GENERATED,
          category: QuizQuestionCategory.KNOWLEDGE_RECALL,
          reviewStatus: QuizQuestionReviewStatus.APPROVED,
          sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
          subject: { active: true },
          chapters: {
            some: {},
            every: { chapter: { active: true } },
          },
          knowledgeSources: {
            some: { current: true, OR: sourceScope },
            every: {
              OR: [{ current: false }, { current: true, OR: sourceScope }],
            },
          },
        },
        select: {
          id: true,
          sourceRevision: true,
          knowledgeSources: {
            where: { current: true },
            orderBy: [{ ordinal: 'asc' }, { id: 'asc' }],
            select: {
              documentId: true,
              nodePathHash: true,
              sourceRevision: true,
              knowledgeNode: { select: { pathHash: true } },
            },
          },
        },
        orderBy: { id: 'asc' },
        take: 1_000,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const question of rows) {
        const sources = question.knowledgeSources.flatMap((source) => {
          const pathHash =
            source.nodePathHash ?? source.knowledgeNode?.pathHash;
          return pathHash ? [{ ...source, pathHash }] : [];
        });
        if (
          sources.length !== question.knowledgeSources.length ||
          !sources.every(
            (source) =>
              source.sourceRevision === question.sourceRevision &&
              sourceKeys.has(`${source.documentId}\0${source.pathHash}`),
          )
        ) {
          continue;
        }
        count += 1;
      }
      if (rows.length < 1_000) break;
      cursor = rows.at(-1)!.id;
    }
    return count;
  }

  private async validateSuggestionScope(
    client: DatabaseClient,
    payload: ReturnType<typeof normalizeSuggestionPayload>,
    targetPracticeDate: string,
  ) {
    const subjectIds = uniqueIds(payload.focusSubjectIds);
    const chapterIds = uniqueIds(payload.focusChapterIds);
    if (subjectIds.length !== payload.focusSubjectIds.length) {
      dailyPracticeBadRequest(
        DAILY_PRACTICE_ERROR_CODES.suggestionOutOfScope,
        '建议中的学科不能重复',
      );
    }
    if (chapterIds.length !== payload.focusChapterIds.length) {
      dailyPracticeBadRequest(
        DAILY_PRACTICE_ERROR_CODES.suggestionOutOfScope,
        '建议中的章节不能重复',
      );
    }
    if (chapterIds.length && !subjectIds.length) {
      dailyPracticeBadRequest(
        DAILY_PRACTICE_ERROR_CODES.suggestionOutOfScope,
        '选择重点章节前必须先选择重点学科',
      );
    }
    if (!subjectIds.length && !chapterIds.length) return;

    const courses = await loadPracticeCourses(client);
    const available = new Set(courses.filter((course) =>
      courseStatus(course, targetPracticeDate) === 'ACTIVE' && learnedCourseTopics(course, targetPracticeDate).length,
    ).map((course) => course.subjectId));
    if (subjectIds.some((id) => !available.has(id))) {
      dailyPracticeBadRequest(DAILY_PRACTICE_ERROR_CODES.suggestionOutOfScope, '重点学科必须属于目标日期已开课且未考试结束的课程');
    }
    if (!chapterIds.length) return;
    const candidates = await loadEligiblePracticeQuestions(client, targetPracticeDate, { courses });
    const eligibleChapters = new Set(candidates.filter((question) => subjectIds.includes(question.subjectId))
      .flatMap((question) => question.chapters.map((chapter) => chapter.chapterId)));
    if (chapterIds.some((id) => !eligibleChapters.has(id))) {
      dailyPracticeBadRequest(DAILY_PRACTICE_ERROR_CODES.suggestionOutOfScope, '重点章节在目标已学范围内没有可用题目');
    }
  }
}

function fixedQuestionCandidateWhereSql(query: FixedQuestionCandidateQueryDto) {
  const predicates: Prisma.Sql[] = [
    Prisma.sql`question.enabled = true`,
    Prisma.sql`question.reviewStatus = 'APPROVED'`,
    Prisma.sql`question.origin IN ('MANUAL', 'CSV')`,
    Prisma.sql`subject.active = true`,
    Prisma.sql`EXISTS (
      SELECT 1 FROM QuizQuestionChapter AS chapterLink
      WHERE chapterLink.questionId = question.id
    )`,
    Prisma.sql`NOT EXISTS (
      SELECT 1
      FROM QuizQuestionChapter AS chapterLink
      INNER JOIN SubjectChapter AS chapter ON chapter.id = chapterLink.chapterId
      WHERE chapterLink.questionId = question.id AND chapter.active = false
    )`,
  ];
  if (query.chapterIds?.length) {
    if (query.chapterMatch === 'ALL') {
      for (const chapterId of query.chapterIds) {
        predicates.push(Prisma.sql`EXISTS (
          SELECT 1 FROM QuizQuestionChapter AS chapterLink
          WHERE chapterLink.questionId = question.id
            AND chapterLink.chapterId = ${chapterId}
        )`);
      }
    } else {
      predicates.push(Prisma.sql`EXISTS (
        SELECT 1 FROM QuizQuestionChapter AS chapterLink
        WHERE chapterLink.questionId = question.id
          AND chapterLink.chapterId IN (${Prisma.join(query.chapterIds)})
      )`);
    }
  }
  if (query.includeCrossChapter === false) {
    predicates.push(Prisma.sql`(
      SELECT COUNT(*) FROM QuizQuestionChapter AS chapterLink
      WHERE chapterLink.questionId = question.id
    ) = 1`);
  }
  if (query.subjectId) {
    predicates.push(Prisma.sql`question.subjectId = ${query.subjectId}`);
  }
  if (query.gradingType) {
    predicates.push(Prisma.sql`question.type = ${query.gradingType}`);
  }
  if (query.typeLabel) {
    predicates.push(Prisma.sql`question.typeLabel = ${query.typeLabel}`);
  }
  if (query.paperId) {
    predicates.push(Prisma.sql`question.pastPaperId = ${query.paperId}`);
  } else if (query.pastPaper === 'EXCLUDE') {
    predicates.push(Prisma.sql`question.pastPaperId IS NULL`);
  } else if (query.pastPaper === 'ONLY') {
    predicates.push(Prisma.sql`question.pastPaperId IS NOT NULL`);
  }
  if (query.search) {
    const pattern = `%${query.search}%`;
    predicates.push(
      Prisma.sql`(question.prompt LIKE ${pattern} OR question.typeLabel LIKE ${pattern})`,
    );
  }
  return Prisma.sql`WHERE ${Prisma.join(predicates, ' AND ')}`;
}

const serializableTransaction = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 10_000,
  timeout: 30_000,
} as const;

function parseInstant(value: string, message: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException(message);
  return date;
}

function parsePracticeDate(value: string, code: DailyPracticeErrorCode) {
  try {
    return practiceDateToDbDate(value);
  } catch {
    dailyPracticeBadRequest(code, '练习日必须是有效的 YYYY-MM-DD 日期');
  }
}

function serializeSettings(
  settings: {
    enabled: boolean;
    revision: number;
    updatedAt: Date;
    updatedBy: { id: string; displayName: string } | null;
  },
  effective: ServiceState,
) {
  return {
    enabled: settings.enabled,
    revision: settings.revision,
    updatedAt: settings.updatedAt.toISOString(),
    updatedBy: settings.updatedBy,
    effective,
  };
}

function serializePause(pause: {
  id: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  cancelledAt: Date | null;
  createdAt: Date;
  createdBy: { id: string; displayName: string } | null;
  cancelledBy: { id: string; displayName: string } | null;
}) {
  return {
    id: pause.id,
    startsAt: pause.startsAt.toISOString(),
    endsAt: pause.endsAt.toISOString(),
    reason: pause.reason,
    cancelledAt: pause.cancelledAt?.toISOString() ?? null,
    createdAt: pause.createdAt.toISOString(),
    createdBy: pause.createdBy,
    cancelledBy: pause.cancelledBy,
  };
}

function serializeTeachingProgressSummary(progress: {
  id: string;
  subject: { id: string; name: string; slug: string };
  version: number;
  effectivePracticeDate: Date;
  changeType: TeachingProgressChangeType;
  note: string | null;
  correctionReason: string | null;
  scopeHash: string;
  publishedBy: { id: string; displayName: string } | null;
  publishedAt: Date;
  _count: { nodes: number };
}) {
  return {
    id: progress.id,
    subject: progress.subject,
    version: progress.version,
    effectivePracticeDate: practiceDateFromDbDate(
      progress.effectivePracticeDate,
    ),
    changeType: progress.changeType,
    note: progress.note,
    correctionReason: progress.correctionReason,
    scopeHash: progress.scopeHash,
    nodeCount: progress._count.nodes,
    publishedBy: progress.publishedBy,
    publishedAt: progress.publishedAt.toISOString(),
  };
}

function serializeFixedQuestionCandidate(question: {
  id: string;
  type: QuestionType;
  typeLabel: string;
  subjectId: string;
  subject: { name: string };
  chapters: Array<{
    chapter: { id: string; name: string; slug: string };
  }>;
  prompt: string;
  origin: QuizQuestionOrigin;
  pastPaperId: string | null;
}) {
  const chapters = question.chapters.map(({ chapter }) => chapter);
  return {
    id: question.id,
    gradingType: question.type,
    typeLabel: question.typeLabel,
    subjectId: question.subjectId,
    subject: question.subject.name,
    chapterIds: chapters.map(({ id }) => id),
    chapters,
    prompt: question.prompt,
    origin: question.origin as 'MANUAL' | 'CSV',
    isPastPaper: Boolean(question.pastPaperId),
  };
}

function serializeFixedAssignment(assignment: FixedAssignmentWithQuestions) {
  return {
    id: assignment.id,
    practiceDate: practiceDateFromDbDate(assignment.practiceDate),
    revision: assignment.revision,
    basedOnAssignmentId: assignment.basedOnAssignmentId,
    assignmentHash: assignment.assignmentHash,
    note: assignment.note,
    publishedAt: assignment.publishedAt.toISOString(),
    publishedBy: assignment.publishedBy,
    questions: assignment.questions.map((fixed) => ({
      ...serializeFixedQuestionCandidate(fixed.question),
      ordinal: fixed.ordinal,
    })),
  };
}

function serializeAdminUserSummary(user: {
  id: string;
  displayName: string;
  role: Role;
  status: AccountStatus;
  practiceProfile: {
    initializationStatus: UserPracticeInitializationStatus;
    attemptCount: number;
  } | null;
  dailyPracticeDays: Array<{
    status: DailyPracticeDayStatus;
    activeRevision: {
      generationSource: DailyPracticeGenerationSource;
      generatedAt: Date | null;
    } | null;
  }>;
  dailySuggestionsReceived: Array<{
    status: DailyPracticeSuggestionStatus;
  }>;
  _count: { quizAttempts: number };
}) {
  const initializationStatus =
    user.practiceProfile?.initializationStatus ??
    UserPracticeInitializationStatus.PENDING;
  const appliedAttempts = user.practiceProfile?.attemptCount ?? 0;
  const totalAttempts = user._count.quizAttempts;
  const initializationProgress =
    totalAttempts > 0
      ? Math.min(100, Math.round((appliedAttempts / totalAttempts) * 100))
      : initializationStatus === UserPracticeInitializationStatus.READY
        ? 100
        : 0;
  const day = user.dailyPracticeDays[0] ?? null;
  return {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    initializationStatus,
    initializationProgress,
    todayStatus: day?.status ?? null,
    generationSource: day?.activeRevision?.generationSource ?? null,
    completed: day?.status === DailyPracticeDayStatus.COMPLETED,
    summaryUpdatedAt: day?.activeRevision?.generatedAt?.toISOString() ?? null,
    suggestionStatus: user.dailySuggestionsReceived[0]?.status ?? null,
  };
}

function sanitizeGapSummary(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 1000).flatMap((entry) => {
    const object = jsonObject(entry);
    const subjectId = boundedString(object?.subjectId, 191);
    const subject = boundedString(object?.subject, 100);
    if (!subjectId || !subject) return [];
    return [
      {
        subjectId,
        subject,
        nodeCount: boundedInteger(
          object?.nodeCount,
          0,
          Number.MAX_SAFE_INTEGER,
          0,
        ),
        eligibleQuestionCount: boundedInteger(
          object?.eligibleQuestionCount,
          0,
          Number.MAX_SAFE_INTEGER,
          0,
        ),
      },
    ];
  });
}

function serializeCycleListItem(cycle: {
  practiceDate: Date;
  status: DailyPracticeCycleStatus;
  baselineAt: Date;
  deadlineAt: Date;
  refreezeRequestedAt: Date | null;
  counts: Prisma.JsonValue | null;
  poolStats: Prisma.JsonValue | null;
}) {
  const counts = jsonObject(cycle.counts);
  const poolStats = jsonObject(cycle.poolStats);
  return {
    practiceDate: practiceDateFromDbDate(cycle.practiceDate),
    status: cycle.status,
    baselineAt: cycle.baselineAt.toISOString(),
    deadlineAt: cycle.deadlineAt.toISOString(),
    refreezeRequestedAt: cycle.refreezeRequestedAt?.toISOString() ?? null,
    activeUsers: boundedInteger(
      counts?.activeUsers,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    ),
    createdDays: boundedInteger(
      counts?.createdDays,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    ),
    terminalUsers: boundedInteger(
      counts?.terminalUsers,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    ),
    statusCounts: integerCountRecord(counts?.statusCounts),
    pool: {
      candidateQuestionCount: boundedInteger(
        poolStats?.candidateQuestionCount,
        0,
        Number.MAX_SAFE_INTEGER,
        0,
      ),
      unresolvedProgressNodeCount: boundedInteger(
        poolStats?.unresolvedProgressNodeCount,
        0,
        Number.MAX_SAFE_INTEGER,
        0,
      ),
      remappedProgressNodeCount: boundedInteger(
        poolStats?.remappedProgressNodeCount,
        0,
        Number.MAX_SAFE_INTEGER,
        0,
      ),
      invalidFixedQuestionCount: stringArray(
        poolStats?.invalidFixedQuestionIds,
        20,
        191,
      ).length,
      fixedQuestionCount: Array.isArray(poolStats?.frozenFixedQuestions)
        ? poolStats.frozenFixedQuestions.length
        : 0,
      gapCount: Array.isArray(poolStats?.gapSummary)
        ? poolStats.gapSummary.length
        : 0,
    },
  };
}

function summarizeCyclePool(
  snapshotValue: unknown,
  poolStats: Record<string, unknown> | null,
) {
  const snapshot = Array.isArray(snapshotValue) ? snapshotValue : [];
  const remapped = snapshot.flatMap((entry) => {
    const object = jsonObject(entry);
    if (!object || !boundedString(object.remappedFromDocumentId, 191)) {
      return [];
    }
    return [object];
  });
  return {
    progressNodeCount: snapshot.length,
    candidateQuestionCount: boundedInteger(
      poolStats?.candidateQuestionCount,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    ),
    candidateTypeCounts: integerCountRecord(poolStats?.candidateTypeCounts),
    unresolvedProgressNodeCount: boundedInteger(
      poolStats?.unresolvedProgressNodeCount,
      0,
      Number.MAX_SAFE_INTEGER,
      0,
    ),
    remappedProgressNodeCount: remapped.length,
    remappedNodes: remapped.slice(0, 50).map((node) => ({
      subjectId: boundedString(node.subjectId, 191),
      title: boundedString(node.title, 200),
      breadcrumb: boundedString(node.breadcrumb, 1000),
      documentId: boundedString(node.documentId, 191),
      remappedFromDocumentId: boundedString(node.remappedFromDocumentId, 191),
      firstTaughtDate: boundedString(node.firstTaughtDate, 10),
    })),
  };
}

function integerCountRecord(value: unknown) {
  const object = jsonObject(value);
  if (!object) return {};
  return Object.fromEntries(
    Object.entries(object).flatMap(([key, entry]) => {
      const number = Number(entry);
      return Number.isInteger(number) && number >= 0 ? [[key, number]] : [];
    }),
  );
}

function nullableNumber(value: unknown) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function serializeSuggestion(suggestion: {
  id: string;
  targetPracticeDate: Date;
  payload: Prisma.JsonValue;
  status: DailyPracticeSuggestionStatus;
  createdAt: Date;
  submittedBy: { role: Role };
}) {
  return {
    id: suggestion.id,
    targetPracticeDate: practiceDateFromDbDate(suggestion.targetPracticeDate),
    payload: sanitizeSuggestionPayload(suggestion.payload),
    status: suggestion.status,
    submittedByRole: suggestion.submittedBy.role,
    createdAt: suggestion.createdAt.toISOString(),
  };
}

function normalizeSuggestionPayload(dto: DailyPracticeSuggestionDto) {
  return {
    intensity: dto.intensity,
    desiredQuestionCount: dto.desiredQuestionCount,
    focusSubjectIds: dto.focusSubjectIds.map((value) => value.trim()),
    focusChapterIds: dto.focusChapterIds.map((value) => value.trim()),
    ...(dto.note?.trim() ? { note: dto.note.trim() } : {}),
  };
}

function sanitizeSuggestionPayload(value: Prisma.JsonValue) {
  const object = jsonObject(value);
  const intensity = ['LIGHT', 'STANDARD', 'CHALLENGING'].includes(
    String(object?.intensity),
  )
    ? String(object?.intensity)
    : 'STANDARD';
  const desiredQuestionCount = boundedInteger(
    object?.desiredQuestionCount,
    5,
    10,
    5,
  );
  return {
    intensity,
    desiredQuestionCount,
    focusSubjectIds: stringArray(object?.focusSubjectIds, 2, 191),
    focusChapterIds: stringArray(object?.focusChapterIds, 5, 191),
    ...(typeof object?.note === 'string'
      ? { note: object.note.slice(0, 300) }
      : {}),
  };
}

function serializePlanItems(revision: PlanRevisionWithItems) {
  return revision.items.map((item) => serializePlanItem(item));
}

function serializePlanItem(item: {
  ordinal: number;
  source: DailyPracticePlanItemSource;
  questionId: string;
  reason: string;
  evidenceRefs: Prisma.JsonValue;
  question: PlanQuestion;
}) {
  const question = item.question;
  const chapters = question.chapters.map(({ chapter }) => chapter);
  return {
    ordinal: item.ordinal,
    source: item.source,
    questionId: item.questionId,
    gradingType: question.type,
    typeLabel: question.typeLabel,
    subjectId: question.subjectId,
    subject: question.subject.name,
    chapterIds: chapters.map(({ id }) => id),
    chapters,
    prompt: question.prompt,
    options: Array.isArray(question.options) ? question.options : [],
    images: question.photos.map(({ photo }) => ({
      ...photo,
      url: `/api/v1/media/images/${photo.id}/content`,
    })),
    maxScore: question.maxScore,
    reason: item.reason,
    evidenceRefs: stringArray(item.evidenceRefs, 50, 100),
  };
}

function serializeAttempt(attempt: {
  id: string;
  submittedAt: Date | null;
  score: number | null;
  total: number;
}) {
  return {
    id: attempt.id,
    submittedAt: attempt.submittedAt?.toISOString() ?? null,
    score: attempt.score,
    total: attempt.total,
  };
}

function serializeHistoryItem(
  revision: PlanRevisionWithItems & {
    day: { practiceDate: Date; status: DailyPracticeDayStatus };
  },
) {
  const fixedQuestionCount = revision.items.filter(
    (item) => item.source === DailyPracticePlanItemSource.ADMIN_FIXED,
  ).length;
  return {
    planRevisionId: revision.id,
    practiceDate: practiceDateFromDbDate(revision.day.practiceDate),
    status: revision.day.status,
    generationSource: revision.generationSource,
    generatedAt: revision.generatedAt!.toISOString(),
    summary: sanitizeLearningSummary(revision.summarySnapshot),
    questionCount: revision.items.length - fixedQuestionCount,
    fixedQuestionCount,
    attempt: revision.quizAttempt
      ? serializeAttempt(revision.quizAttempt)
      : null,
  };
}

function sanitizeAdminCandidateQuestions(
  value: Prisma.JsonValue | null | undefined,
) {
  const frozen = jsonObject(value);
  const payload = jsonObject(frozen?.payload);
  const metadata = Array.isArray(frozen?.candidateQuestions)
    ? frozen.candidateQuestions
    : [];
  const questionIdByAlias = new Map<string, string>();
  for (const entry of metadata.slice(0, 100)) {
    const object = jsonObject(entry);
    const questionAlias = boundedString(object?.questionAlias, 20);
    const questionId = boundedString(object?.questionId, 191);
    if (questionAlias && questionId) {
      questionIdByAlias.set(questionAlias, questionId);
    }
  }
  const candidates = Array.isArray(payload?.candidateQuestions)
    ? payload.candidateQuestions
    : [];
  return candidates.slice(0, 100).flatMap((entry) => {
    const object = jsonObject(entry);
    const questionAlias = boundedString(object?.questionAlias, 20);
    const questionId = questionAlias
      ? questionIdByAlias.get(questionAlias)
      : undefined;
    const gradingType = Object.values(QuestionType).includes(
      object?.gradingType as QuestionType,
    )
      ? (object?.gradingType as QuestionType)
      : null;
    const typeLabel = boundedString(object?.typeLabel, 100);
    const promptExcerpt = boundedString(object?.promptExcerpt, 500);
    if (
      !questionAlias ||
      !questionId ||
      !gradingType ||
      !typeLabel ||
      !promptExcerpt
    ) {
      return [];
    }
    const priorityScore = Number(object?.priorityScore);
    return [
      {
        questionId,
        questionAlias,
        gradingType,
        typeLabel,
        promptExcerpt,
        knowledgeAliases: stringArray(object?.knowledgeAliases, 20, 20),
        chapterAliases: stringArray(object?.chapterAliases, 20, 20),
        priorityScore: Number.isFinite(priorityScore) ? priorityScore : 0,
      },
    ];
  });
}

function sanitizeAdminFrozenFixedQuestions(
  value: Prisma.JsonValue | null | undefined,
) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    const object = jsonObject(entry);
    const questionId = boundedString(object?.questionId, 191);
    const gradingType = Object.values(QuestionType).includes(
      object?.gradingType as QuestionType,
    )
      ? (object?.gradingType as QuestionType)
      : null;
    const typeLabel = boundedString(object?.typeLabel, 100);
    const promptExcerpt = boundedString(object?.promptExcerpt, 500);
    const subjectId = boundedString(object?.subjectId, 191);
    const subject = boundedString(object?.subjectName, 200);
    const promptHash = boundedString(object?.promptHash, 64);
    if (
      !questionId ||
      !gradingType ||
      !typeLabel ||
      !promptExcerpt ||
      !subjectId ||
      !subject ||
      !promptHash
    ) {
      return [];
    }
    return [
      {
        questionId,
        ordinal: boundedInteger(object?.ordinal, 1, 20, 1),
        gradingType,
        typeLabel,
        promptExcerpt,
        subjectId,
        subject,
        chapterIds: stringArray(object?.chapterIds, 20, 191),
        promptHash,
      },
    ];
  });
}

function sanitizeLearningSummary(value: Prisma.JsonValue | null | undefined) {
  const object = jsonObject(value);
  if (!object) return null;
  const headline = boundedString(object.headline, 40);
  const overview = boundedString(object.overview, 220);
  const dataQuality = ['SUFFICIENT', 'LIMITED', 'NONE'].includes(
    String(object.dataQuality),
  )
    ? String(object.dataQuality)
    : null;
  if (!headline || !overview || !dataQuality) return null;
  return {
    headline,
    overview,
    dataQuality,
    strengths: sanitizeSummaryEntries(object.strengths, 3),
    priorities: sanitizeSummaryEntries(object.priorities, 5),
  };
}

function sanitizeSummaryEntries(value: unknown, maximum: number) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).flatMap((entry) => {
    const object = jsonObject(entry);
    const knowledgeAlias = boundedString(object?.knowledgeAlias, 20);
    const text = boundedString(object?.text, 100);
    if (!knowledgeAlias || !text) return [];
    return [
      {
        knowledgeAlias,
        text,
        evidenceRefs: stringArray(object?.evidenceRefs, 20, 100),
      },
    ];
  });
}

function sanitizeResultSummary(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const object = jsonObject(entry);
    if (!object || typeof object.questionId !== 'string') return [];
    return [
      {
        questionId: object.questionId,
        correct: Boolean(object.correct),
        score: boundedInteger(object.score, 0, 1_000_000, 0),
        maxScore: boundedInteger(object.maxScore, 1, 1_000_000, 1),
      },
    ];
  });
}

function collectLeafNodes<T extends { id: string }>(
  rootId: string,
  children: Map<string, string[]>,
  nodes: Map<string, T>,
): T[] {
  const childIds = children.get(rootId) ?? [];
  if (!childIds.length) {
    const node = nodes.get(rootId);
    return node ? [node] : [];
  }
  return childIds.flatMap((childId) =>
    collectLeafNodes(childId, children, nodes),
  );
}

function assertAddPreservesPreviousScope(
  previous: Array<{
    documentId: string;
    nodePathHash: string;
    firstTaughtDate: Date;
  }>,
  next: NormalizedTeachingNode[],
) {
  const nextByKey = new Map(
    next.map((node) => [`${node.documentId}\u0000${node.nodePathHash}`, node]),
  );
  for (const node of previous) {
    const current = nextByKey.get(
      `${node.documentId}\u0000${node.nodePathHash}`,
    );
    if (
      !current ||
      practiceDateFromDbDate(current.firstTaughtDate) !==
        practiceDateFromDbDate(node.firstTaughtDate)
    ) {
      dailyPracticeConflict(
        DAILY_PRACTICE_ERROR_CODES.progressConflict,
        'ADD 只能新增节点；移除节点或修改首次讲授日期必须使用 CORRECTION',
      );
    }
  }
  if (next.length <= previous.length) {
    dailyPracticeBadRequest(
      DAILY_PRACTICE_ERROR_CODES.progressConflict,
      'ADD 修订必须至少新增一个教学节点',
    );
  }
}

function stableHash(value: unknown) {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function sha256Utf8(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, maximum: number) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maximum)
    : null;
}

function stringArray(value: unknown, maximum: number, itemMaximum: number) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.slice(0, itemMaximum))
    .slice(0, maximum);
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum
    ? number
    : fallback;
}

function uniqueIds(values: string[]) {
  return [...new Set(values)];
}

function isUniqueConstraint(error: unknown, target: string) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  const constraint = error.meta?.target;
  return Array.isArray(constraint)
    ? constraint.includes(target)
    : String(constraint ?? '').includes(target);
}

function isPrismaWriteConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2002' || error.code === 'P2034')
  );
}
