import { createHash, randomUUID } from 'node:crypto';
import {
  DAILY_PRACTICE_SPREAD_WINDOW_MS,
  learnedCourseTopics,
  type PracticeCourseSnapshot,
  topicTaughtOn,
  topicAvailableOn,
  practiceDateForInstant,
  practiceDateFromDbDate,
  practiceDateToDbDate,
  practiceDayWindow,
  requiredDailyPlanConcurrency,
  scheduleUsersAcrossWindow,
} from '@bmc3/daily-practice-core';
import { loadPracticeCourses, loadEligiblePracticeQuestions } from '@bmc3/daily-practice-prisma';
import {
  AccountStatus,
  DailyPracticeCycleStatus,
  DailyPracticeDayStatus,
  DailyPracticeSuggestionStatus,
  Prisma,
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
  type PrismaClient,
} from '@prisma/client';
import { loadDailyPracticeServiceGate } from './daily-practice-service';
import { safeAiErrorMessage } from './ai-invocation-gateway';
import { abortActiveDayGeneration } from './daily-practice-active-days';

const activeCycleLeases = new Map<string, string>();
const DAY_CREATE_BATCH = 500;

export interface FrozenProgressNode {
  courseId: string;
  subjectId: string;
  subjectName: string;
  courseRevision: number;
  topicHash: string;
  topicId: string;
  title: string;
  firstTaughtDate: string;
  availableOn: string;
  examDate: string;
}

export interface FrozenFixedQuestion {
  questionId: string;
  ordinal: number;
  questionReviewRevision: number;
  questionContentRevision?: number;
  sourceRevision: number;
  promptHash: string;
  gradingType: 'SINGLE' | 'MULTIPLE' | 'TRUE_FALSE' | 'SHORT_ANSWER';
  typeLabel: string;
  promptExcerpt: string;
  subjectId: string;
  subjectName: string;
  chapterIds: string[];
}

export interface FrozenCycleInputs {
  progressSnapshot: FrozenProgressNode[];
  progressSetHash: string;
  fixedAssignmentId: string | null;
  fixedQuestionSnapshot: FrozenFixedQuestion[];
  frozenFixedAssignmentHash: string;
  invalidFixedQuestionIds: string[];
  unresolvedProgressNodeCount: number;
  remappedProgressNodeCount: number;
  candidateQuestionCount: number;
  candidateSetHash: string;
  candidateTypeCounts: Record<string, number>;
  gapSummary: Array<{
    subjectId: string;
    subject: string;
    nodeCount: number;
    eligibleQuestionCount: number;
  }>;
}

