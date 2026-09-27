import { loadPracticeQuestionImages } from './practice-question-images';
import { randomUUID } from 'node:crypto';
import {
  AiClient,
  AiClientError,
  estimateTokens,
  readAiRuntimeConfig,
  type AiCompletion,
  type AiRequest,
} from '@bmc3/ai-core';
import {
  DAILY_PERSONALIZATION_PROMPT_VERSION,
  DAILY_PERSONALIZATION_SYSTEM_PROMPT,
  DailyPersonalizationValidationError,
  buildDailyPersonalizationPayload,
  buildDeterministicFallback,
  dynamicKnowledgeCount,
  dynamicQuestionCount,
  parseDailyPersonalizationOutput,
  practiceDateForInstant,
  practiceDateFromDbDate,
  practiceDateToDbDate,
  practiceDayWindow,
  prepareCandidates,
  practiceDateDifference,
  selectCurriculumQuestions,
  shortlistCurriculumCandidates,
  type CurriculumScoredCandidate,
  type PracticeCourseSnapshot,
  projectPreviousLearningSummary,
  serializeDailyPersonalizationPayload,
  type DailyPersonalizationOutput,
  type DailyPersonalizationPayload,
} from '@bmc3/daily-practice-core';
import { loadPracticeCourses, loadEligiblePracticeQuestions, assertDailyQuestionEligibility } from '@bmc3/daily-practice-prisma';
import {
  AccountStatus,
  AiTaskStrategy,
  AiTaskType,
  DailyPracticeDayStatus,
  DailyPracticeGenerationSource,
  DailyPracticePlanItemSource,
  DailyPracticePlanTrigger,
  DailyPracticeStrategyAttemptStatus,
  DailyPracticeSuggestionStatus,
  Prisma,
  Role,
  UserPracticeInitializationStatus,
  type PrismaClient,
} from '@prisma/client';
import {
  AiInvocationIdempotencyError,
  cancelAiInvocationBeforeDispatch,
  finishAiInvocationFailure,
  finishAiInvocationSuccess,
  reserveAiInvocation,
  safeAiErrorMessage,
} from './ai-invocation-gateway';
import {
  filterCurrentFixedQuestions,
  lockDailyPracticeSettings,
  projectCurriculumProgress,
  sha256,
  stableJson,
  type FrozenFixedQuestion,
  type FrozenProgressNode,
} from './daily-practice-scheduler';
export { filterCurrentFixedQuestions } from './daily-practice-scheduler';
import { activeDays } from './daily-practice-active-days';
import { loadDailyPracticeServiceGate, loadDailyPracticeDayGate } from './daily-practice-service';

export const DAILY_PRACTICE_STRATEGIES = [
  AiTaskStrategy.PRO_MAX,
  AiTaskStrategy.PRO_HIGH,
  AiTaskStrategy.FLASH_NO_THINKING,
] as const;

interface DailyGenerationClient {
  complete(request: AiRequest): Promise<AiCompletion>;
  model(strategy: AiTaskStrategy, vision?: boolean): string;
}

export interface DailyGenerationDependencies {
  client?: DailyGenerationClient;
  now?: () => Date;
}

interface FrozenCandidateQuestion {
  questionId: string;
  questionAlias: string;
  questionReviewRevision: number;
  sourceRevision: number;
  gradingType: 'SINGLE' | 'MULTIPLE' | 'TRUE_FALSE' | 'SHORT_ANSWER';
  sourceKeys: string[];
  questionContentRevision: number;
  mappingRevision: number;
}

interface FrozenDailyGeneration {
  version: 2;
  eligibleCount: number;
  scoredCount: number;
  revisionId: string;
  profileRevision: number;
  payload: DailyPersonalizationPayload;
  candidateQuestions: FrozenCandidateQuestion[];
  fixedQuestions: FrozenFixedQuestion[];
  suggestionIds: string[];
  inputHash: string;
  candidateHash: string;
  previousSummarySourceRevisionId: string | null;
  courseVersions: Array<{ id: string; revision: number; topicHash: string }>;
}

interface LoadedDay {
  id: string;
  userId: string;
  practiceDate: Date;
  deadlineAt: Date;
  status: DailyPracticeDayStatus;
  leaseOwnerToken: string | null;
  profileRevision: number;
  progressSetHash: string;
  candidateSnapshot: Prisma.JsonValue | null;
  fixedQuestionSnapshot: Prisma.JsonValue | null;
  candidateHash: string | null;
  cycle: {
    id: string;
    baselineAt: Date;
    candidateCutoffAt: Date;
    deadlineAt: Date;
    status: string;
    progressSetHash: string;
    progressSnapshot: Prisma.JsonValue;
    lastErrorCategory: string | null;
  };
  user: {
    status: AccountStatus;
    practiceProfile: {
      stateRevision: number;
      initializationStatus: UserPracticeInitializationStatus;
      attemptCount: number;
      questionCount: number;
      correctCount: number;
      wrongCount: number;
    } | null;
  };
  revisions: Array<{
    id: string;
    revision: number;
    trigger: DailyPracticePlanTrigger;
    inputHash: string | null;
    generatedAt: Date | null;
    createdById: string | null;
  }>;
}