export async function processDailyPracticeSchedulerTick(
  prisma: PrismaClient,
  suppliedNow?: Date | (() => Date),
) {
  const clock =
    typeof suppliedNow === 'function'
      ? suppliedNow
      : suppliedNow
        ? () => new Date(suppliedNow.getTime())
        : () => new Date();
  const now = clock();
  const practiceDate = practiceDateForInstant(now);
  const practiceDateDb = practiceDateToDbDate(practiceDate);
  const finalizedSuggestions = await finalizePastDailyPracticeSuggestions(
    prisma,
    practiceDateDb,
  );
  const gate = await loadDailyPracticeServiceGate(prisma, now);
  if (!gate.open) {
    const existing = await prisma.dailyPracticeCycle.findUnique({
      where: { practiceDate: practiceDateDb },
      select: { id: true },
    });
    if (existing) {
      await prisma.$transaction([
        prisma.dailyPracticeCycle.updateMany({
          where: { id: existing.id },
          data: { status: DailyPracticeCycleStatus.PAUSED },
        }),
        prisma.dailyPracticeDay.updateMany({
          where: { cycleId: existing.id, status: DailyPracticeDayStatus.PENDING },
          data: { status: DailyPracticeDayStatus.PAUSED },
        }),
      ]);
      return true;
    }
    return finalizedSuggestions > 0;
  }

  let cycle = await prisma.dailyPracticeCycle.findUnique({
    where: { practiceDate: practiceDateDb },
  });
  if (!cycle) {
    cycle = await createCycleUnderSettingsLock(prisma, clock);
    if (!cycle) return false;
  }
  if (cycle.refreezeRequestedAt) {
    const refrozen = await processRequestedCycleRefreeze(prisma, cycle.id);
    if (refrozen) {
      cycle = await prisma.dailyPracticeCycle.findUnique({
        where: { id: cycle.id },
      });
      if (!cycle) return false;
    }
  }
  if (readFixedSnapshot(cycle.poolStats).length) {
    const rebuilt = await refreshInvalidatedFixedQuestions(prisma, cycle.id);
    if (rebuilt) {
      cycle = await prisma.dailyPracticeCycle.findUnique({
        where: { id: cycle.id },
      });
      if (!cycle) return false;
    }
  }

  if (
    cycle.status === DailyPracticeCycleStatus.GENERATING ||
    cycle.status === DailyPracticeCycleStatus.DEGRADED ||
    cycle.status === DailyPracticeCycleStatus.READY
  ) {
    if (gate.internalTestUserIds?.length) {
      const replenished = await replenishInternalTestDays(
        prisma,
        cycle,
        gate.internalTestUserIds,
        clock(),
      );
      if (replenished) return true;
    }
    if (
      cycle.status === DailyPracticeCycleStatus.READY ||
      cycleCountsAreFinalized(cycle.counts)
    ) {
      return finalizedSuggestions > 0;
    }
    return (
      (await reconcileDailyPracticeCycle(
        prisma,
        cycle.id,
        cycle.counts,
        clock(),
        gate.internalTestUserIds,
      )) || finalizedSuggestions > 0
    );
  }

  const cyclePracticeDate = practiceDateFromDbDate(cycle.practiceDate);
  const cyclePracticeDateDb = practiceDateToDbDate(cyclePracticeDate);
  const recoveringFromPause = cycle.status === DailyPracticeCycleStatus.PAUSED || Boolean(gate.internalTestUserIds);

  const ownerToken = randomUUID();
  const claimed = await prisma.dailyPracticeCycle.updateMany({
    where: {
      id: cycle.id,
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
    },
    data: {
      leaseOwnerToken: ownerToken,
      leasedUntil: new Date(now.getTime() + schedulerLeaseMs()),
      ...(cycle.status === DailyPracticeCycleStatus.PAUSED
        ? { status: DailyPracticeCycleStatus.BUILDING }
        : {}),
    },
  });
  if (claimed.count !== 1) return false;
  activeCycleLeases.set(cycle.id, ownerToken);
  try {
    const secondGate = await loadDailyPracticeServiceGate(prisma, clock());
    if (!secondGate.open) {
      await pauseClaimedCycle(prisma, cycle.id, ownerToken);
      return true;
    }
    const activeUsers = await prisma.user.findMany({
      where: { status: AccountStatus.ACTIVE, ...(secondGate.internalTestUserIds ? { id: { in: secondGate.internalTestUserIds } } : {}) },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const revisionByUser = new Map<string, number>();
    for (let offset = 0; offset < activeUsers.length; offset += DAY_CREATE_BATCH) {
      const userIds = activeUsers
        .slice(offset, offset + DAY_CREATE_BATCH)
        .map((user) => user.id);
      await prisma.userPracticeProfile.createMany({
        data: userIds.map((userId) => ({ userId })),
        skipDuplicates: true,
      });
      const profiles = await prisma.userPracticeProfile.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, stateRevision: true },
      });
      for (const profile of profiles) {
        revisionByUser.set(profile.userId, profile.stateRevision);
      }
    }
    const executionBudgetMs = dailyPlanTimeoutMs();
    const dispatchBudgetMs =
      DAILY_PRACTICE_SPREAD_WINDOW_MS - executionBudgetMs - 1;
    const requiredConcurrency = requiredDailyPlanConcurrency({
      activeUserCount: activeUsers.length,
      providerP95Ms: executionBudgetMs,
      dispatchBudgetMs,
    });
    const configuredConcurrency = dailyPlanConcurrency();
    const capacityAccepted = requiredConcurrency <= configuredConcurrency;
    const baseSchedule = scheduleUsersAcrossWindow(
      cyclePracticeDate,
      activeUsers.map((user) => user.id),
      executionBudgetMs,
    );
    const resumeAt = clock();
    const schedule = recoveringFromPause
      ? shiftScheduleToResumeWindow(
          baseSchedule,
          practiceDayWindow(cyclePracticeDate).dayStartedAt,
          resumeAt,
        )
      : baseSchedule;
    const deadlineAt = recoveringFromPause
      ? new Date(resumeAt.getTime() + DAILY_PRACTICE_SPREAD_WINDOW_MS)
      : cycle.deadlineAt;
    if (recoveringFromPause) {
      const updated = await prisma.dailyPracticeCycle.updateMany({
        where: { id: cycle.id, leaseOwnerToken: ownerToken },
        data: { baselineAt: resumeAt, deadlineAt, candidateCutoffAt: resumeAt },
      });
      if (updated.count !== 1) throw new DailySchedulerLeaseLostError();
    }
    const fixedSnapshot = readFixedSnapshot(cycle.poolStats);
    for (let offset = 0; offset < schedule.length; offset += DAY_CREATE_BATCH) {
      const currentGate = await loadDailyPracticeServiceGate(prisma, clock());
      if (!currentGate.open) {
        await pauseClaimedCycle(prisma, cycle.id, ownerToken);
        return true;
      }
      const batch = schedule.slice(offset, offset + DAY_CREATE_BATCH).filter((item) => !currentGate.internalTestUserIds || currentGate.internalTestUserIds.includes(item.userId));
      await prisma.dailyPracticeDay.createMany({
        data: batch.map((scheduled) => ({
          cycleId: cycle.id,
          userId: scheduled.userId,
          practiceDate: cyclePracticeDateDb,
          scheduledAt: scheduled.scheduledAt,
          deadlineAt,
          status: DailyPracticeDayStatus.PENDING,
          profileRevision: revisionByUser.get(scheduled.userId) ?? 0,
          progressSetHash: cycle.progressSetHash,
          fixedQuestionSnapshot: fixedSnapshot as unknown as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
      if (recoveringFromPause) {
        await prisma.$transaction(
          batch.map((scheduled) =>
            prisma.dailyPracticeDay.updateMany({
              where: {
                cycleId: cycle.id,
                userId: scheduled.userId,
                status: DailyPracticeDayStatus.PAUSED,
              },
              data: {
                status: DailyPracticeDayStatus.PENDING,
                scheduledAt: scheduled.scheduledAt,
                deadlineAt,
              },
            }),
          ),
        );
      }
      const renewed = await prisma.dailyPracticeCycle.updateMany({
        where: { id: cycle.id, leaseOwnerToken: ownerToken },
        data: { leasedUntil: new Date(Date.now() + schedulerLeaseMs()) },
      });
      if (renewed.count !== 1) throw new DailySchedulerLeaseLostError();
    }
    if (recoveringFromPause) {
      await prisma.dailyPracticeDay.updateMany({
        where: {
          cycleId: cycle.id,
          status: DailyPracticeDayStatus.PAUSED,
        },
        data: {
          status: DailyPracticeDayStatus.FAILED,
          lastErrorCategory: 'NOT_ELIGIBLE_DURING_RESUME',
          lastErrorMessage: '账号未被纳入本次恢复后的每日练习生成范围',
        },
      });
    }
    const createdDays = await prisma.dailyPracticeDay.count({
      where: { cycleId: cycle.id },
    });
    await prisma.$transaction([
      prisma.dailyPracticeCycle.updateMany({
        where: { id: cycle.id, leaseOwnerToken: ownerToken },
        data: {
          status: capacityAccepted
            ? DailyPracticeCycleStatus.GENERATING
            : DailyPracticeCycleStatus.DEGRADED,
          counts: {
            activeUsers: activeUsers.length,
            createdDays,
            requiredConcurrency,
            configuredConcurrency,
            capacityAccepted,
          } as Prisma.InputJsonValue,
          lastErrorCategory: capacityAccepted ? null : 'CAPACITY_GATE_FAILED',
          lastErrorMessage: capacityAccepted
            ? null
            : '当前配置未通过保守容量门禁，仅允许确定性计划',
          leaseOwnerToken: null,
          leasedUntil: null,
        },
      }),
    ]);
    return true;
  } catch (error) {
    await prisma.dailyPracticeCycle.updateMany({
      where: { id: cycle.id, leaseOwnerToken: ownerToken },
      data: {
        status: DailyPracticeCycleStatus.FAILED,
        lastErrorCategory:
          error instanceof DailySchedulerLeaseLostError
            ? 'LEASE_LOST'
            : 'SCHEDULER_FAILED',
        lastErrorMessage: safeAiErrorMessage(error).slice(0, 500),
        leaseOwnerToken: null,
        leasedUntil: null,
      },
    });
    throw error;
  } finally {
    activeCycleLeases.delete(cycle.id);
  }
}

async function createCycleUnderSettingsLock(
  prisma: PrismaClient,
  clock: () => Date,
) {
  return prisma.$transaction(async (transaction) => {
    await lockDailyPracticeSettings(transaction);
    const lockedNow = clock();
    const lockedPracticeDate = practiceDateForInstant(lockedNow);
    const lockedPracticeDateDb = practiceDateToDbDate(lockedPracticeDate);
    const gate = await loadDailyPracticeServiceGate(transaction, lockedNow);
    if (!gate.open) return null;
    const existing = await transaction.dailyPracticeCycle.findUnique({
      where: { practiceDate: lockedPracticeDateDb },
    });
    if (existing) return existing;
    const frozen = await freezeCycleInputs(transaction, lockedPracticeDate, lockedNow);
    const window = practiceDayWindow(lockedPracticeDate);
    return transaction.dailyPracticeCycle.create({
      data: {
        practiceDate: lockedPracticeDateDb,
        baselineAt: window.dayStartedAt,
        deadlineAt: window.deadlineAt,
        candidateCutoffAt: lockedNow,
        status: DailyPracticeCycleStatus.BUILDING,
        settingsRevision: gate.settingsRevision,
        progressSetHash: frozen.progressSetHash,
        progressSnapshot: frozen.progressSnapshot as unknown as Prisma.InputJsonValue,
        fixedAssignmentId: frozen.fixedAssignmentId,
        frozenFixedAssignmentHash: frozen.frozenFixedAssignmentHash,
        poolStats: {
          frozenFixedQuestions: frozen.fixedQuestionSnapshot,
          invalidFixedQuestionIds: frozen.invalidFixedQuestionIds,
          unresolvedProgressNodeCount: frozen.unresolvedProgressNodeCount,
          remappedProgressNodeCount: frozen.remappedProgressNodeCount,
          candidateQuestionCount: frozen.candidateQuestionCount,
          candidateSetHash: frozen.candidateSetHash,
          candidateTypeCounts: frozen.candidateTypeCounts,
          gapSummary: frozen.gapSummary,
        } as unknown as Prisma.InputJsonValue,
        counts: { activeUsers: 0, createdDays: 0 } as Prisma.InputJsonValue,
      },
    });
  });
}

export async function lockDailyPracticeSettings(transaction: Prisma.TransactionClient) {
  const rows = await transaction.$queryRaw<Array<{ singletonId: number }>>(
    Prisma.sql`
      SELECT singletonId
      FROM DailyPracticeSettings
      WHERE singletonId = 1
      FOR UPDATE
    `,
  );
  if (rows.length !== 1) {
    throw new Error('DailyPracticeSettings singleton is missing');
  }
}

export function shiftScheduleToResumeWindow<T extends { scheduledAt: Date }>(
  schedule: T[],
  originalBaselineAt: Date,
  resumedAt: Date,
) {
  return schedule.map((entry) => ({
    ...entry,
    scheduledAt: new Date(
      resumedAt.getTime() +
        Math.max(0, entry.scheduledAt.getTime() - originalBaselineAt.getTime()),
    ),
  }));
}

export async function releaseActiveDailySchedulerLeases(prisma: PrismaClient) {
  for (const [cycleId, ownerToken] of [...activeCycleLeases]) {
    await prisma.dailyPracticeCycle.updateMany({
      where: { id: cycleId, leaseOwnerToken: ownerToken },
      data: { leaseOwnerToken: null, leasedUntil: null },
    });
    activeCycleLeases.delete(cycleId);
  }
}

export async function reconcileDailyPracticeCycle(
  prisma: PrismaClient,
  cycleId: string,
  existingCounts: Prisma.JsonValue | null,
  now = new Date(),
  eligibleUserIds?: string[] | null,
) {
  const statusRows = await prisma.dailyPracticeDay.groupBy({
    by: ['status'],
    where: {
      cycleId,
      ...(eligibleUserIds ? { userId: { in: eligibleUserIds } } : {}),
    },
    _count: { _all: true },
  });
  const statusCounts = Object.fromEntries(
    statusRows.map((row) => [row.status, row._count._all]),
  );
  const totalUsers = statusRows.reduce(
    (sum, row) => sum + row._count._all,
    0,
  );
  const unfinished =
    (statusCounts[DailyPracticeDayStatus.PENDING] ?? 0) +
    (statusCounts[DailyPracticeDayStatus.PROCESSING] ?? 0) +
    (statusCounts[DailyPracticeDayStatus.PAUSED] ?? 0) +
    (statusCounts[DailyPracticeDayStatus.STALE] ?? 0);
  if (unfinished > 0) return false;

  const degradedStatuses = new Set<DailyPracticeDayStatus>([
    DailyPracticeDayStatus.LIMITED_CONTENT,
    DailyPracticeDayStatus.NO_CONTENT,
    DailyPracticeDayStatus.DEGRADED_READY,
    DailyPracticeDayStatus.FAILED,
    DailyPracticeDayStatus.STALE,
  ]);
  const degraded = statusRows.some(
    (row) => degradedStatuses.has(row.status) && row._count._all > 0,
  );
  const counts = {
    ...(isRecord(existingCounts) ? existingCounts : {}),
    totalUsers,
    terminalUsers: totalUsers,
    statusCounts,
    finalizedAt: now.toISOString(),
  };
  const updated = await prisma.dailyPracticeCycle.updateMany({
    where: {
      id: cycleId,
      status: {
        in: [
          DailyPracticeCycleStatus.GENERATING,
          DailyPracticeCycleStatus.DEGRADED,
        ],
      },
    },
    data: {
      status: degraded
        ? DailyPracticeCycleStatus.DEGRADED
        : DailyPracticeCycleStatus.READY,
      counts: counts as Prisma.InputJsonValue,
      leaseOwnerToken: null,
      leasedUntil: null,
    },
  });
  return updated.count === 1;
}

async function replenishInternalTestDays(
  prisma: PrismaClient,
  cycle: {
    id: string;
    practiceDate: Date;
    progressSetHash: string;
    poolStats: Prisma.JsonValue | null;
    counts: Prisma.JsonValue | null;
    status: DailyPracticeCycleStatus;
  },
  eligibleUserIds: string[],
  now: Date,
) {
  const existing = await prisma.dailyPracticeDay.findMany({
    where: { cycleId: cycle.id, userId: { in: eligibleUserIds } },
    select: { userId: true },
  });
  const existingIds = new Set(existing.map((day) => day.userId));
  const missingUserIds = eligibleUserIds.filter((userId) => !existingIds.has(userId));
  if (!missingUserIds.length) return false;

  await prisma.userPracticeProfile.createMany({
    data: missingUserIds.map((userId) => ({ userId })),
    skipDuplicates: true,
  });
  const profiles = await prisma.userPracticeProfile.findMany({
    where: { userId: { in: missingUserIds } },
    select: { userId: true, stateRevision: true },
  });
  const revisionByUser = new Map(
    profiles.map((profile) => [profile.userId, profile.stateRevision]),
  );
  const deadlineAt = new Date(now.getTime() + DAILY_PRACTICE_SPREAD_WINDOW_MS);
  const fixedSnapshot = readFixedSnapshot(cycle.poolStats);
  await prisma.dailyPracticeDay.createMany({
    data: missingUserIds.map((userId) => ({
      cycleId: cycle.id,
      userId,
      practiceDate: practiceDateToDbDate(practiceDateFromDbDate(cycle.practiceDate)),
      scheduledAt: now,
      deadlineAt,
      status: DailyPracticeDayStatus.PENDING,
      profileRevision: revisionByUser.get(userId) ?? 0,
      progressSetHash: cycle.progressSetHash,
      fixedQuestionSnapshot: fixedSnapshot as unknown as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });

  const createdDays = await prisma.dailyPracticeDay.count({
    where: { cycleId: cycle.id },
  });
  const counts = isRecord(cycle.counts) ? { ...cycle.counts } : {};
  delete counts.finalizedAt;
  delete counts.terminalUsers;
  delete counts.statusCounts;
  await prisma.dailyPracticeCycle.updateMany({
    where: {
      id: cycle.id,
      status: {
        in: [
          DailyPracticeCycleStatus.GENERATING,
          DailyPracticeCycleStatus.DEGRADED,
          DailyPracticeCycleStatus.READY,
        ],
      },
    },
    data: {
      status: DailyPracticeCycleStatus.GENERATING,
      counts: {
        ...counts,
        activeUsers: eligibleUserIds.length,
        createdDays,
      } as Prisma.InputJsonValue,
      lastErrorCategory: null,
      lastErrorMessage: null,
    },
  });
  return true;
}

export async function finalizePastDailyPracticeSuggestions(
  prisma: PrismaClient,
  currentPracticeDate: Date,
) {
  const pending = await prisma.dailyPracticeSuggestion.findMany({
    where: {
      status: DailyPracticeSuggestionStatus.PENDING,
      targetPracticeDate: { lt: currentPracticeDate },
    },
    select: { id: true, targetPracticeDate: true },
    orderBy: [{ targetPracticeDate: 'asc' }, { createdAt: 'asc' }],
    take: 500,
  });
  if (!pending.length) return 0;
  const targetDates = uniqueStrings(
    pending.map(({ targetPracticeDate }) =>
      practiceDateFromDbDate(targetPracticeDate),
    ),
  );
  const cycles = await prisma.dailyPracticeCycle.findMany({
    where: {
      practiceDate: {
        in: targetDates.map(practiceDateToDbDate),
      },
    },
    select: { practiceDate: true },
  });
  const cycleDates = new Set(
    cycles.map(({ practiceDate }) => practiceDateFromDbDate(practiceDate)),
  );
  const expiredIds: string[] = [];
  const notAppliedIds: string[] = [];
  for (const suggestion of pending) {
    const targetDate = practiceDateFromDbDate(suggestion.targetPracticeDate);
    (cycleDates.has(targetDate) ? notAppliedIds : expiredIds).push(
      suggestion.id,
    );
  }
  const [expired, notApplied] = await prisma.$transaction([
    prisma.dailyPracticeSuggestion.updateMany({
      where: {
        id: { in: expiredIds },
        status: DailyPracticeSuggestionStatus.PENDING,
      },
      data: { status: DailyPracticeSuggestionStatus.EXPIRED_SERVICE_PAUSED },
    }),
    prisma.dailyPracticeSuggestion.updateMany({
      where: {
        id: { in: notAppliedIds },
        status: DailyPracticeSuggestionStatus.PENDING,
      },
      data: { status: DailyPracticeSuggestionStatus.NOT_APPLIED },
    }),
  ]);
  return expired.count + notApplied.count;
}

export function projectCurriculumProgress(courses: readonly PracticeCourseSnapshot[], practiceDate: string): FrozenProgressNode[] {
  return courses.flatMap((course) =>
    learnedCourseTopics(course, practiceDate).map((topic) => ({
      courseId: course.id,
      subjectId: course.subjectId,
      subjectName: course.subjectName,
      courseRevision: course.revision,
      topicHash: course.topicHash,
      topicId: topic.id,
      title: topic.title,
      firstTaughtDate: topicTaughtOn(topic),
      availableOn: topicAvailableOn(topic),
      examDate: course.examDate,
    })),
  ).sort((left, right) => compareAscii(left.courseId, right.courseId) || compareAscii(left.topicId, right.topicId));
}

export async function freezeCycleInputs(
  prisma: Prisma.TransactionClient,
  practiceDate: string,
  cutoffAt = new Date(),
): Promise<FrozenCycleInputs> {
  const practiceDateDb = practiceDateToDbDate(practiceDate);
  const courses = await loadPracticeCourses(prisma);
  const progressSnapshot = projectCurriculumProgress(courses, practiceDate);
  const eligible = await loadEligiblePracticeQuestions(prisma, practiceDate, { courses, cutoffAt });
  const eligibleById = new Map(eligible.map((question) => [question.id, question]));
  const candidateTypeCounts: Record<string, number> = {};
  for (const question of eligible) candidateTypeCounts[question.type] = (candidateTypeCounts[question.type] ?? 0) + 1;
  const candidateStats = {
    candidateQuestionCount: eligible.length,
    candidateSetHash: sha256(stableJson(eligible.map((question) => [question.id, question.contentRevision, question.curriculumMapping!.revision]))),
    candidateTypeCounts,
    gapSummary: courses.map((course) => ({
      subjectId: course.subjectId,
      subject: course.subjectName,
      nodeCount: progressSnapshot.filter((topic) => topic.courseId === course.id).length,
      eligibleQuestionCount: eligible.filter((question) => question.curriculumMapping!.courseId === course.id).length,
    })),
  };
  const assignment = await prisma.dailyPracticeFixedAssignment.findFirst({
    where: { practiceDate: practiceDateDb },
    orderBy: [{ revision: 'desc' }, { publishedAt: 'desc' }],
    include: {
      questions: {
        orderBy: { ordinal: 'asc' },
        include: {
          question: {
            include: {
              subject: { select: { name: true, active: true } },
              chapters: {
                select: { chapterId: true, chapter: { select: { active: true } } },
                orderBy: { chapterId: 'asc' },
              },
            },
          },
        },
      },
    },
  });
  const fixedQuestionSnapshot: FrozenFixedQuestion[] = [];
  const invalidFixedQuestionIds: string[] = [];
  for (const configured of assignment?.questions ?? []) {
    const question = configured.question;
    const valid =
      eligibleById.has(question.id) &&
      question.enabled &&
      question.reviewStatus === QuizQuestionReviewStatus.APPROVED &&
      question.reviewRevision === configured.questionReviewRevision &&
      (question.origin === QuizQuestionOrigin.MANUAL ||
        question.origin === QuizQuestionOrigin.CSV) &&
      question.subject.active &&
      question.chapters.length > 0 &&
      question.chapters.every((chapter) => chapter.chapter.active) &&
      sha256(question.prompt) === configured.promptHash;
    if (!valid || (question.type === 'SHORT_ANSWER' && fixedQuestionSnapshot.some((item) => item.gradingType === 'SHORT_ANSWER'))) {
      invalidFixedQuestionIds.push(question.id);
      continue;
    }
    fixedQuestionSnapshot.push({
      questionId: question.id,
      ordinal: fixedQuestionSnapshot.length + 1,
      questionReviewRevision: question.reviewRevision,
      questionContentRevision: question.contentRevision,
      sourceRevision: question.sourceRevision,
      promptHash: configured.promptHash,
      gradingType: question.type,
      typeLabel: question.typeLabel,
      promptExcerpt: boundText(question.prompt, 300),
      subjectId: question.subjectId,
      subjectName: question.subject.name,
      chapterIds: question.chapters.map((chapter) => chapter.chapterId),
    });
  }
  return {
    progressSnapshot,
    progressSetHash: sha256(stableJson(progressSnapshot)),
    fixedAssignmentId: assignment?.id ?? null,
    fixedQuestionSnapshot,
    frozenFixedAssignmentHash: sha256(stableJson(fixedQuestionSnapshot)),
    invalidFixedQuestionIds,
    unresolvedProgressNodeCount: 0,
    remappedProgressNodeCount: 0,
    ...candidateStats,
  };
}

function readFixedSnapshot(value: Prisma.JsonValue | null) {
  if (!isRecord(value) || !Array.isArray(value.frozenFixedQuestions)) return [];
  return value.frozenFixedQuestions;
}

const REBUILDABLE_DAY_STATUSES = [
  DailyPracticeDayStatus.PENDING,
  DailyPracticeDayStatus.PROCESSING,
  DailyPracticeDayStatus.READY,
  DailyPracticeDayStatus.LIMITED_CONTENT,
  DailyPracticeDayStatus.NO_CONTENT,
  DailyPracticeDayStatus.DEGRADED_READY,
  DailyPracticeDayStatus.FAILED,
  DailyPracticeDayStatus.PAUSED,
  DailyPracticeDayStatus.STALE,
] as const;

export async function refreshInvalidatedFixedQuestions(
  prisma: PrismaClient,
  cycleId: string,
) {
  return prisma.$transaction(async (transaction) => {
    const locked = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT id
        FROM DailyPracticeCycle
        WHERE id = ${cycleId}
        FOR UPDATE
      `,
    );
    if (!locked.length) return false;
    const cycle = await transaction.dailyPracticeCycle.findUnique({
      where: { id: cycleId },
      select: {
        id: true,
        status: true,
        poolStats: true,
        counts: true,
        practiceDate: true,
      },
    });
    if (!cycle) return false;
    const frozen = readFixedSnapshot(
      cycle.poolStats,
    ) as unknown as FrozenFixedQuestion[];
    if (!frozen.length) return false;
    const current = await filterCurrentFixedQuestions(transaction, frozen, practiceDateFromDbDate(cycle.practiceDate));
    if (stableJson(current) === stableJson(frozen)) return false;

    const currentIds = new Set(current.map((question) => question.questionId));
    const removedIds = frozen
      .filter((question) => !currentIds.has(question.questionId))
      .map((question) => question.questionId);
    const poolStats = isRecord(cycle.poolStats)
      ? { ...cycle.poolStats }
      : {};
    const existingInvalidIds = Array.isArray(poolStats.invalidFixedQuestionIds)
      ? poolStats.invalidFixedQuestionIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    poolStats.frozenFixedQuestions = current as unknown as Prisma.JsonValue;
    poolStats.invalidFixedQuestionIds = uniqueStrings([
      ...existingInvalidIds,
      ...removedIds,
    ]);

    const rebuiltAt = new Date();
    await transaction.dailyPracticePlanRevision.updateMany({
      where: {
        generatedAt: null,
        day: {
          cycleId,
          status: { in: [...REBUILDABLE_DAY_STATUSES] },
          startedAt: null,
          completedAt: null,
        },
      },
      data: {
        generatedAt: rebuiltAt,
        degradedReason: 'FIXED_QUESTION_INVALIDATED',
      },
    });
    const commonDayData = {
      fixedQuestionSnapshot: current as unknown as Prisma.InputJsonValue,
      candidateSnapshot: Prisma.DbNull,
      candidateHash: null,
      lastErrorCategory: 'FIXED_QUESTION_INVALIDATED',
      lastErrorMessage: '管理员固定题已失效，正在统一重建未开始计划',
    };
    const rebuilt = await transaction.dailyPracticeDay.updateMany({
      where: {
        cycleId,
        status: {
          in: REBUILDABLE_DAY_STATUSES.filter(
            (status) => status !== DailyPracticeDayStatus.PAUSED,
          ),
        },
        startedAt: null,
        completedAt: null,
      },
      data: {
        ...commonDayData,
        status: DailyPracticeDayStatus.STALE,
      },
    });
    const paused = await transaction.dailyPracticeDay.updateMany({
      where: {
        cycleId,
        status: DailyPracticeDayStatus.PAUSED,
        startedAt: null,
        completedAt: null,
      },
      data: commonDayData,
    });
    const affectedDays = rebuilt.count + paused.count;
    const counts = isRecord(cycle.counts) ? { ...cycle.counts } : {};
    delete counts.finalizedAt;
    delete counts.terminalUsers;
    delete counts.statusCounts;
    await transaction.dailyPracticeCycle.update({
      where: { id: cycleId },
      data: {
        frozenFixedAssignmentHash: sha256(stableJson(current)),
        poolStats: poolStats as unknown as Prisma.InputJsonValue,
        counts: counts as Prisma.InputJsonValue,
        ...(affectedDays > 0 && cycle.status !== DailyPracticeCycleStatus.PAUSED
          ? { status: DailyPracticeCycleStatus.GENERATING }
          : {}),
      },
    });
    return true;
  });
}

export async function processRequestedCycleRefreeze(
  prisma: PrismaClient,
  cycleId: string,
): Promise<boolean> {
  let outcome: {
    processed: boolean;
    leasedDayIds: string[];
  } = { processed: false, leasedDayIds: [] };
  await prisma.$transaction(async (transaction) => {
    await lockDailyPracticeSettings(transaction);
    const locked = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT id
        FROM DailyPracticeCycle
        WHERE id = ${cycleId}
        FOR UPDATE
      `,
    );
    if (!locked.length) return;
    const cycle = await transaction.dailyPracticeCycle.findUnique({
      where: { id: cycleId },
      select: {
        id: true,
        status: true,
        poolStats: true,
        counts: true,
        practiceDate: true,
        refreezeRequestedAt: true,
        refreezeRequestedById: true,
        deadlineAt: true,
      },
    });
    if (!cycle || cycle.refreezeRequestedAt === null) return;
    const leasedDays = await transaction.dailyPracticeDay.findMany({
      where: {
        cycleId,
        startedAt: null,
        completedAt: null,
        leaseOwnerToken: { not: null },
        status: { in: [...REBUILDABLE_DAY_STATUSES] },
      },
      select: { id: true },
    });
    const rebuiltAt = new Date();
    // An explicit rebuild needs a new generation window after the morning deadline.
    // Automatic invalidation must not keep extending that window.
    const manualDeadlineAt = cycle.refreezeRequestedById
      ? new Date(Math.max(
          cycle.deadlineAt.getTime(),
          rebuiltAt.getTime() + DAILY_PRACTICE_SPREAD_WINDOW_MS,
        ))
      : null;
    const frozen = await freezeCycleInputs(
      transaction,
      practiceDateFromDbDate(cycle.practiceDate),
      rebuiltAt,
    );

    await transaction.dailyPracticePlanRevision.updateMany({
      where: {
        generatedAt: null,
        day: {
          cycleId,
          status: { in: [...REBUILDABLE_DAY_STATUSES] },
          startedAt: null,
          completedAt: null,
        },
      },
      data: {
        generatedAt: rebuiltAt,
        degradedReason: 'CYCLE_REFROZEN',
      },
    });
    const commonDayData = {
      ...(manualDeadlineAt
        ? { scheduledAt: rebuiltAt, deadlineAt: manualDeadlineAt }
        : {}),
      fixedQuestionSnapshot:
        frozen.fixedQuestionSnapshot as unknown as Prisma.InputJsonValue,
      candidateSnapshot: Prisma.DbNull,
      candidateHash: null,
      progressSetHash: frozen.progressSetHash,
      lastErrorCategory: 'CYCLE_REFROZEN',
      lastErrorMessage: '周期已重新冻结，正在统一重建未开始计划',
      leaseOwnerToken: null,
      leasedUntil: null,
    };
    const rebuilt = await transaction.dailyPracticeDay.updateMany({
      where: {
        cycleId,
        status: {
          in: REBUILDABLE_DAY_STATUSES.filter(
            (status) => status !== DailyPracticeDayStatus.PAUSED,
          ),
        },
        startedAt: null,
        completedAt: null,
      },
      data: {
        ...commonDayData,
        status: DailyPracticeDayStatus.STALE,
      },
    });
    const paused = await transaction.dailyPracticeDay.updateMany({
      where: {
        cycleId,
        status: DailyPracticeDayStatus.PAUSED,
        startedAt: null,
        completedAt: null,
      },
      data: commonDayData,
    });
    const affectedDays = rebuilt.count + paused.count;
    const counts = isRecord(cycle.counts) ? { ...cycle.counts } : {};
    delete counts.finalizedAt;
    delete counts.terminalUsers;
    delete counts.statusCounts;
    await transaction.dailyPracticeCycle.update({
      where: { id: cycleId },
      data: {
        progressSnapshot:
          frozen.progressSnapshot as unknown as Prisma.InputJsonValue,
        progressSetHash: frozen.progressSetHash,
        fixedAssignmentId: frozen.fixedAssignmentId,
        frozenFixedAssignmentHash: frozen.frozenFixedAssignmentHash,
        candidateCutoffAt: rebuiltAt,
        ...(affectedDays > 0 && manualDeadlineAt
          ? { deadlineAt: manualDeadlineAt }
          : {}),
        poolStats: {
          frozenFixedQuestions: frozen.fixedQuestionSnapshot,
          invalidFixedQuestionIds: frozen.invalidFixedQuestionIds,
          unresolvedProgressNodeCount: frozen.unresolvedProgressNodeCount,
          remappedProgressNodeCount: frozen.remappedProgressNodeCount,
          candidateQuestionCount: frozen.candidateQuestionCount,
          candidateSetHash: frozen.candidateSetHash,
          candidateTypeCounts: frozen.candidateTypeCounts,
          gapSummary: frozen.gapSummary,
        } as unknown as Prisma.InputJsonValue,
        counts: counts as Prisma.InputJsonValue,
        refreezeRequestedAt: null,
        refreezeRequestedById: null,
        lastErrorCategory: null,
        lastErrorMessage: null,
        ...(affectedDays > 0 && cycle.status !== DailyPracticeCycleStatus.PAUSED
          ? { status: DailyPracticeCycleStatus.GENERATING }
          : {}),
      },
    });
    outcome = {
      processed: true,
      leasedDayIds: leasedDays.map((day) => day.id),
    };
  });
  if (!outcome.processed) return false;
  for (const dayId of outcome.leasedDayIds) {
    abortActiveDayGeneration(dayId, 'CYCLE_REFROZEN');
  }
  return true;
}

export async function filterCurrentFixedQuestions(
  prisma: Pick<PrismaClient, 'quizQuestion' | 'practiceCourse' | 'practiceQuestionMapping'>,
  frozen: FrozenFixedQuestion[],
  practiceDate = practiceDateForInstant(new Date()),
) {
  if (!frozen.length) return frozen;
  const eligible = await loadEligiblePracticeQuestions(prisma, practiceDate, { questionIds: frozen.map((question) => question.questionId) });
  const eligibleIds = new Set(eligible.map((question) => question.id));
  const rows = await prisma.quizQuestion.findMany({
    where: { id: { in: frozen.map((question) => question.questionId) } },
    select: {
      id: true,
      enabled: true,
      origin: true,
      reviewStatus: true,
      reviewRevision: true,
      contentRevision: true,
      sourceRevision: true,
      prompt: true,
      subject: { select: { active: true } },
      chapters: {
        select: { chapter: { select: { active: true } } },
      },
    },
  });
  const current = new Map(rows.map((row) => [row.id, row]));
  let retainedShortAnswers = 0;
  return frozen
    .filter((question) => {
      const row = current.get(question.questionId);
      return Boolean(
        row &&
          eligibleIds.has(question.questionId) &&
          row.contentRevision === question.questionContentRevision &&
          row.enabled &&
          (row.origin === QuizQuestionOrigin.MANUAL ||
            row.origin === QuizQuestionOrigin.CSV) &&
          row.reviewStatus === QuizQuestionReviewStatus.APPROVED &&
          row.reviewRevision === question.questionReviewRevision &&
          row.sourceRevision === question.sourceRevision &&
          row.subject.active &&
          row.chapters.length > 0 &&
          row.chapters.every(({ chapter }) => chapter.active) &&
          sha256(row.prompt) === question.promptHash,
      );
    })
    .filter((question) => question.gradingType !== 'SHORT_ANSWER' || retainedShortAnswers++ === 0)
    .map((question, index) => ({ ...question, ordinal: index + 1 }));
}

async function pauseClaimedCycle(
  prisma: PrismaClient,
  cycleId: string,
  ownerToken: string,
) {
  await prisma.$transaction([
    prisma.dailyPracticeDay.updateMany({
      where: { cycleId, status: DailyPracticeDayStatus.PENDING },
      data: { status: DailyPracticeDayStatus.PAUSED },
    }),
    prisma.dailyPracticeCycle.updateMany({
      where: { id: cycleId, leaseOwnerToken: ownerToken },
      data: {
        status: DailyPracticeCycleStatus.PAUSED,
        leaseOwnerToken: null,
        leasedUntil: null,
      },
    }),
  ]);
}

function schedulerLeaseMs() {
  return configuredInteger('DAILY_PRACTICE_JOB_LEASE_MS', 60_000, 3_600_000, 600_000);
}

function dailyPlanTimeoutMs() {
  return configuredInteger('AI_DAILY_PLAN_TIMEOUT_MS', 1_000, 600_000, 180_000);
}

function dailyPlanConcurrency() {
  return configuredInteger('AI_DAILY_PLAN_CONCURRENCY', 1, 100, 1);
}

function configuredInteger(name: string, minimum: number, maximum: number, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be ${minimum}-${maximum}`);
  }
  return value;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareAscii)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundText(value: string, maximum: number) {
  return Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' '))
    .slice(0, maximum)
    .join('')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cycleCountsAreFinalized(value: Prisma.JsonValue | null) {
  return isRecord(value) && typeof value.finalizedAt === 'string';
}

function sourceKey(documentId: string, nodePathHash: string) {
  return `${documentId}\u0000${nodePathHash}`;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function compareAscii(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

class DailySchedulerLeaseLostError extends Error {
  constructor() {
    super('daily scheduler lease was lost');
    this.name = 'DailySchedulerLeaseLostError';
  }
}