export async function processNextDailyPracticeGeneration(
  prisma: PrismaClient,
  dependencies: DailyGenerationDependencies = {},
) {
  const now = dependencies.now?.() ?? new Date();
  const gate = await loadDailyPracticeServiceGate(prisma, now);
  if (!gate.open) return false;
  if (await finalizeDeadlineBlockedDay(prisma, now, gate.internalTestUserIds)) return true;
  const candidate = await prisma.dailyPracticeDay.findFirst({
    where: {
      ...(gate.internalTestUserIds ? { userId: { in: gate.internalTestUserIds } } : {}),
      status: {
        in: [
          DailyPracticeDayStatus.PENDING,
          DailyPracticeDayStatus.PROCESSING,
          DailyPracticeDayStatus.STALE,
        ],
      },
      scheduledAt: { lte: now },
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
      user: {
        status: AccountStatus.ACTIVE,
        quizAttempts: { none: { submittedAt: { not: null }, questionStateAppliedAt: null } },
        practiceProfile: {
          is: { initializationStatus: UserPracticeInitializationStatus.READY },
        },
      },
    },
    orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  const candidateId = candidate?.id ?? (await findPreviewCandidate(prisma, now, gate.internalTestUserIds));
  if (!candidateId) return false;
  const [pendingRevision, currentDay] = await Promise.all([
    findNextPendingRevision(prisma, candidateId),
    prisma.dailyPracticeDay.findUnique({
      where: { id: candidateId },
      select: { status: true },
    }),
  ]);
  if (!currentDay) return true;
  const previewOnly =
    pendingRevision?.trigger === DailyPracticePlanTrigger.ADMIN_PREVIEW;
  let preservedStatus = previewOnly ? currentDay.status : null;
  const ownerToken = randomUUID();
  const claim = await prisma.dailyPracticeDay.updateMany({
    where: {
      id: candidateId,
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
      ...(previewOnly
        ? {}
        : {
            status: {
              in: [
                DailyPracticeDayStatus.PENDING,
                DailyPracticeDayStatus.PROCESSING,
                DailyPracticeDayStatus.STALE,
              ],
            },
          }),
    },
    data: {
      ...(previewOnly ? {} : { status: DailyPracticeDayStatus.PROCESSING }),
      leaseOwnerToken: ownerToken,
      leasedUntil: new Date(now.getTime() + dailyLeaseMs()),
      lastErrorCategory: null,
      lastErrorMessage: null,
    },
  });
  if (claim.count !== 1) return true;
  const controller = new AbortController();
  activeDays.set(candidateId, { ownerToken, controller, preservedStatus });
  const heartbeat = setInterval(() => {
    void heartbeatDay(prisma, candidateId, ownerToken, controller);
  }, Math.max(1_000, Math.min(10_000, Math.floor(dailyLeaseMs() / 3))));
  heartbeat.unref();
  let claimedRevision: LoadedDay['revisions'][number] | null = null;
  try {
    const day = await loadDay(prisma, candidateId);
    if (!day) return true;
    const revision = await selectOrCreateRevision(prisma, day, ownerToken);
    claimedRevision = revision;
    if (revision.trigger === DailyPracticePlanTrigger.ADMIN_PREVIEW) {
      preservedStatus ??= currentDay.status;
      const active = activeDays.get(candidateId);
      if (active) active.preservedStatus = preservedStatus;
    }
    const frozen = await loadOrFreezeGeneration(prisma, day, revision, ownerToken);
    const noModelReason = deterministicReason(day, revision, frozen, now);
    if (noModelReason) {
      const fallback = buildDeterministicFallback(frozen.payload, noModelReason);
      await publishPlan(
        prisma,
        day,
        revision,
        frozen,
        fallback.output,
        DailyPracticeGenerationSource.DETERMINISTIC,
        fallback.degradedReason,
        ownerToken,
        preservedStatus,
      );
      return true;
    }

    const config = readAiRuntimeConfig(process.env);
    const client = dependencies.client ?? new AiClient(config);
    const images = await loadPracticeQuestionImages(prisma, [
      ...frozen.candidateQuestions.map((question) => ({ questionId: question.questionId, alias: question.questionAlias })),
      ...frozen.fixedQuestions.map((question, index) => ({ questionId: question.questionId, alias: alias('F', index) })),
    ], controller.signal);
    let lastError = 'MODEL_UNAVAILABLE';
    for (const strategy of DAILY_PRACTICE_STRATEGIES) {
      if (!(await assertServiceAndLease(prisma, day.id, ownerToken))) {
        controller.abort(new DOMException('每日一练服务已暂停', 'AbortError'));
        await pauseDay(prisma, day.id, ownerToken, preservedStatus);
        return true;
      }
      const attempt = await beginStrategyAttempt(
        prisma,
        day.id,
        revision.id,
        strategy,
      );
      if (!attempt) continue;
      const originalRequest = buildDailyRequest(
        frozen.payload,
        strategy,
        controller.signal,
      );
      if (images.count) {
        originalRequest.vision = true;
        originalRequest.estimatedImageTokens = images.estimatedTokens;
        originalRequest.messages[1] = { role: 'user', content: [
          { type: 'text', text: serializeDailyPersonalizationPayload(frozen.payload) },
          ...images.blocks,
        ] };
      }
      let request = originalRequest;
      let responseAttempt = 0;
      const maximumResponseAttempts = strategy === AiTaskStrategy.PRO_MAX ? 2 : 1;
      while (responseAttempt < maximumResponseAttempts) {
        if (
          responseAttempt > 0 &&
          !(await assertServiceAndLease(prisma, day.id, ownerToken))
        ) {
          controller.abort(new DOMException('每日一练服务已暂停', 'AbortError'));
          await pauseDay(prisma, day.id, ownerToken, preservedStatus);
          return true;
        }
        let reservation;
        try {
          reservation = await reserveAiInvocation(prisma, {
            taskType: AiTaskType.DAILY_PLAN,
            request,
            model: client.model(strategy, request.vision),
            correlationType: 'DailyPracticePlanRevision',
            correlationId: revision.id,
            requestedById: revision.createdById,
            usageDate: day.practiceDate,
            usageScope: `PRACTICE:${practiceDateFromDbDate(day.practiceDate)}`,
            idempotencyKey: dailyInvocationIdempotencyKey(
              day.id,
              revision.id,
              strategy,
              responseAttempt,
            ),
            attempt:
              responseAttempt === 0
                ? DAILY_PRACTICE_STRATEGIES.indexOf(strategy) + 1
                : DAILY_PRACTICE_STRATEGIES.length + responseAttempt,
            concurrencyLimit: dailyConcurrency(),
            dailyCallLimit: dailyCallLimit(),
            dailyTokenLimit: dailyTokenLimit(),
            inputHash: responseAttempt === 0 && !images.count ? frozen.inputHash : undefined,
          });
          await prisma.dailyPracticeStrategyAttempt.updateMany({
            where: {
              id: attempt.id,
              status: DailyPracticeStrategyAttemptStatus.RUNNING,
            },
            data: { aiInvocationId: reservation.id },
          });
          if (!(await assertServiceAndLease(prisma, day.id, ownerToken))) {
            const cancelled = new DOMException('每日一练服务已暂停', 'AbortError');
            controller.abort(cancelled);
            await cancelAiInvocationBeforeDispatch(
              prisma,
              reservation,
              'SERVICE_PAUSED',
            );
            await failStrategyAttempt(prisma, attempt.id, cancelled);
            await pauseDay(prisma, day.id, ownerToken, preservedStatus);
            return true;
          }
        } catch (error) {
          lastError = errorCategory(error);
          await failStrategyAttempt(prisma, attempt.id, error);
          if (
            !(error instanceof AiInvocationIdempotencyError) &&
            !(await loadDailyPracticeServiceGate(prisma, new Date(), day.userId)).open
          ) {
            await pauseDay(prisma, day.id, ownerToken, preservedStatus);
            return true;
          }
          break;
        }
        let completion: AiCompletion;
        try {
          completion = await client.complete(request);
        } catch (error) {
          await finishAiInvocationFailure(prisma, reservation, error);
          lastError = errorCategory(error);
          if (shouldCorrectDailyMaxResponse(strategy, responseAttempt, error)) {
            request = buildDailyCorrectionRequest(originalRequest, null, error);
            responseAttempt += 1;
            continue;
          }
          await failStrategyAttempt(prisma, attempt.id, error);
          break;
        }
        await finishAiInvocationSuccess(prisma, reservation, completion);
        let output: DailyPersonalizationOutput;
        try {
          output = parseDailyPersonalizationOutput(
            completion.content,
            frozen.payload,
          );
        } catch (error) {
          lastError = errorCategory(error);
          if (shouldCorrectDailyMaxResponse(strategy, responseAttempt, error)) {
            request = buildDailyCorrectionRequest(
              originalRequest,
              completion.content,
              error,
            );
            responseAttempt += 1;
            continue;
          }
          await failStrategyAttempt(prisma, attempt.id, error);
          break;
        }
        await completeStrategyAttempt(prisma, attempt.id);
        await publishPlan(
          prisma,
          day,
          revision,
          frozen,
          output,
          generationSourceForStrategy(strategy),
          null,
          ownerToken,
          preservedStatus,
        );
        return true;
      }
    }
    const fallback = buildDeterministicFallback(frozen.payload, lastError);
    await publishPlan(
      prisma,
      day,
      revision,
      frozen,
      fallback.output,
      DailyPracticeGenerationSource.DETERMINISTIC,
      fallback.degradedReason,
      ownerToken,
      preservedStatus,
    );
  } catch (error) {
    const gateAfterError = await loadDailyPracticeDayGate(prisma, candidateId);
    if (!gateAfterError.open) {
      await pauseDay(prisma, candidateId, ownerToken, preservedStatus);
    } else if (preservedStatus !== null) {
      const statusToRestore = preservedStatus;
      await prisma.$transaction(async (transaction) => {
        if (claimedRevision) {
          await transaction.dailyPracticePlanRevision.updateMany({
            where: { id: claimedRevision.id, generatedAt: null },
            data: {
              generatedAt: new Date(),
              degradedReason: errorCategory(error),
            },
          });
        }
        await transaction.dailyPracticeDay.updateMany({
          where: { id: candidateId, leaseOwnerToken: ownerToken },
          data: {
            status: statusToRestore,
            leaseOwnerToken: null,
            leasedUntil: null,
          },
        });
      });
    } else {
      const profileChanged = error instanceof DailyGenerationProfileChangedError;
      const stale = error instanceof FrozenCandidateSourceError;
      await prisma.$transaction([
        ...(stale && claimedRevision
          ? [
              prisma.dailyPracticePlanRevision.updateMany({
                where: { id: claimedRevision.id, generatedAt: null },
                data: {
                  generatedAt: new Date(),
                  degradedReason: 'FROZEN_SOURCE_CHANGED',
                },
              }),
            ]
          : []),
        prisma.dailyPracticeDay.updateMany({
          where: { id: candidateId, leaseOwnerToken: ownerToken },
          data: {
            status: profileChanged
              ? DailyPracticeDayStatus.PENDING
              : stale
                ? DailyPracticeDayStatus.STALE
                : DailyPracticeDayStatus.FAILED,
            lastErrorCategory: errorCategory(error),
            lastErrorMessage: safeAiErrorMessage(error).slice(0, 500),
            leaseOwnerToken: null,
            leasedUntil: null,
          },
        }),
      ]);
    }
    return true;
  } finally {
    clearInterval(heartbeat);
    activeDays.delete(candidateId);
  }
  return true;
}

export async function lockAndAssertProfileRevision(
  transaction: Pick<Prisma.TransactionClient, '$queryRaw'>,
  userId: string,
  expectedRevision: number,
) {
  const rows = await transaction.$queryRaw<
    Array<{
      stateRevision: number;
      initializationStatus: UserPracticeInitializationStatus;
    }>
  >(Prisma.sql`
    SELECT stateRevision, initializationStatus
    FROM UserPracticeProfile
    WHERE userId = ${userId}
    FOR UPDATE
  `);
  const profile = rows[0];
  if (
    !profile ||
    profile.initializationStatus !== UserPracticeInitializationStatus.READY ||
    profile.stateRevision !== expectedRevision
  ) {
    throw new DailyGenerationProfileChangedError();
  }
}

export async function releaseActiveDailyPracticeGeneration(prisma: PrismaClient) {
  for (const [dayId, active] of [...activeDays]) {
    active.controller.abort(new DOMException('Worker 正在关闭', 'AbortError'));
    await prisma.dailyPracticeDay.updateMany({
      where: { id: dayId, leaseOwnerToken: active.ownerToken },
      data: {
        status: active.preservedStatus ?? DailyPracticeDayStatus.PENDING,
        leaseOwnerToken: null,
        leasedUntil: null,
      },
    });
    activeDays.delete(dayId);
  }
}

export async function finalizeDeadlineBlockedDay(
  prisma: PrismaClient,
  now: Date,
  allowedUserIds?: string[] | null,
) {
  const candidate = await prisma.dailyPracticeDay.findFirst({
    where: {
      ...(allowedUserIds ? { userId: { in: allowedUserIds } } : {}),
      status: {
        in: [DailyPracticeDayStatus.PENDING, DailyPracticeDayStatus.PROCESSING],
      },
      deadlineAt: { lte: now },
      AND: [
        { OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }] },
        {
          OR: [
            { user: { status: { not: AccountStatus.ACTIVE } } },
            { user: { practiceProfile: { is: null } } },
            {
              user: {
                practiceProfile: {
                  is: {
                    initializationStatus: {
                      not: UserPracticeInitializationStatus.READY,
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    },
    orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  if (!candidate) return false;
  const updated = await prisma.dailyPracticeDay.updateMany({
    where: {
      id: candidate.id,
      status: {
        in: [DailyPracticeDayStatus.PENDING, DailyPracticeDayStatus.PROCESSING],
      },
      deadlineAt: { lte: now },
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
    },
    data: {
      status: DailyPracticeDayStatus.FAILED,
      lastErrorCategory: 'PROFILE_NOT_READY_AT_DEADLINE',
      lastErrorMessage: '学习记录未能在今日生成截止时间前完成初始化',
      leaseOwnerToken: null,
      leasedUntil: null,
    },
  });
  return updated.count === 1;
}

async function findPreviewCandidate(prisma: PrismaClient, now: Date, allowedUserIds?: string[] | null) {
  const revision = await prisma.dailyPracticePlanRevision.findFirst({
    where: {
      trigger: DailyPracticePlanTrigger.ADMIN_PREVIEW,
      generatedAt: null,
      day: {
        ...(allowedUserIds ? { userId: { in: allowedUserIds } } : {}),
        user: { status: AccountStatus.ACTIVE },
        OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
      },
    },
    orderBy: { createdAt: 'asc' },
    select: { dayId: true },
  });
  return revision?.dayId ?? null;
}

async function findNextPendingRevision(prisma: PrismaClient, dayId: string) {
  return prisma.dailyPracticePlanRevision.findFirst({
    where: { dayId, generatedAt: null },
    orderBy: { revision: 'asc' },
    select: { id: true, trigger: true },
  });
}

async function loadDay(prisma: PrismaClient, id: string): Promise<LoadedDay | null> {
  return prisma.dailyPracticeDay.findUnique({
    where: { id },
    include: {
      cycle: true,
      user: {
        select: {
          status: true,
          practiceProfile: {
            select: {
              stateRevision: true,
              initializationStatus: true,
              attemptCount: true,
              questionCount: true,
              correctCount: true,
              wrongCount: true,
            },
          },
        },
      },
      revisions: {
        where: { generatedAt: null },
        orderBy: { revision: 'asc' },
        select: {
          id: true,
          revision: true,
          trigger: true,
          inputHash: true,
          generatedAt: true,
          createdById: true,
        },
      },
    },
  }) as Promise<LoadedDay | null>;
}

async function selectOrCreateRevision(
  prisma: PrismaClient,
  day: LoadedDay,
  ownerToken: string,
) {
  const pending = nextPendingPlanRevision(day.revisions);
  if (pending) return pending;
  return prisma.$transaction(async (transaction) => {
    const fenced = await transaction.dailyPracticeDay.findFirst({
      where: { id: day.id, leaseOwnerToken: ownerToken },
      select: { id: true },
    });
    if (!fenced) throw new DailyGenerationLeaseLostError();
    const latest = await transaction.dailyPracticePlanRevision.findFirst({
      where: { dayId: day.id },
      orderBy: { revision: 'desc' },
      select: { revision: true },
    });
    return transaction.dailyPracticePlanRevision.create({
      data: {
        dayId: day.id,
        revision: (latest?.revision ?? 0) + 1,
        trigger: DailyPracticePlanTrigger.AUTO,
        promptVersion: DAILY_PERSONALIZATION_PROMPT_VERSION,
        generationSource: DailyPracticeGenerationSource.NO_MODEL,
      },
      select: {
        id: true,
        revision: true,
        trigger: true,
        inputHash: true,
        generatedAt: true,
        createdById: true,
      },
    });
  });
}

export function nextPendingPlanRevision<
  T extends { revision: number; id: string },
>(revisions: readonly T[]) {
  return [...revisions].sort(
    (left, right) =>
      left.revision - right.revision || compareAscii(left.id, right.id),
  )[0];
}

async function loadOrFreezeGeneration(
  prisma: PrismaClient,
  day: LoadedDay,
  revision: LoadedDay['revisions'][number],
  ownerToken: string,
): Promise<FrozenDailyGeneration> {
  const existing = readFrozenGeneration(day.candidateSnapshot, revision.id);
  if (existing && revision.inputHash === existing.inputHash) return existing;
  if (revision.inputHash !== null) {
    throw new DailyGenerationValidationError('FROZEN_REVISION_SNAPSHOT_MISSING');
  }
  const profile = day.user.practiceProfile;
  if (
    day.user.status !== AccountStatus.ACTIVE ||
    !profile ||
    profile.initializationStatus !== UserPracticeInitializationStatus.READY
  ) {
    throw new DailyGenerationValidationError('PROFILE_NOT_READY');
  }
  const practiceDate = practiceDateFromDbDate(day.practiceDate);
  const progress = readProgressSnapshot(day.cycle.progressSnapshot);
  if (sha256(stableJson(progress)) !== day.progressSetHash) {
    throw new DailyGenerationValidationError('PROGRESS_SNAPSHOT_HASH_MISMATCH');
  }
  const courses = await loadPracticeCourses(prisma);
  if (sha256(stableJson(projectCurriculumProgress(courses, practiceDate))) !== day.progressSetHash) {
    await prisma.dailyPracticeCycle.update({ where: { id: day.cycle.id }, data: { refreezeRequestedAt: new Date() } });
    throw new DailyGenerationValidationError('CURRICULUM_SNAPSHOT_CHANGED');
  }
  const fixedQuestions = await filterCurrentFixedQuestions(prisma, readFixedQuestions(day.fixedQuestionSnapshot), practiceDate);
  const fixedIds = new Set(fixedQuestions.map((question) => question.questionId));
  const fixedIncludesShortAnswer = fixedQuestions.some((question) => question.gradingType === 'SHORT_ANSWER');
  const progressKeys = new Set(progress.map((topic) => sourceKey(topic.courseId, topic.topicId)));
  const allEligible = await loadEligiblePracticeQuestions(prisma, practiceDate, { courses, cutoffAt: day.cycle.candidateCutoffAt });
  const eligible = allEligible.filter((question) => {
    const mapping = question.curriculumMapping!;
    return !fixedIds.has(question.id) && !(fixedIncludesShortAnswer && question.type === 'SHORT_ANSWER') && Array.isArray(mapping.topicIds) &&
      mapping.topicIds.every((topicId) => typeof topicId === 'string' && progressKeys.has(sourceKey(mapping.courseId, topicId)));
  });
  const suggestionRows = await prisma.dailyPracticeSuggestion.findMany({
    where: { targetUserId: day.userId, targetPracticeDate: day.practiceDate, status: DailyPracticeSuggestionStatus.PENDING },
    include: { submittedBy: { select: { role: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const subjectIds = uniqueStrings(courses.map((course) => course.subjectId));
  const [questionStates, allChapterStates, recentAttempts] = await Promise.all([
    prisma.userQuestionState.findMany({
      where: { userId: day.userId, question: { subjectId: { in: subjectIds } } },
    }),
    prisma.userChapterState.findMany({
      where: { userId: day.userId, subjectChapter: { subjectId: { in: subjectIds } } },
      orderBy: { subjectChapterId: 'asc' },
    }),
    prisma.quizAttempt.findMany({
      where: {
        userId: day.userId,
        submittedAt: { not: null, gte: new Date(day.cycle.baselineAt.getTime() - 30 * 86_400_000), lt: day.cycle.baselineAt },
      },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      select: { score: true, total: true, results: true, snapshot: true, submittedAt: true },
    }),
  ]);
  const recentProfile = summarizeRecentAttempts(scopeRecentAttempts(recentAttempts, new Set(subjectIds)));
  const stateByQuestion = new Map(questionStates.map((state) => [state.questionId, state]));
  const stateByChapter = new Map(allChapterStates.map((state) => [state.subjectChapterId, state]));
  const progressByKey = new Map(progress.map((topic) => [sourceKey(topic.courseId, topic.topicId), topic]));
  const activeWrongQuestionIds = new Set<string>();
  const buckets = new Map<string, CurriculumScoredCandidate['bucket']>();
  const scored = prepareCandidates(eligible.map((question) => {
    const state = stateByQuestion.get(question.id);
    const chapters = question.chapters.flatMap(({ chapterId }) => stateByChapter.has(chapterId) ? [stateByChapter.get(chapterId)!] : []);
    const mapping = question.curriculumMapping!;
    const topicDates = (mapping.topicIds as string[]).map((topicId) => progressByKey.get(sourceKey(mapping.courseId, topicId))!.availableOn);
    const recentlyTaught = topicDates.some((date) => practiceDateDifference(practiceDate, date) < 7);
    const activeWrong = Boolean(state && state.lastWrongAt && !(state.lastPracticedAt && state.lastPracticedAt > state.lastWrongAt && state.correctStreak > 0 && state.masteryBps >= 8_000));
    const due = Boolean(state?.nextReviewAt && state.nextReviewAt <= day.cycle.baselineAt);
    if (activeWrong) activeWrongQuestionIds.add(question.id);
    buckets.set(question.id, recentlyTaught ? 'RECENT' : due || activeWrong ? 'REVIEW' : 'COVERAGE');
    const lastSeen = Math.max(state?.lastAssignedAt?.getTime() ?? 0, state?.lastPracticedAt?.getTime() ?? 0);
    return {
      questionId: question.id,
      gradingType: question.type,
      reviewUrgency: due ? 40 : 0,
      errorRisk: Math.min(30, activeWrong ? (state?.wrongCount ?? 0) * 10 : 0),
      masteryBps: state?.masteryBps ?? (chapters.length ? Math.round(chapters.reduce((sum, chapter) => sum + chapter.masteryBps, 0) / chapters.length) : null),
      coverageDebt: state?.attemptCount ? 0 : 10,
      seenWithin24Hours: lastSeen > day.cycle.baselineAt.getTime() - 86_400_000,
      suggestionMatch: suggestionMatch(question.subjectId, question.chapters, suggestionRows),
      mandatoryEligible: activeWrong || due,
    };
  }), practiceDate, day.userId);
  const eligibleById = new Map(eligible.map((question) => [question.id, question]));
  const curriculumScored: CurriculumScoredCandidate[] = scored.candidates.map((candidate) => ({
    ...candidate,
    courseId: eligibleById.get(candidate.questionId)!.curriculumMapping!.courseId,
    bucket: buckets.get(candidate.questionId)!,
  }));
  const courseWeights = new Map(courses.map((course) => [
    course.id,
    practiceDateDifference(course.examDate, practiceDate) <= 14 ? 2 : 1,
  ]));
  const chapterIds = uniqueStrings([
    ...eligible.flatMap((question) => question.chapters.map((chapter) => chapter.chapterId)),
    ...fixedQuestions.flatMap((question) => question.chapterIds),
  ]).sort(compareAscii);
  const chapterAlias = new Map(chapterIds.map((id, index) => [id, alias('C', index)]));
  const suggestions = projectSuggestions(suggestionRows, day.userId, eligible, chapterAlias);
  const preferred = suggestions.payload.adminSuggestion ?? suggestions.payload.userSuggestion;
  const desired = preferred?.desiredQuestionCount ?? 7;
  const balanced = selectCurriculumQuestions(curriculumScored, Math.min(desired, scored.questionCount.maximum), courseWeights);
  const pool = shortlistCurriculumCandidates(curriculumScored, balanced, 50);
  const ordered = pool.map((candidate) => ({ candidate, question: eligibleById.get(candidate.questionId)! }));
  const courseIds = uniqueStrings(ordered.map(({ candidate }) => candidate.courseId)).sort(compareAscii);
  const courseAlias = new Map(courseIds.map((id, index) => [id, 'P' + String(index + 1).padStart(3, '0')]));
  const sourceNodes = uniqueBy(ordered.flatMap(({ question }) =>
    (question.curriculumMapping!.topicIds as string[]).map((id) => progressByKey.get(sourceKey(question.curriculumMapping!.courseId, id))!),
  ), (topic) => sourceKey(topic.courseId, topic.topicId));
  const knowledgeAlias = new Map(sourceNodes.map((topic, index) => [sourceKey(topic.courseId, topic.topicId), alias('K', index)]));
  const questionAlias = new Map(ordered.map(({ question }, index) => [question.id, alias('Q', index)]));
  const selectedChapterIds = new Set(ordered.flatMap(({ question }) => question.chapters.map(({ chapterId }) => chapterId)));
  const chapterStates = allChapterStates.filter((state) => selectedChapterIds.has(state.subjectChapterId));
  const topicStates = new Map(sourceNodes.map((topic) => {
    const states = eligible.filter((question) => question.curriculumMapping!.courseId === topic.courseId && (question.curriculumMapping!.topicIds as string[]).includes(topic.topicId))
      .flatMap((question) => stateByQuestion.has(question.id) && stateByQuestion.get(question.id)!.attemptCount > 0 ? [stateByQuestion.get(question.id)!] : []);
    return [sourceKey(topic.courseId, topic.topicId), states];
  }));
  const signalAlias = new Map(sourceNodes.map((topic, index) => [sourceKey(topic.courseId, topic.topicId), alias('S', index)]));
  const chapterSignalAlias = new Map(chapterStates.map((state, index) => [state.subjectChapterId, alias('S', sourceNodes.length + index)]));
  const wrongSignalAlias = new Map(ordered.filter(({ question }) => activeWrongQuestionIds.has(question.id))
    .map(({ question }, index) => [question.id, alias('S', sourceNodes.length + chapterStates.length + index)]));
  const previous = await loadPreviousSummary(prisma, day, practiceDate);
  const candidateQuestions = ordered.map(({ candidate, question }) => {
    const state = stateByQuestion.get(question.id);
    const lastSeen = Math.max(state?.lastAssignedAt?.getTime() ?? 0, state?.lastPracticedAt?.getTime() ?? 0);
    return {
      questionAlias: questionAlias.get(question.id)!,
      knowledgeAliases: (question.curriculumMapping!.topicIds as string[]).map((id) => knowledgeAlias.get(sourceKey(candidate.courseId, id))!),
      chapterAliases: question.chapters.map((chapter) => chapterAlias.get(chapter.chapterId)!),
      gradingType: question.type,
      typeLabel: question.typeLabel,
      promptExcerpt: boundText(question.prompt, 300),
      priorityScore: candidate.priorityScore,
      daysSinceLastSeen: lastSeen ? daysBetweenInstants(day.cycle.baselineAt, new Date(lastSeen)) : null,
      courseAlias: courseAlias.get(candidate.courseId)!,
      selectionBucket: candidate.bucket,
    };
  });
  const topicSignals = sourceNodes.map((topic) => {
    const key = sourceKey(topic.courseId, topic.topicId);
    const states = topicStates.get(key)!;
    const attempts = states.reduce((sum, state) => sum + state.attemptCount, 0);
    const lastPracticed = Math.max(0, ...states.map((state) => state.lastPracticedAt?.getTime() ?? 0));
    return {
      signalAlias: signalAlias.get(key)!,
      knowledgeAlias: knowledgeAlias.get(key)!,
      masteryBps: attempts ? Math.round(states.reduce((sum, state) => sum + state.masteryBps * state.attemptCount, 0) / attempts) : 0,
      attemptCount: attempts,
      wrongCount: states.reduce((sum, state) => sum + state.wrongCount, 0),
      correctStreak: states.length ? Math.min(...states.map((state) => state.correctStreak)) : 0,
      lastScoreBps: states.length ? states.reduce((latest, state) => (state.lastPracticedAt?.getTime() ?? 0) > (latest.lastPracticedAt?.getTime() ?? 0) ? state : latest).lastScoreBps : null,
      daysSincePractice: lastPracticed ? daysBetweenInstants(day.cycle.baselineAt, new Date(lastPracticed)) : null,
      reviewDue: states.some((state) => state.nextReviewAt && state.nextReviewAt < day.cycle.baselineAt) ? 'OVERDUE' as const :
        states.some((state) => state.nextReviewAt && state.nextReviewAt <= day.cycle.deadlineAt) ? 'DUE' as const : 'NOT_DUE' as const,
      missingRubricPoints: [],
    };
  });
  const payload = buildDailyPersonalizationPayload({
    practiceDate,
    inputPolicy: {
      knowledgeCount: dynamicKnowledgeCount(sourceNodes.length),
      questionCount: { minimum: balanced.length, maximum: balanced.length },
      courseQuestionCounts: courseIds.map((id) => ({ courseAlias: courseAlias.get(id)!, count: balanced.filter((candidate) => candidate.courseId === id).length })),
      courseBucketQuestionCounts: courseIds.flatMap((id) => (['RECENT', 'REVIEW', 'COVERAGE'] as const).map((bucket) => ({
        courseAlias: courseAlias.get(id)!, bucket,
        count: balanced.filter((candidate) => candidate.courseId === id && candidate.bucket === bucket).length,
      }))),
      mandatoryQuestionAliases: balanced.filter((candidate) => candidate.mandatory).map((candidate) => questionAlias.get(candidate.questionId)!),
      fixedQuestionCount: fixedQuestions.length,
      fixedQuestionAliases: fixedQuestions.map((_question, index) => alias('F', index)),
      allowedKnowledgeAliases: [...knowledgeAlias.values()],
      allowedQuestionAliases: [...questionAlias.values()],
      allowedSignalAliases: [...signalAlias.values(), ...chapterSignalAlias.values(), ...wrongSignalAlias.values()],
    },
    profile: {
      dataQuality: recentProfile.answeredQuestions === 0 ? 'NONE' : recentProfile.submittedAttempts < 5 ? 'LIMITED' : 'SUFFICIENT',
      overall: {
        submittedAttempts30d: recentProfile.submittedAttempts,
        answeredQuestions30d: recentProfile.answeredQuestions,
        accuracyBps30d: recentProfile.accuracyBps,
        activeDays30d: recentProfile.activeDays,
        overdueKnowledgeCount: topicSignals.filter((signal) => signal.reviewDue === 'OVERDUE').length,
        overdueChapterCount: chapterStates.filter((state) => state.nextReviewAt && state.nextReviewAt < day.cycle.baselineAt).length,
      },
      knowledgeSignals: topicSignals,
      chapterSignals: chapterStates.map((state) => ({
        signalAlias: chapterSignalAlias.get(state.subjectChapterId)!,
        chapterAlias: chapterAlias.get(state.subjectChapterId)!,
        masteryBps: state.masteryBps,
        attemptCount: state.attemptCount,
        wrongCount: state.wrongCount,
        lastScoreBps: state.lastScoreBps,
        daysSincePractice: state.lastPracticedAt ? daysBetweenInstants(day.cycle.baselineAt, state.lastPracticedAt) : null,
        reviewDue: reviewDueAt(state.nextReviewAt, day.cycle.baselineAt, day.cycle.deadlineAt),
      })),
      recentWrongSignals: ordered.filter(({ question }) => activeWrongQuestionIds.has(question.id)).map(({ question }) => {
        const state = stateByQuestion.get(question.id)!;
        return {
          signalAlias: wrongSignalAlias.get(question.id)!,
          questionAlias: questionAlias.get(question.id)!,
          chapterAliases: question.chapters.map(({ chapterId }) => chapterAlias.get(chapterId)!),
          gradingType: question.type,
          wrongCount: state.wrongCount,
          lastScoreBps: state.lastScoreBps,
          daysSinceWrong: daysBetweenInstants(day.cycle.baselineAt, state.lastWrongAt!),
          missingRubricPoints: [],
        };
      }),
    },
    previousLearningSummary: previous.summary,
    candidateKnowledge: sourceNodes.map((topic) => {
      const key = sourceKey(topic.courseId, topic.topicId);
      const related = candidateQuestions.filter((question) => question.knowledgeAliases.includes(knowledgeAlias.get(key)!));
      return {
        knowledgeAlias: knowledgeAlias.get(key)!,
        subjectName: topic.subjectName,
        chapterAliases: uniqueStrings(related.flatMap((question) => question.chapterAliases)),
        title: topic.title,
        breadcrumb: topic.subjectName + ' / ' + topic.title,
        firstTaughtDate: topic.firstTaughtDate,
        reviewPriority: Math.min(100, Math.max(0, 100 - Math.round((topicSignals.find((signal) => signal.knowledgeAlias === knowledgeAlias.get(key))?.masteryBps ?? 0) / 100))),
        eligibleQuestionCount: related.length,
      };
    }),
    candidateQuestions,
    fixedQuestions: fixedQuestions.map((question, index) => ({
      fixedQuestionAlias: alias('F', index),
      chapterAliases: question.chapterIds.map((id) => chapterAlias.get(id)!),
      subjectName: question.subjectName,
      gradingType: question.gradingType,
      typeLabel: question.typeLabel,
      promptExcerpt: question.promptExcerpt,
      adminOrder: index + 1,
    })),
    suggestion: suggestions.payload,
  });
  fitDailyPayloadBudget(payload, balanced.length, dailyMaxInputTokens());
  const serializedPayload = serializeDailyPersonalizationPayload(payload);
  if (estimateTokens(serializedPayload) > dailyMaxInputTokens()) {
    throw new DailyGenerationValidationError('DAILY_INPUT_TOKEN_LIMIT');
  }
  const inputHash = sha256(
    stableJson({
      promptVersion: DAILY_PERSONALIZATION_PROMPT_VERSION,
      systemPromptHash: sha256(DAILY_PERSONALIZATION_SYSTEM_PROMPT),
      payload,
    }),
  );
  const retainedAliases = new Set(payload.inputPolicy.allowedQuestionAliases);
  const frozenCandidateQuestions: FrozenCandidateQuestion[] = ordered.filter(({ question }) => retainedAliases.has(questionAlias.get(question.id)!)).map(
    ({ question }) => ({
    questionId: question.id,
    questionAlias: questionAlias.get(question.id)!,
    questionReviewRevision: question.reviewRevision,
    sourceRevision: question.sourceRevision,
    gradingType: question.type,
    sourceKeys: (question.curriculumMapping!.topicIds as string[]).map((id) => sourceKey(question.curriculumMapping!.courseId, id)),
    questionContentRevision: question.contentRevision,
    mappingRevision: question.curriculumMapping!.revision,
    }),
  );
  const candidateHash = sha256(
    stableJson({
      questions: frozenCandidateQuestions,
      fixedQuestions,
      progressSetHash: day.progressSetHash,
    }),
  );
  const frozen: FrozenDailyGeneration = {
    version: 2,
    eligibleCount: eligible.length,
    scoredCount: scored.candidates.length,
    revisionId: revision.id,
    profileRevision: profile.stateRevision,
    payload,
    candidateQuestions: frozenCandidateQuestions,
    fixedQuestions,
    suggestionIds: suggestions.ids,
    inputHash,
    candidateHash,
    previousSummarySourceRevisionId: previous.revisionId,
    courseVersions: courses.map(({ id, revision: courseRevision, topicHash }) => ({ id, revision: courseRevision, topicHash })),
  };
  await prisma.$transaction(async (transaction) => {
    await lockAndAssertProfileRevision(
      transaction,
      day.userId,
      profile.stateRevision,
    );
    const currentDay = await transaction.dailyPracticeDay.findFirst({
      where: { id: day.id, leaseOwnerToken: ownerToken },
      select: { status: true, progressSetHash: true },
    });
    assertDayFreezeInputsCurrent(currentDay, day.status, day.progressSetHash);
    const updated = await transaction.dailyPracticeDay.updateMany({
      where: { id: day.id, leaseOwnerToken: ownerToken },
      data: {
        profileRevision: profile.stateRevision,
        candidateSnapshot: frozen as unknown as Prisma.InputJsonValue,
        candidateHash,
      },
    });
    if (updated.count !== 1) throw new DailyGenerationLeaseLostError();
    await transaction.dailyPracticePlanRevision.update({
      where: { id: revision.id },
      data: {
        inputHash,
        previousSummarySourceRevisionId: previous.revisionId,
        previousLearningSummarySnapshot:
          previous.summary === null
            ? Prisma.JsonNull
            : (previous.summary as unknown as Prisma.InputJsonValue),
      },
    });
  });
  return frozen;
}

export function fitDailyPayloadBudget(payload: DailyPersonalizationPayload, preservedCount: number, tokenLimit: number) {
  const size = () => estimateTokens(serializeDailyPersonalizationPayload(payload));
  while (size() > tokenLimit && payload.candidateQuestions.length > preservedCount) {
    payload.candidateQuestions.pop();
    const questionAliases = new Set(payload.candidateQuestions.map((question) => question.questionAlias));
    const topicAliases = new Set(payload.candidateQuestions.flatMap((question) => question.knowledgeAliases));
    const chapterAliases = new Set([...payload.candidateQuestions.flatMap((question) => question.chapterAliases), ...payload.fixedQuestions.flatMap((question) => question.chapterAliases)]);
    payload.inputPolicy.allowedQuestionAliases = [...questionAliases];
    payload.candidateKnowledge = payload.candidateKnowledge.filter((topic) => topicAliases.has(topic.knowledgeAlias));
    payload.inputPolicy.allowedKnowledgeAliases = payload.candidateKnowledge.map((topic) => topic.knowledgeAlias);
    payload.inputPolicy.knowledgeCount = dynamicKnowledgeCount(payload.candidateKnowledge.length);
    payload.profile.knowledgeSignals = payload.profile.knowledgeSignals.filter((signal) => topicAliases.has(signal.knowledgeAlias));
    payload.profile.chapterSignals = payload.profile.chapterSignals.filter((signal) => chapterAliases.has(signal.chapterAlias));
    payload.profile.recentWrongSignals = payload.profile.recentWrongSignals.filter((signal) => signal.questionAlias && questionAliases.has(signal.questionAlias));
    payload.inputPolicy.allowedSignalAliases = [...payload.profile.knowledgeSignals, ...payload.profile.chapterSignals, ...payload.profile.recentWrongSignals].map((signal) => signal.signalAlias);
  }
  if (size() > tokenLimit) {
    payload.candidateQuestions.forEach((question) => { question.promptExcerpt = boundText(question.promptExcerpt, 120); });
    payload.fixedQuestions.forEach((question) => { question.promptExcerpt = boundText(question.promptExcerpt, 120); });
  }
}

export function deterministicReason(
  day: LoadedDay,
  revision: Pick<LoadedDay['revisions'][number], 'trigger'>,
  frozen: FrozenDailyGeneration,
  now: Date,
) {
  const automatic = revision.trigger === DailyPracticePlanTrigger.AUTO;
  if (
    automatic &&
    day.cycle.lastErrorCategory === 'CAPACITY_GATE_FAILED'
  ) {
    return 'CAPACITY_GATE_FAILED';
  }
  if (automatic && now >= day.deadlineAt) return 'DAILY_DEADLINE_REACHED';
  if (
    frozen.candidateQuestions.length === 0 &&
    frozen.payload.profile.overall.answeredQuestions30d === 0 &&
    frozen.payload.profile.knowledgeSignals.length === 0 &&
    frozen.payload.profile.chapterSignals.length === 0 &&
    frozen.payload.profile.recentWrongSignals.length === 0 &&
    frozen.payload.previousLearningSummary === null
  ) {
    return 'NO_OBSERVABLE_LEARNING_SIGNALS';
  }
  return null;
}

function buildDailyRequest(
  payload: DailyPersonalizationPayload,
  strategy: AiTaskStrategy,
  signal: AbortSignal,
): AiRequest {
  return {
    taskType: 'DAILY_PLAN',
    strategy,
    promptVersion: DAILY_PERSONALIZATION_PROMPT_VERSION,
    messages: [
      { role: 'system', content: DAILY_PERSONALIZATION_SYSTEM_PROMPT },
      { role: 'user', content: serializeDailyPersonalizationPayload(payload) },
    ],
    maxOutputTokens: dailyMaxOutputTokens(),
    timeoutMs: dailyTimeoutMs(),
    responseFormat: { type: 'json_object' },
    temperature: 0.1,
    signal,
  };
}

export function shouldCorrectDailyMaxResponse(
  strategy: AiTaskStrategy,
  responseAttempt: number,
  error: unknown,
) {
  return (
    strategy === AiTaskStrategy.PRO_MAX &&
    responseAttempt === 0 &&
    ((error instanceof AiClientError && error.category === 'INVALID_RESPONSE') ||
      error instanceof DailyPersonalizationValidationError)
  );
}

export function buildDailyCorrectionRequest(
  originalRequest: AiRequest,
  unusableContent: string | null,
  error: unknown,
): AiRequest {
  const messages = [...originalRequest.messages];
  if (unusableContent) {
    messages.push({ role: 'assistant', content: unusableContent });
  }
  messages.push({
    role: 'user',
    content: [
      '上一次回复未通过服务端校验。请重新执行最初的任务，并返回一个完整、严格符合原始结构要求的 JSON 对象。',
      `错误类别：${errorCategory(error)}`,
      `错误信息：${dailyCorrectionErrorDetails(error)}`,
      unusableContent
        ? '上一次不可用回复已作为前一条 assistant 消息提供，请修正其中的问题。'
        : '上一次回复为空或无法解析，因此没有可回传的回复正文；请缩短内部推理，并确保在输出上限内返回完整 JSON。',
      '不要解释错误，不要使用 Markdown 代码块，只返回修正后的 JSON 对象。',
    ].join('\n'),
  });
  return { ...originalRequest, messages };
}

function dailyCorrectionErrorDetails(error: unknown) {
  const details = [safeAiErrorMessage(error)];
  if (error instanceof DailyPersonalizationValidationError) {
    details.push(
      ...error.schemaErrors.slice(0, 8).map((item) =>
        [item.instancePath || '/', item.keyword, item.message]
          .filter(Boolean)
          .join(' '),
      ),
    );
  }
  return details.join('; ').slice(0, 2_000);
}

function dailyInvocationIdempotencyKey(
  dayId: string,
  revisionId: string,
  strategy: AiTaskStrategy,
  responseAttempt: number,
) {
  const base = `daily-plan:${dayId}:${revisionId}:${strategy}`;
  return responseAttempt === 0
    ? base
    : `${base}:correction:${responseAttempt}`;
}

export function assertDayFreezeInputsCurrent(
  current: {
    status: DailyPracticeDayStatus;
    progressSetHash: string;
  } | null,
  expectedStatus: DailyPracticeDayStatus,
  expectedProgressSetHash: string,
) {
  if (
    !current ||
    current.status !== expectedStatus ||
    current.progressSetHash !== expectedProgressSetHash
  ) {
    throw new FrozenCandidateSourceError();
  }
}

export function assertCandidateSnapshotCurrent(
  frozenCandidateHash: string | null | undefined,
  dayCandidateHash: string | null,
) {
  if (frozenCandidateHash !== dayCandidateHash) {
    throw new FrozenCandidateSourceError();
  }
}

export function buildFixedDailyPlanItems(
  revisionId: string,
  firstOrdinal: number,
  questions: FrozenFixedQuestion[],
): Prisma.DailyPracticePlanItemCreateManyInput[] {
  return questions.map((question, index) => ({
    revisionId,
    ordinal: firstOrdinal + index,
    source: DailyPracticePlanItemSource.ADMIN_FIXED,
    questionId: question.questionId,
    questionReviewRevision: question.questionReviewRevision,
    questionContentRevision: question.questionContentRevision,
    sourceRevision: question.sourceRevision,
    reason: '管理员指定',
    evidenceRefs: [],
  }));
}

async function publishPlan(
  prisma: PrismaClient,
  day: LoadedDay,
  revision: LoadedDay['revisions'][number],
  frozen: FrozenDailyGeneration,
  output: DailyPersonalizationOutput,
  generationSource: DailyPracticeGenerationSource,
  degradedReason: string | null,
  ownerToken: string,
  preservedStatus: DailyPracticeDayStatus | null,
) {
  const gate = await loadDailyPracticeServiceGate(prisma, new Date(), day.userId);
  if (!gate.open) {
    await pauseDay(prisma, day.id, ownerToken, preservedStatus);
    return;
  }
  await assertFrozenCandidateSources(prisma, frozen);
  const candidateByAlias = new Map(
    frozen.candidateQuestions.map((question) => [question.questionAlias, question]),
  );
  const personalized = output.selectedQuestions.map((selected) => ({
    selected,
    question: candidateByAlias.get(selected.questionAlias)!,
  }));
  const preview = revision.trigger === DailyPracticePlanTrigger.ADMIN_PREVIEW;
  const readyStatus = planStatus(
    personalized.length,
    frozen.fixedQuestions.length,
    generationSource,
  );
  const generatedAt = new Date();
  await prisma.$transaction(async (transaction) => {
    await lockDailyPracticeSettings(transaction);
    const insideGate = await loadDailyPracticeServiceGate(transaction, generatedAt, day.userId);
    if (!insideGate.open) throw new DailyServicePausedError();
    const lockedDays = await transaction.$queryRaw<
      Array<{
        id: string;
        status: DailyPracticeDayStatus;
        startedAt: Date | null;
        completedAt: Date | null;
        activeRevisionId: string | null;
        candidateHash: string | null;
      }>
    >(Prisma.sql`
      SELECT id, status, startedAt, completedAt, activeRevisionId, candidateHash
      FROM DailyPracticeDay
      WHERE id = ${day.id} AND leaseOwnerToken = ${ownerToken}
      FOR UPDATE
    `);
    const fenced = lockedDays[0];
    if (!fenced) throw new DailyGenerationLeaseLostError();
    assertCandidateSnapshotCurrent(frozen.candidateHash, fenced.candidateHash);
    const [activeRevision, latestPublishableRevision] = await Promise.all([
      fenced.activeRevisionId
        ? transaction.dailyPracticePlanRevision.findUnique({
            where: { id: fenced.activeRevisionId },
            select: { revision: true },
          })
        : null,
      transaction.dailyPracticePlanRevision.findFirst({
        where: {
          dayId: day.id,
          trigger: { not: DailyPracticePlanTrigger.ADMIN_PREVIEW },
        },
        orderBy: { revision: 'desc' },
        select: { revision: true },
      }),
    ]);
    const publishAllowed = canPublishPlanRevision({
      trigger: revision.trigger,
      revision: revision.revision,
      activeRevision: activeRevision?.revision ?? null,
      latestPublishableRevision:
        latestPublishableRevision?.revision ?? null,
      dayStatus: fenced.status,
      started: Boolean(fenced.startedAt),
      completed: Boolean(fenced.completedAt),
    });
    await transaction.dailyPracticePlanItem.createMany({
      data: [
        ...personalized.map(({ selected, question }, index) => ({
          revisionId: revision.id,
          ordinal: index + 1,
          source: DailyPracticePlanItemSource.PERSONALIZED,
          questionId: question.questionId,
          questionReviewRevision: question.questionReviewRevision,
          questionContentRevision: question.questionContentRevision,
          sourceRevision: question.sourceRevision,
          reason: boundText(selected.reason, 500),
          evidenceRefs: selected.evidenceRefs as Prisma.InputJsonValue,
        })),
        ...buildFixedDailyPlanItems(revision.id, personalized.length + 1, frozen.fixedQuestions),
      ],
      skipDuplicates: true,
    });
    if (publishAllowed) {
      for (const questionId of [...personalized.map(({ question }) => question.questionId), ...frozen.fixedQuestions.map((question) => question.questionId)]) {
        await transaction.userQuestionState.upsert({
          where: { userId_questionId: { userId: day.userId, questionId } },
          create: { userId: day.userId, questionId, lastAssignedAt: generatedAt },
          update: { lastAssignedAt: generatedAt },
        });
      }
    }
    await transaction.dailyPracticePlanRevision.update({
      where: { id: revision.id },
      data: {
        generationSource,
        outputHash: sha256(stableJson(output)),
        validatedOutput: output as unknown as Prisma.InputJsonValue,
        summarySnapshot: output.learningSummary as unknown as Prisma.InputJsonValue,
        suggestionEvaluation:
          output.suggestionEvaluation as unknown as Prisma.InputJsonValue,
        degradedReason,
        generatedAt,
        publishedAt: publishAllowed ? generatedAt : null,
      },
    });
    if (publishAllowed) {
      const updated = await transaction.dailyPracticeDay.updateMany({
        where: { id: day.id, leaseOwnerToken: ownerToken },
        data: {
          activeRevisionId: revision.id,
          status: readyStatus,
          leaseOwnerToken: null,
          leasedUntil: null,
        },
      });
      if (updated.count !== 1) throw new DailyGenerationLeaseLostError();
    } else {
      const updated = await transaction.dailyPracticeDay.updateMany({
        where: { id: day.id, leaseOwnerToken: ownerToken },
        data: {
          ...(preview && preservedStatus !== null
            ? { status: preservedStatus }
            : !preview &&
                fenced.status === DailyPracticeDayStatus.PROCESSING
              ? { status: DailyPracticeDayStatus.PENDING }
              : {}),
          leaseOwnerToken: null,
          leasedUntil: null,
        },
      });
      if (updated.count !== 1) throw new DailyGenerationLeaseLostError();
    }
    if (publishAllowed && frozen.suggestionIds.length) {
      await transaction.dailyPracticeSuggestion.updateMany({
        where: { id: { in: frozen.suggestionIds }, status: DailyPracticeSuggestionStatus.PENDING },
        data: {
          status: suggestionStatus(output.suggestionEvaluation.status),
          appliedRevisionId: revision.id,
        },
      });
    }
  });
}

export function canPublishPlanRevision(input: {
  trigger: DailyPracticePlanTrigger;
  revision: number;
  activeRevision: number | null;
  latestPublishableRevision?: number | null;
  dayStatus: DailyPracticeDayStatus;
  started: boolean;
  completed: boolean;
}) {
  return (
    input.trigger !== DailyPracticePlanTrigger.ADMIN_PREVIEW &&
    !input.started &&
    !input.completed &&
    input.dayStatus !== DailyPracticeDayStatus.STARTED &&
    input.dayStatus !== DailyPracticeDayStatus.COMPLETED &&
    (input.activeRevision === null || input.activeRevision <= input.revision) &&
    (input.latestPublishableRevision === null ||
      input.latestPublishableRevision === undefined ||
      input.latestPublishableRevision <= input.revision)
  );
}

async function assertFrozenCandidateSources(
  prisma: PrismaClient,
  frozen: FrozenDailyGeneration,
) {
  const practiceDate = frozen.payload.practiceDate;
  const courses = await loadPracticeCourses(prisma);
  if (frozen.courseVersions.some((version) => !courses.some((course) => course.id === version.id && course.revision === version.revision && course.topicHash === version.topicHash))) {
    throw new FrozenCandidateSourceError();
  }
  const items = [...frozen.candidateQuestions, ...frozen.fixedQuestions];
  if (items.length && !await assertDailyQuestionEligibility(prisma, practiceDate, items)) {
    throw new FrozenCandidateSourceError();
  }
  if (frozen.candidateQuestions.length) {
    const rows = await loadEligiblePracticeQuestions(prisma, practiceDate, {
      questionIds: frozen.candidateQuestions.map((question) => question.questionId),
    });
    const current = new Map(rows.map((question) => [question.id, question]));
    for (const question of frozen.candidateQuestions) {
      const mapping = current.get(question.questionId)?.curriculumMapping;
      if (!mapping || mapping.revision !== question.mappingRevision ||
        stableJson((mapping.topicIds as string[]).map((id) => sourceKey(mapping.courseId, id))) !== stableJson(question.sourceKeys)) {
        throw new FrozenCandidateSourceError();
      }
    }
  }
}

async function loadPreviousSummary(
  prisma: PrismaClient,
  day: LoadedDay,
  targetPracticeDate: string,
) {
  const attempt = await prisma.quizAttempt.findFirst({
    where: {
      userId: day.userId,
      submittedAt: { not: null, lt: day.cycle.baselineAt },
    },
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    select: { submittedAt: true },
  });
  if (!attempt?.submittedAt) return { summary: null, revisionId: null };
  const activePracticeDate = practiceDateForInstant(attempt.submittedAt);
  const priorDay = await prisma.dailyPracticeDay.findUnique({
    where: {
      userId_practiceDate: {
        userId: day.userId,
        practiceDate: practiceDateToDbDate(activePracticeDate),
      },
    },
    include: { activeRevision: true },
  });
  const active = priorDay?.activeRevision;
  if (!active) return { summary: null, revisionId: null };
  const summary = projectNearestActiveLearningSummary(
    targetPracticeDate,
    activePracticeDate,
    active
      ? {
      practiceDate: activePracticeDate,
      generationSource: active.generationSource,
      trigger: active.trigger,
      published: Boolean(active.publishedAt),
      validated: Boolean(active.validatedOutput),
      learningSummary: active.summarySnapshot,
        }
      : null,
  );
  return {
    summary,
    revisionId: summary ? active.id : null,
  };
}

export function projectNearestActiveLearningSummary(
  targetPracticeDate: string,
  mostRecentActivePracticeDate: string | null,
  candidate: {
    practiceDate: string;
    generationSource: string;
    trigger: string;
    published: boolean;
    validated: boolean;
    learningSummary: unknown;
  } | null,
) {
  return projectPreviousLearningSummary(
    targetPracticeDate,
    mostRecentActivePracticeDate,
    candidate,
  );
}

export function projectSuggestions(
  rows: Array<{
    id: string;
    submittedById: string;
    userQuotaKey: string | null;
    payload: Prisma.JsonValue;
    submittedBy: { role: Role };
  }>,
  userId: string,
  questions: Array<{
    subjectId: string;
    subject: { name: string };
  }>,
  chapterAlias: Map<string, string>,
) {
  const user = rows.find(
    (row) => row.userQuotaKey !== null && row.submittedById === userId,
  );
  const admin = rows.find(
    (row) => row.userQuotaKey === null && row.submittedBy.role === Role.ADMIN,
  );
  const project = (row: typeof user) => {
    if (!row || !isRecord(row.payload)) return null;
    const desiredQuestionCount = boundedInteger(row.payload.desiredQuestionCount, 5, 10, 5);
    const intensity = ['LIGHT', 'STANDARD', 'CHALLENGING'].includes(
      String(row.payload.intensity),
    )
      ? (String(row.payload.intensity) as 'LIGHT' | 'STANDARD' | 'CHALLENGING')
      : 'STANDARD';
    const focusSubjects = stringArray(row.payload.focusSubjectIds, 2);
    const focusChapters = stringArray(row.payload.focusChapterIds, 5);
    return {
      intensity,
      desiredQuestionCount,
      focusSubjectNames: uniqueStrings(
        questions
          .filter((question) => focusSubjects.includes(question.subjectId))
          .map((question) => question.subject.name),
      ),
      focusChapterAliases: focusChapters.flatMap((id) => {
        const value = chapterAlias.get(id);
        return value ? [value] : [];
      }),
      note: typeof row.payload.note === 'string' ? boundText(row.payload.note, 300) : '',
    };
  };
  return {
    payload: { userSuggestion: project(user), adminSuggestion: project(admin) },
    ids: uniqueStrings([user?.id, admin?.id].filter((id): id is string => Boolean(id))),
  };
}

export function selectDailyCandidatePool(
  prepared: ReturnType<typeof prepareCandidates>,
  maximumCount = 50,
) {
  if (!Number.isSafeInteger(maximumCount) || maximumCount < 0) {
    throw new RangeError('maximumCount must be a non-negative safe integer');
  }
  const byId = new Map(
    prepared.candidates.map((candidate) => [candidate.questionId, candidate]),
  );
  const candidates: typeof prepared.candidates = [];
  const selectedIds = new Set<string>();
  let shortAnswerCount = 0;
  const append = (questionId: string) => {
    if (candidates.length >= maximumCount || selectedIds.has(questionId)) return;
    const candidate = byId.get(questionId);
    if (!candidate) return;
    if (candidate.gradingType === 'SHORT_ANSWER') {
      if (shortAnswerCount >= 1) return;
      shortAnswerCount += 1;
    }
    candidates.push(candidate);
    selectedIds.add(questionId);
  };
  prepared.mandatoryQuestionIds.forEach(append);
  prepared.candidates.forEach((candidate) => append(candidate.questionId));
  return {
    candidates,
    questionCount: dynamicQuestionCount(candidates.length),
  };
}

function suggestionMatch(
  subjectId: string,
  chapters: Array<{ chapterId: string }>,
  rows: Array<{ payload: Prisma.JsonValue }>,
) {
  for (const row of rows) {
    if (!isRecord(row.payload)) continue;
    const subjects = stringArray(row.payload.focusSubjectIds, 2);
    const chapterIds = stringArray(row.payload.focusChapterIds, 5);
    if (
      subjects.includes(subjectId) ||
      chapters.some((chapter) => chapterIds.includes(chapter.chapterId))
    ) {
      return 10;
    }
  }
  return 0;
}

export function readFrozenGeneration(
  value: Prisma.JsonValue | null,
  revisionId: string,
): FrozenDailyGeneration | null {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.revisionId !== revisionId ||
    typeof value.inputHash !== 'string'
  ) {
    return null;
  }
  return value as unknown as FrozenDailyGeneration;
}

function readProgressSnapshot(value: Prisma.JsonValue): FrozenProgressNode[] {
  if (!Array.isArray(value)) throw new DailyGenerationValidationError('INVALID_PROGRESS_SNAPSHOT');
  return value as unknown as FrozenProgressNode[];
}

function readFixedQuestions(value: Prisma.JsonValue | null): FrozenFixedQuestion[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new DailyGenerationValidationError('INVALID_FIXED_SNAPSHOT');
  return value as unknown as FrozenFixedQuestion[];
}

export async function beginStrategyAttempt(
  prisma: PrismaClient,
  dayId: string,
  planRevisionId: string,
  strategy: AiTaskStrategy,
) {
  const existing = await prisma.dailyPracticeStrategyAttempt.findUnique({
    where: {
      dayId_planRevisionId_strategy: { dayId, planRevisionId, strategy },
    },
  });
  if (existing) {
    if (existing.status === DailyPracticeStrategyAttemptStatus.RUNNING) {
      await prisma.dailyPracticeStrategyAttempt.updateMany({
        where: { id: existing.id, status: DailyPracticeStrategyAttemptStatus.RUNNING },
        data: {
          status: DailyPracticeStrategyAttemptStatus.EXPIRED,
          errorCategory: 'LEASE_EXPIRED',
          completedAt: new Date(),
        },
      });
    }
    return null;
  }
  return prisma.dailyPracticeStrategyAttempt.create({
    data: {
      dayId,
      planRevisionId,
      strategy,
      status: DailyPracticeStrategyAttemptStatus.RUNNING,
      startedAt: new Date(),
    },
  });
}

async function failStrategyAttempt(
  prisma: PrismaClient,
  id: string,
  error: unknown,
) {
  await prisma.dailyPracticeStrategyAttempt.updateMany({
    where: { id, status: DailyPracticeStrategyAttemptStatus.RUNNING },
    data: {
      status: DailyPracticeStrategyAttemptStatus.FAILED,
      errorCategory: errorCategory(error),
      errorMessage: safeAiErrorMessage(error).slice(0, 500),
      completedAt: new Date(),
    },
  });
}

async function completeStrategyAttempt(prisma: PrismaClient, id: string) {
  await prisma.dailyPracticeStrategyAttempt.updateMany({
    where: { id, status: DailyPracticeStrategyAttemptStatus.RUNNING },
    data: {
      status: DailyPracticeStrategyAttemptStatus.SUCCEEDED,
      completedAt: new Date(),
    },
  });
}

async function heartbeatDay(
  prisma: PrismaClient,
  dayId: string,
  ownerToken: string,
  controller: AbortController,
) {
  const gate = await loadDailyPracticeDayGate(prisma, dayId);
  if (!gate.open) {
    controller.abort(new DOMException('每日一练服务已暂停', 'AbortError'));
    return;
  }
  const updated = await prisma.dailyPracticeDay.updateMany({
    where: { id: dayId, leaseOwnerToken: ownerToken },
    data: { leasedUntil: new Date(Date.now() + dailyLeaseMs()) },
  });
  if (updated.count !== 1) {
    controller.abort(new DOMException('每日计划租约已失效', 'AbortError'));
  }
}

async function assertServiceAndLease(
  prisma: PrismaClient,
  dayId: string,
  ownerToken: string,
) {
  const [gate, day] = await Promise.all([
    loadDailyPracticeDayGate(prisma, dayId),
    prisma.dailyPracticeDay.findFirst({
      where: { id: dayId, leaseOwnerToken: ownerToken },
      select: { id: true },
    }),
  ]);
  return gate.open && Boolean(day);
}

async function pauseDay(
  prisma: PrismaClient,
  dayId: string,
  ownerToken: string,
  preservedStatus: DailyPracticeDayStatus | null,
) {
  await prisma.dailyPracticeDay.updateMany({
    where: { id: dayId, leaseOwnerToken: ownerToken },
    data: {
      status: preservedStatus ?? DailyPracticeDayStatus.PAUSED,
      leaseOwnerToken: null,
      leasedUntil: null,
    },
  });
}

export function planStatus(
  personalized: number,
  _fixed: number,
  source: DailyPracticeGenerationSource,
) {
  if (personalized === 0) return DailyPracticeDayStatus.NO_CONTENT;
  if (personalized < 5) return DailyPracticeDayStatus.LIMITED_CONTENT;
  if (source === DailyPracticeGenerationSource.DETERMINISTIC) {
    return DailyPracticeDayStatus.DEGRADED_READY;
  }
  return DailyPracticeDayStatus.READY;
}

function suggestionStatus(status: string) {
  if (status === 'APPLIED') return DailyPracticeSuggestionStatus.APPLIED;
  if (status === 'PARTIALLY_APPLIED') {
    return DailyPracticeSuggestionStatus.PARTIALLY_APPLIED;
  }
  return DailyPracticeSuggestionStatus.NOT_APPLIED;
}

function generationSourceForStrategy(strategy: AiTaskStrategy) {
  if (strategy === AiTaskStrategy.PRO_MAX) return DailyPracticeGenerationSource.PRO_MAX;
  if (strategy === AiTaskStrategy.PRO_HIGH) return DailyPracticeGenerationSource.PRO_HIGH;
  return DailyPracticeGenerationSource.FLASH_HIGH;
}

function errorCategory(error: unknown) {
  if (error instanceof AiClientError) return error.category;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 80);
  }
  if (error instanceof AiInvocationIdempotencyError) return 'IDEMPOTENCY_CONFLICT';
  return error instanceof Error ? error.name.slice(0, 80) : 'UNKNOWN';
}

export function scopeRecentAttempts(
  attempts: Array<{ score: number | null; total: number; results: Prisma.JsonValue | null; snapshot: Prisma.JsonValue; submittedAt: Date | null }>,
  subjectIds: ReadonlySet<string>,
) {
  return attempts.flatMap((attempt) => {
    const raw = Array.isArray(attempt.snapshot) ? attempt.snapshot :
      isRecord(attempt.snapshot) && Array.isArray(attempt.snapshot.questions) ? attempt.snapshot.questions : [];
    const ids = new Set(raw.filter((question) => isRecord(question) && typeof question.subjectId === 'string' && subjectIds.has(question.subjectId))
      .map((question) => (question as Record<string, unknown>).id));
    const results = (Array.isArray(attempt.results) ? attempt.results : []).filter((result) =>
      isRecord(result) && ids.has(result.questionId) && typeof result.score === 'number' && typeof result.maxScore === 'number',
    );
    if (!results.length) return [];
    return [{
      ...attempt,
      results,
      score: results.reduce<number>((sum, result) => sum + Number((result as Record<string, unknown>).score), 0),
      total: results.reduce<number>((sum, result) => sum + Number((result as Record<string, unknown>).maxScore), 0),
    }];
  });
}

export function summarizeRecentAttempts(
  attempts: Array<{
    score: number | null;
    total: number;
    results: Prisma.JsonValue | null;
    submittedAt: Date | null;
  }>,
) {
  let answeredQuestions = 0;
  let earnedPoints = 0;
  let availablePoints = 0;
  const activeDates = new Set<string>();
  for (const attempt of attempts) {
    if (!attempt.submittedAt) continue;
    activeDates.add(practiceDateForInstant(attempt.submittedAt));
    answeredQuestions += Array.isArray(attempt.results)
      ? attempt.results.length
      : 0;
    if (attempt.score !== null && attempt.total > 0) {
      earnedPoints += attempt.score;
      availablePoints += attempt.total;
    }
  }
  return {
    submittedAttempts: attempts.filter((attempt) => attempt.submittedAt).length,
    answeredQuestions,
    accuracyBps:
      availablePoints > 0
        ? Math.max(
            0,
            Math.min(
              10_000,
              Math.round((earnedPoints / availablePoints) * 10_000),
            ),
          )
        : null,
    activeDays: Math.min(30, activeDates.size),
  };
}

function daysBetweenInstants(later: Date, earlier: Date) {
  return Math.max(
    0,
    Math.floor((later.getTime() - earlier.getTime()) / 86_400_000),
  );
}

function reviewDueAt(
  nextReviewAt: Date | null,
  baselineAt: Date,
  deadlineAt: Date,
) {
  if (nextReviewAt && nextReviewAt < baselineAt) return 'OVERDUE' as const;
  if (nextReviewAt && nextReviewAt <= deadlineAt) return 'DUE' as const;
  return 'NOT_DUE' as const;
}

function rubricTexts(value: Prisma.JsonValue | null | undefined) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (isRecord(item)) {
      const text = typeof item.text === 'string'
        ? item.text
        : typeof item.description === 'string'
          ? item.description
          : null;
      return text ? [boundText(text, 120)] : [];
    }
    return [];
  }).slice(0, 10);
}

function sourceKey(documentId: string, nodePathHash: string) {
  return `${documentId}\u0000${nodePathHash}`;
}

function alias(prefix: 'C' | 'K' | 'Q' | 'S' | 'F', index: number) {
  return `${prefix}${String(index + 1).padStart(3, '0')}`;
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function uniqueBy<T>(values: T[], key: (value: T) => string) {
  const found = new Map<string, T>();
  for (const value of values) found.set(key(value), value);
  return [...found.values()];
}

function boundText(value: string, maximum: number) {
  return Array.from(
    value
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
    .slice(0, maximum)
    .join('');
}

function stringArray(value: unknown, maximum: number) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value.slice(0, maximum).map((item) =>
      typeof item === 'string' ? item : undefined,
    ),
  );
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareAscii(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function configuredInteger(name: string, minimum: number, maximum: number, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DailyGenerationValidationError(`${name}_INVALID`);
  }
  return value;
}

function dailyTimeoutMs() {
  return configuredInteger('AI_DAILY_PLAN_TIMEOUT_MS', 1_000, 600_000, 180_000);
}

function dailyConcurrency() {
  return configuredInteger('AI_DAILY_PLAN_CONCURRENCY', 1, 100, 1);
}

function dailyMaxInputTokens() {
  return configuredInteger('AI_DAILY_PLAN_MAX_INPUT_TOKENS', 1_000, 32_000, 32_000);
}

function dailyMaxOutputTokens() {
  return configuredInteger('AI_DAILY_PLAN_MAX_OUTPUT_TOKENS', 100, 32_000, 4_000);
}

function dailyCallLimit() {
  return configuredInteger('AI_DAILY_PLAN_DAILY_CALL_LIMIT', 1, 1_000_000, 1_000);
}

function dailyTokenLimit() {
  return configuredInteger('AI_DAILY_PLAN_DAILY_TOKEN_LIMIT', 1_000, 1_000_000_000, 10_000_000);
}

function dailyLeaseMs() {
  return configuredInteger('DAILY_PRACTICE_JOB_LEASE_MS', 60_000, 3_600_000, 600_000);
}

export class DailyGenerationValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DailyGenerationValidationError';
  }
}

class DailyGenerationLeaseLostError extends Error {
  constructor() {
    super('daily generation lease was lost');
    this.name = 'DailyGenerationLeaseLostError';
  }
}

class DailyGenerationProfileChangedError extends Error {
  readonly code = 'PROFILE_REVISION_CHANGED';

  constructor() {
    super('PROFILE_REVISION_CHANGED');
    this.name = 'DailyGenerationProfileChangedError';
  }
}

class DailyServicePausedError extends Error {
  constructor() {
    super('daily practice service is paused');
    this.name = 'DailyServicePausedError';
  }
}

export class FrozenCandidateSourceError extends Error {
  constructor() {
    super('frozen candidate source changed before publication');
    this.name = 'FrozenCandidateSourceError';
  }
}
