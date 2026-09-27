import {
  DailyPersonalizationValidationError,
  buildDailyPersonalizationPayload,
  buildDeterministicFallback,
  parseDailyPersonalizationOutput,
  prepareCandidates,
  type DailyPersonalizationOutput,
} from '@bmc3/daily-practice-core';
import { AiClientError, type AiRequest } from '@bmc3/ai-core';
import {
  AiTaskStrategy,
  DailyPracticeDayStatus,
  DailyPracticeGenerationSource,
  DailyPracticePlanTrigger,
  DailyPracticeStrategyAttemptStatus,
  Role,
} from '@prisma/client';
import {
  FrozenCandidateSourceError,
  assertCandidateSnapshotCurrent,
  assertDayFreezeInputsCurrent,
  DAILY_PRACTICE_STRATEGIES,
  beginStrategyAttempt,
  buildDailyCorrectionRequest,
  buildFixedDailyPlanItems,
  canPublishPlanRevision,
  deterministicReason,
  filterCurrentFixedQuestions,
  finalizeDeadlineBlockedDay,
  lockAndAssertProfileRevision,
  nextPendingPlanRevision,
  planStatus,
  processNextDailyPracticeGeneration,
  projectSuggestions,
  projectNearestActiveLearningSummary,
  readFrozenGeneration,
  selectDailyCandidatePool,
  shouldCorrectDailyMaxResponse,
  summarizeRecentAttempts,
} from './daily-practice-generation';
import { sha256 } from './daily-practice-scheduler';
import * as practicePrisma from '@bmc3/daily-practice-prisma';

it('preserves fixed-question content versions so a published fixed plan can pass the start fence', () => {
  const items = buildFixedDailyPlanItems('revision', 8, [{
    questionId: 'fixed', ordinal: 1, questionReviewRevision: 3,
    questionContentRevision: 7, sourceRevision: 2, promptHash: sha256('题干'),
    gradingType: 'SINGLE', typeLabel: '单选', promptExcerpt: '题干',
    subjectId: 'subject', subjectName: '医学分子细胞遗传', chapterIds: ['chapter'],
  }]);
  expect(items).toEqual([expect.objectContaining({
    source: 'ADMIN_FIXED', ordinal: 8, questionId: 'fixed',
    questionContentRevision: 7, questionReviewRevision: 3, sourceRevision: 2,
  })]);
});

jest.mock('@bmc3/daily-practice-prisma', () => ({
  ...jest.requireActual('@bmc3/daily-practice-prisma'),
  loadEligiblePracticeQuestions: jest.fn(),
}));

function generationQueueFixture(preview: boolean) {
  const now = new Date('2026-07-28T00:00:00.000Z');
  const days = ['day-a', 'day-b', 'day-c'].map((id) => ({
    id,
    status: preview ? DailyPracticeDayStatus.READY : DailyPracticeDayStatus.PENDING,
    leasedUntil: id === 'day-c' ? new Date(now.getTime() - 1) : null as Date | null,
    leaseOwnerToken: null as string | null,
  }));
  type LeaseWhere = {
    OR?: Array<{ leasedUntil: null | { lt: Date } }>;
  };
  const available = (day: typeof days[number], where: LeaseWhere) =>
    !where.OR || where.OR.some((condition) =>
      condition.leasedUntil === null
        ? day.leasedUntil === null
        : day.leasedUntil !== null && day.leasedUntil < condition.leasedUntil.lt,
    );
  let releaseFirst!: () => void;
  let signalFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
  const firstFinishes = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const claimedIds: string[] = [];
  const prisma = {
    dailyPracticeSettings: {
      findUnique: jest.fn(async () => ({ enabled: true, revision: 1 })),
    },
    dailyPracticeServicePause: { findFirst: jest.fn(async () => null) },
    dailyPracticeDay: {
      findFirst: jest.fn(async ({ where }: { where: LeaseWhere & { deadlineAt?: unknown } }) => {
        if (where.deadlineAt || preview) return null;
        return days.find((day) => available(day, where)) ?? null;
      }),
      findUnique: jest.fn(async ({ where, include }: { where: { id: string }; include?: unknown }) => {
        if (!include) return days.find((day) => day.id === where.id) ?? null;
        if (where.id === 'day-a') {
          signalFirst();
          await firstFinishes;
        }
        // Stop after acquisition as if the day was removed before loading its inputs.
        return null;
      }),
      updateMany: jest.fn(async ({ where, data }: {
        where: LeaseWhere & { id: string };
        data: { leasedUntil: Date; leaseOwnerToken: string };
      }) => {
        const day = days.find((item) => item.id === where.id);
        if (!day || !available(day, where)) return { count: 0 };
        Object.assign(day, data);
        claimedIds.push(day.id);
        return { count: 1 };
      }),
    },
    dailyPracticePlanRevision: {
      findFirst: jest.fn(async ({ where }: { where: { dayId?: string; day?: LeaseWhere } }) => {
        if (where.dayId) return { trigger: preview ? DailyPracticePlanTrigger.ADMIN_PREVIEW : DailyPracticePlanTrigger.AUTO };
        const day = days.find((item) => available(item, where.day ?? {}));
        return day ? { dayId: day.id } : null;
      }),
    },
  };
  return { prisma, now, days, claimedIds, firstStarted, releaseFirst };
}

function buildTestPayload() {
  return buildDailyPersonalizationPayload({
    practiceDate: '2026-07-28',
    inputPolicy: {
      knowledgeCount: { minimum: 3, maximum: 3 },
      questionCount: { minimum: 4, maximum: 4 },
      mandatoryQuestionAliases: ['Q002', 'Q001'],
      fixedQuestionCount: 1,
      fixedQuestionAliases: ['F001'],
      allowedKnowledgeAliases: ['K001', 'K002', 'K003'],
      allowedQuestionAliases: ['Q001', 'Q002', 'Q003', 'Q004', 'Q005'],
      allowedSignalAliases: ['S001', 'S002', 'S003', 'S201'],
    },
    profile: {
      dataQuality: 'SUFFICIENT',
      overall: {
        submittedAttempts30d: 6,
        answeredQuestions30d: 30,
        accuracyBps30d: 7_500,
        activeDays30d: 5,
        overdueKnowledgeCount: 1,
        overdueChapterCount: 1,
      },
      knowledgeSignals: [
        {
          signalAlias: 'S001',
          knowledgeAlias: 'K001',
          masteryBps: 9_000,
          attemptCount: 5,
          wrongCount: 1,
          correctStreak: 3,
          lastScoreBps: 10_000,
          daysSincePractice: 2,
          reviewDue: 'NOT_DUE',
          missingRubricPoints: [],
        },
        {
          signalAlias: 'S002',
          knowledgeAlias: 'K002',
          masteryBps: 5_000,
          attemptCount: 3,
          wrongCount: 2,
          correctStreak: 0,
          lastScoreBps: 4_000,
          daysSincePractice: 5,
          reviewDue: 'OVERDUE',
          missingRubricPoints: ['说明关键机制'],
        },
        {
          signalAlias: 'S003',
          knowledgeAlias: 'K003',
          masteryBps: 7_000,
          attemptCount: 2,
          wrongCount: 1,
          correctStreak: 0,
          lastScoreBps: 7_000,
          daysSincePractice: 3,
          reviewDue: 'DUE',
          missingRubricPoints: [],
        },
      ],
      chapterSignals: [],
      recentWrongSignals: [
        {
          signalAlias: 'S201',
          questionAlias: 'Q002',
          chapterAliases: ['C001'],
          gradingType: 'SHORT_ANSWER',
          wrongCount: 2,
          lastScoreBps: 4_000,
          daysSinceWrong: 1,
          missingRubricPoints: ['说明关键机制'],
        },
      ],
    },
    previousLearningSummary: null,
    candidateKnowledge: [
      candidateKnowledge('K001', '细胞膜', 40, 2),
      candidateKnowledge('K002', '跨膜转运', 90, 2),
      candidateKnowledge('K003', '静息电位', 70, 1),
    ],
    candidateQuestions: [
      candidateQuestion('Q001', ['K001'], 'SINGLE', 80),
      candidateQuestion('Q002', ['K002'], 'SHORT_ANSWER', 100),
      candidateQuestion('Q003', ['K003'], 'SHORT_ANSWER', 70),
      candidateQuestion('Q004', ['K002'], 'MULTIPLE', 90),
      candidateQuestion('Q005', ['K003'], 'TRUE_FALSE', 60),
    ],
    fixedQuestions: [
      {
        fixedQuestionAlias: 'F001',
        chapterAliases: ['C001'],
        subjectName: '生理学',
        gradingType: 'SINGLE',
        typeLabel: '单选题',
        promptExcerpt: '固定附加题题干',
        adminOrder: 1,
      },
    ],
    suggestion: { userSuggestion: null, adminSuggestion: null },
  });
}

function candidateKnowledge(
  knowledgeAlias: string,
  title: string,
  reviewPriority: number,
  eligibleQuestionCount: number,
) {
  return {
    knowledgeAlias,
    subjectName: '生理学',
    chapterAliases: ['C001'],
    title,
    breadcrumb: `生理学 > ${title}`,
    firstTaughtDate: '2026-07-01',
    reviewPriority,
    eligibleQuestionCount,
  };
}

function candidateQuestion(
  questionAlias: string,
  knowledgeAliases: string[],
  gradingType: 'SINGLE' | 'MULTIPLE' | 'TRUE_FALSE' | 'SHORT_ANSWER',
  priorityScore: number,
) {
  return {
    questionAlias,
    knowledgeAliases,
    chapterAliases: ['C001'],
    gradingType,
    typeLabel: gradingType === 'SHORT_ANSWER' ? '简答题' : '选择题',
    promptExcerpt: `${questionAlias} 的课程题干`,
    priorityScore,
    daysSinceLastSeen: null,
  };
}

function validOutput(): DailyPersonalizationOutput {
  return {
    schemaVersion: 'daily-personalization-v3',
    learningSummary: {
      headline: '近期学习状态仍可提升',
      overview: '近期基础题表现较稳定，但重点内容仍需要按计划复习。',
      dataQuality: 'SUFFICIENT',
      strengths: [
        {
          knowledgeAlias: 'K001',
          text: '细胞膜基础概念已有稳定表现。',
          evidenceRefs: ['S001'],
        },
      ],
      priorities: [
        {
          knowledgeAlias: 'K002',
          text: '跨膜转运已经逾期，需要优先复习。',
          evidenceRefs: ['S002'],
        },
      ],
    },
    selectedKnowledge: [
      { knowledgeAlias: 'K001', reason: '维持稳定表现。', evidenceRefs: ['S001'] },
      { knowledgeAlias: 'K002', reason: '优先复习逾期内容。', evidenceRefs: ['S002'] },
      { knowledgeAlias: 'K003', reason: '已到复习时间。', evidenceRefs: ['S003'] },
    ],
    selectedQuestions: [
      { questionAlias: 'Q002', reason: '近期错误优先。', evidenceRefs: ['S201'] },
      { questionAlias: 'Q001', reason: '巩固基础概念。', evidenceRefs: ['S001'] },
      { questionAlias: 'Q004', reason: '复习跨膜转运。', evidenceRefs: ['S002'] },
      { questionAlias: 'Q005', reason: '复习静息电位。', evidenceRefs: ['S003'] },
    ],
    suggestionEvaluation: { status: 'NONE', message: '今日没有待处理的学习建议。' },
  };
}

describe('daily practice generation', () => {
  it('processes pending revisions oldest-first and never publishes backwards', () => {
    const revisions = [
      { id: 'revision-3', revision: 3, trigger: DailyPracticePlanTrigger.ADMIN_REGENERATE },
      { id: 'revision-1', revision: 1, trigger: DailyPracticePlanTrigger.ADMIN_REGENERATE },
      { id: 'revision-2', revision: 2, trigger: DailyPracticePlanTrigger.ADMIN_PREVIEW },
    ];
    expect(nextPendingPlanRevision(revisions)?.id).toBe('revision-1');

    let activeRevision: number | null = null;
    for (const revision of [...revisions].sort((left, right) => left.revision - right.revision)) {
      if (
        canPublishPlanRevision({
          trigger: revision.trigger,
          revision: revision.revision,
          activeRevision,
          dayStatus: DailyPracticeDayStatus.PROCESSING,
          started: false,
          completed: false,
        })
      ) {
        activeRevision = revision.revision;
      }
    }
    expect(activeRevision).toBe(3);
    expect(
      canPublishPlanRevision({
        trigger: DailyPracticePlanTrigger.ADMIN_REGENERATE,
        revision: 1,
        activeRevision: 3,
        dayStatus: DailyPracticeDayStatus.PROCESSING,
        started: false,
        completed: false,
      }),
    ).toBe(false);
    expect(
      canPublishPlanRevision({
        trigger: DailyPracticePlanTrigger.ADMIN_PREVIEW,
        revision: 4,
        activeRevision: 3,
        dayStatus: DailyPracticeDayStatus.COMPLETED,
        started: true,
        completed: true,
      }),
    ).toBe(false);
    expect(
      canPublishPlanRevision({
        trigger: DailyPracticePlanTrigger.AUTO,
        revision: 1,
        activeRevision: null,
        latestPublishableRevision: 2,
        dayStatus: DailyPracticeDayStatus.PROCESSING,
        started: false,
        completed: false,
      }),
    ).toBe(false);
  });

  it('rejects publishing when the frozen candidate snapshot no longer matches the day', () => {
    const frozenHash = sha256('frozen');
    expect(() =>
      assertCandidateSnapshotCurrent(frozenHash, frozenHash),
    ).not.toThrow();
    expect(() =>
      assertCandidateSnapshotCurrent(frozenHash, sha256('other')),
    ).toThrow(FrozenCandidateSourceError);
    expect(() => assertCandidateSnapshotCurrent(undefined, null)).toThrow(
      FrozenCandidateSourceError,
    );
  });

  it('rejects freezing when the day moved to STALE or the progress hash changed', () => {
    const progressHash = 'a'.repeat(64);
    expect(() =>
      assertDayFreezeInputsCurrent(
        {
          status: DailyPracticeDayStatus.PROCESSING,
          progressSetHash: progressHash,
        },
        DailyPracticeDayStatus.PROCESSING,
        progressHash,
      ),
    ).not.toThrow();
    expect(() =>
      assertDayFreezeInputsCurrent(
        {
          status: DailyPracticeDayStatus.STALE,
          progressSetHash: progressHash,
        },
        DailyPracticeDayStatus.PROCESSING,
        progressHash,
      ),
    ).toThrow(FrozenCandidateSourceError);
    expect(() =>
      assertDayFreezeInputsCurrent(
        {
          status: DailyPracticeDayStatus.PROCESSING,
          progressSetHash: 'b'.repeat(64),
        },
        DailyPracticeDayStatus.PROCESSING,
        progressHash,
      ),
    ).toThrow(FrozenCandidateSourceError);
    expect(() =>
      assertDayFreezeInputsCurrent(
        null,
        DailyPracticeDayStatus.PROCESSING,
        progressHash,
      ),
    ).toThrow(FrozenCandidateSourceError);
  });

  it('keeps small candidate pools eligible for the model and exempts admin tests from old deadlines', () => {
    const payload = buildTestPayload();
    const frozen = {
      candidateQuestions: [{ questionId: 'question-1' }],
      payload,
    };
    const beforeDeadline = new Date('2026-07-27T20:10:00.000Z');
    const afterDeadline = new Date('2026-07-27T21:00:00.000Z');
    const day = {
      deadlineAt: new Date('2026-07-27T20:30:00.000Z'),
      cycle: { lastErrorCategory: null },
    };
    expect(
      deterministicReason(
        day as never,
        { trigger: DailyPracticePlanTrigger.AUTO },
        frozen as never,
        beforeDeadline,
      ),
    ).toBeNull();
    expect(
      deterministicReason(
        {
          ...day,
          cycle: { lastErrorCategory: 'CAPACITY_GATE_FAILED' },
        } as never,
        { trigger: DailyPracticePlanTrigger.ADMIN_REGENERATE },
        frozen as never,
        afterDeadline,
      ),
    ).toBeNull();
    expect(
      deterministicReason(
        day as never,
        { trigger: DailyPracticePlanTrigger.AUTO },
        frozen as never,
        afterDeadline,
      ),
    ).toBe('DAILY_DEADLINE_REACHED');
  });

  it('uses NO_CONTENT for a fixed-only plan and summarizes the real 30-day window', () => {
    expect(
      planStatus(0, 3, DailyPracticeGenerationSource.DETERMINISTIC),
    ).toBe(DailyPracticeDayStatus.NO_CONTENT);
    expect(
      planStatus(4, 0, DailyPracticeGenerationSource.PRO_MAX),
    ).toBe(DailyPracticeDayStatus.LIMITED_CONTENT);
    expect(
      planStatus(5, 0, DailyPracticeGenerationSource.DETERMINISTIC),
    ).toBe(DailyPracticeDayStatus.DEGRADED_READY);

    expect(
      summarizeRecentAttempts([
        {
          score: 3,
          total: 4,
          results: [{}, {}],
          submittedAt: new Date('2026-07-27T19:59:59.999Z'),
        },
        {
          score: 1,
          total: 1,
          results: [{}],
          submittedAt: new Date('2026-07-27T20:00:00.000Z'),
        },
      ] as never),
    ).toEqual({
      submittedAttempts: 2,
      answeredQuestions: 3,
      accuracyBps: 8_000,
      activeDays: 2,
    });
  });

  it('drops a frozen fixed question that becomes invalid before a new revision', async () => {
    jest.mocked(practicePrisma.loadEligiblePracticeQuestions).mockResolvedValueOnce([{ id: 'fixed-valid' }] as never);
    const frozen = ['fixed-valid', 'fixed-disabled'].map((questionId, index) => ({
      questionId,
      ordinal: index + 1,
      questionReviewRevision: 2,
      sourceRevision: 3,
      promptHash: sha256(`Prompt ${questionId}`),
      gradingType: 'SINGLE' as const,
      typeLabel: '单选题',
      promptExcerpt: `Prompt ${questionId}`,
      subjectId: 'subject-1',
      subjectName: '生理学',
      chapterIds: ['chapter-1'],
    }));
    const prisma = {
      quizQuestion: {
        findMany: jest.fn(async () =>
          frozen.map((question) => ({
            id: question.questionId,
            enabled: question.questionId === 'fixed-valid',
            origin: 'MANUAL',
            reviewStatus: 'APPROVED',
            reviewRevision: 2,
            sourceRevision: 3,
            prompt: `Prompt ${question.questionId}`,
            subject: { active: true },
            chapters: [{ chapter: { active: true } }],
          })),
        ),
      },
    };

    await expect(
      filterCurrentFixedQuestions(prisma as never, frozen),
    ).resolves.toEqual([frozen[0]]);
  });

  it('keeps mandatory questions and at most one short answer in the bounded model pool', () => {
    const prepared = prepareCandidates(
      [
        ...Array.from({ length: 60 }, (_, index) => ({
          questionId: `short-${index}`,
          gradingType: 'SHORT_ANSWER' as const,
          reviewUrgency: 40,
          errorRisk: 30,
          masteryBps: 0,
          coverageDebt: 10,
          seenWithin24Hours: false,
          suggestionMatch: 10,
        })),
        ...Array.from({ length: 60 }, (_, index) => ({
          questionId: `choice-${index}`,
          gradingType: 'SINGLE' as const,
          reviewUrgency: 0,
          errorRisk: 0,
          masteryBps: 10_000,
          coverageDebt: 0,
          seenWithin24Hours: true,
          suggestionMatch: 0,
          mandatoryEligible: index === 59,
        })),
      ],
      '2026-07-28',
      'user-1',
    );

    const pool = selectDailyCandidatePool(prepared, 50);

    expect(pool.candidates).toHaveLength(50);
    expect(
      pool.candidates.filter(
        (candidate) => candidate.gradingType === 'SHORT_ANSWER',
      ),
    ).toHaveLength(1);
    expect(pool.candidates.map((candidate) => candidate.questionId)).toContain(
      'choice-59',
    );
    expect(pool.questionCount).toEqual({ minimum: 5, maximum: 10 });
  });

  it('separates a self-submitted user suggestion from an administrator override by quota key', () => {
    const rows = [
      {
        id: 'user-suggestion',
        submittedById: 'user-1',
        userQuotaKey: 'USER:user-1:2026-07-29',
        payload: {
          intensity: 'LIGHT',
          desiredQuestionCount: 6,
          focusSubjectIds: ['subject-1'],
          focusChapterIds: ['chapter-1'],
          note: '用户建议',
        },
        submittedBy: { role: Role.ADMIN },
      },
      {
        id: 'admin-suggestion',
        submittedById: 'user-1',
        userQuotaKey: null,
        payload: {
          intensity: 'CHALLENGING',
          desiredQuestionCount: 8,
          focusSubjectIds: ['subject-1'],
          focusChapterIds: ['chapter-1'],
          note: '管理员建议',
        },
        submittedBy: { role: Role.ADMIN },
      },
    ];

    const result = projectSuggestions(
      rows,
      'user-1',
      [{ subjectId: 'subject-1', subject: { name: '生理学' } }],
      new Map([['chapter-1', 'C001']]),
    );

    expect(result.payload.userSuggestion).toMatchObject({
      desiredQuestionCount: 6,
      note: '用户建议',
    });
    expect(result.payload.adminSuggestion).toMatchObject({
      desiredQuestionCount: 8,
      note: '管理员建议',
    });
    expect(result.ids).toEqual(['user-suggestion', 'admin-suggestion']);
  });

  it('finalizes an uninitialized day at the deadline without invoking a model', async () => {
    const prisma = {
      dailyPracticeDay: {
        findFirst: jest.fn(async () => ({ id: 'day-blocked' })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    await expect(
      finalizeDeadlineBlockedDay(
        prisma as never,
        new Date('2026-07-28T20:30:00.000Z'),
      ),
    ).resolves.toBe(true);
    expect(prisma.dailyPracticeDay.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DailyPracticeDayStatus.FAILED,
          lastErrorCategory: 'PROFILE_NOT_READY_AT_DEADLINE',
        }),
      }),
    );
  });

  it('uses only the nearest active day and enforces the 14/15-day boundary', () => {
    const summary = {
      dataQuality: 'LIMITED',
      headline: '近期记录有限',
      overview: '当前信号仍应优先。',
      strengths: [],
      priorities: [{ text: '继续复习关键机制。' }],
    };
    const candidate = {
      practiceDate: '2026-07-14',
      generationSource: 'PRO_MAX',
      trigger: 'ADMIN_REGENERATE',
      published: true,
      validated: true,
      learningSummary: summary,
    };
    expect(
      projectNearestActiveLearningSummary('2026-07-28', '2026-07-14', candidate),
    ).toMatchObject({ ageInDays: 14, practiceDate: '2026-07-14' });
    expect(
      projectNearestActiveLearningSummary('2026-07-29', '2026-07-14', candidate),
    ).toBeNull();
    expect(
      projectNearestActiveLearningSummary('2026-07-28', '2026-07-27', {
        ...candidate,
        practiceDate: '2026-07-27',
        generationSource: 'DETERMINISTIC',
      }),
    ).toBeNull();
  });

  it('reuses only the frozen snapshot belonging to the same revision', () => {
    const frozen = {
      version: 2,
      revisionId: 'revision-1',
      inputHash: 'a'.repeat(64),
      payload: {},
      candidateQuestions: [],
      fixedQuestions: [],
      suggestionIds: [],
      profileRevision: 1,
      previousSummarySourceRevisionId: null,
    };
    expect(readFrozenGeneration(frozen as never, 'revision-1')).toBe(frozen);
    expect(readFrozenGeneration(frozen as never, 'revision-2')).toBeNull();
  });

  it('locks and rejects a changed practice-profile revision before freezing input', async () => {
    const matching = {
      $queryRaw: jest.fn(async () => [
        { stateRevision: 7, initializationStatus: 'READY' },
      ]),
    };
    await expect(
      lockAndAssertProfileRevision(matching as never, 'user-1', 7),
    ).resolves.toBeUndefined();

    const changed = {
      $queryRaw: jest.fn(async () => [
        { stateRevision: 8, initializationStatus: 'READY' },
      ]),
    };
    await expect(
      lockAndAssertProfileRevision(changed as never, 'user-1', 7),
    ).rejects.toThrow('PROFILE_REVISION_CHANGED');
  });

  it('creates each model strategy at most once in the reviewed order', async () => {
    expect(DAILY_PRACTICE_STRATEGIES).toEqual([
      AiTaskStrategy.PRO_MAX,
      AiTaskStrategy.PRO_HIGH,
      AiTaskStrategy.FLASH_NO_THINKING,
    ]);
    const prisma = {
      dailyPracticeStrategyAttempt: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: { strategy: AiTaskStrategy } }) => ({
          id: `attempt-${data.strategy}`,
          ...data,
        })),
        updateMany: jest.fn(),
      },
    };
    for (const strategy of DAILY_PRACTICE_STRATEGIES) {
      await beginStrategyAttempt(prisma as never, 'day-1', 'revision-1', strategy);
    }
    expect(prisma.dailyPracticeStrategyAttempt.create.mock.calls.map(
      ([call]) => call.data.strategy,
    )).toEqual(DAILY_PRACTICE_STRATEGIES);

    prisma.dailyPracticeStrategyAttempt.findUnique.mockResolvedValueOnce({
      id: 'existing',
      status: DailyPracticeStrategyAttemptStatus.FAILED,
    } as never);
    await expect(
      beginStrategyAttempt(
        prisma as never,
        'day-1',
        'revision-1',
        AiTaskStrategy.PRO_MAX,
      ),
    ).resolves.toBeNull();
  });

  it('retries one unusable Max reply with the reply and validation error as context', () => {
    const originalRequest: AiRequest = {
      taskType: 'DAILY_PLAN',
      strategy: 'PRO_MAX',
      promptVersion: 'daily-personalization-v3',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'original payload' },
      ],
      maxOutputTokens: 4_000,
      timeoutMs: 300_000,
    };
    const invalidContent = '{"selectedQuestions":[]}';
    const validationError = new DailyPersonalizationValidationError(
      'SCHEMA_INVALID',
      'model output does not match the strict response schema',
      [
        {
          instancePath: '/learningSummary',
          schemaPath: '#/required',
          keyword: 'required',
          params: { missingProperty: 'headline' },
          message: "must have required property 'headline'",
        },
      ],
    );

    expect(
      shouldCorrectDailyMaxResponse(
        AiTaskStrategy.PRO_MAX,
        0,
        validationError,
      ),
    ).toBe(true);
    expect(
      shouldCorrectDailyMaxResponse(
        AiTaskStrategy.PRO_MAX,
        1,
        validationError,
      ),
    ).toBe(false);
    expect(
      shouldCorrectDailyMaxResponse(
        AiTaskStrategy.PRO_HIGH,
        0,
        validationError,
      ),
    ).toBe(false);

    const correction = buildDailyCorrectionRequest(
      originalRequest,
      invalidContent,
      validationError,
    );
    expect(correction.messages).toEqual([
      ...originalRequest.messages,
      { role: 'assistant', content: invalidContent },
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('错误类别：SCHEMA_INVALID'),
      }),
    ]);
    expect(correction.messages.at(-1)?.content).toContain('/learningSummary');
    expect(originalRequest.messages).toHaveLength(2);
  });

  it('retries one empty Max response with its provider error but no fake reply', () => {
    const originalRequest: AiRequest = {
      taskType: 'DAILY_PLAN',
      strategy: 'PRO_MAX',
      promptVersion: 'daily-personalization-v3',
      messages: [{ role: 'user', content: 'original payload' }],
      maxOutputTokens: 4_000,
      timeoutMs: 300_000,
    };
    const error = new AiClientError(
      '模型服务未返回有效内容',
      'INVALID_RESPONSE',
      false,
    );

    expect(
      shouldCorrectDailyMaxResponse(AiTaskStrategy.PRO_MAX, 0, error),
    ).toBe(true);
    const correction = buildDailyCorrectionRequest(originalRequest, null, error);
    expect(correction.messages).toHaveLength(2);
    expect(correction.messages[1]?.content).toContain('错误类别：INVALID_RESPONSE');
    expect(correction.messages[1]?.content).toContain('模型服务未返回有效内容');
  });

  it('rejects a model second short answer, then deterministic output remains startable', () => {
    const payload = buildTestPayload();
    const invalid = validOutput();
    invalid.selectedQuestions[3] = {
      questionAlias: 'Q003',
      reason: '再加入一道简答题。',
      evidenceRefs: ['S003'],
    };
    const next = validOutput();
    expect(() =>
      parseDailyPersonalizationOutput(JSON.stringify(invalid), payload),
    ).toThrow('too many short-answer questions');
    expect(
      parseDailyPersonalizationOutput(JSON.stringify(next), payload),
    ).toEqual(next);
    const fallback = buildDeterministicFallback(payload, 'ALL_STRATEGIES_FAILED');
    expect(fallback.output.selectedQuestions).toHaveLength(4);
    expect(
      fallback.output.selectedQuestions.filter((item) =>
        ['Q002', 'Q003'].includes(item.questionAlias),
      ),
    ).toHaveLength(1);
  });

  it('does not claim a day or call a model while service is disabled', async () => {
    const prisma = {
      dailyPracticeSettings: {
        findUnique: jest.fn(async () => ({ enabled: false, revision: 1, reason: '暂停' })),
      },
      dailyPracticeServicePause: { findFirst: jest.fn(async () => null) },
      dailyPracticeDay: { findFirst: jest.fn() },
    };
    const client = { complete: jest.fn(), model: jest.fn() };
    await expect(
      processNextDailyPracticeGeneration(prisma as never, { client }),
    ).resolves.toBe(false);
    expect(prisma.dailyPracticeDay.findFirst).not.toHaveBeenCalled();
    expect(client.complete).not.toHaveBeenCalled();
  });

  it.each([false, true])('runs another lane past an active lease (preview=%s)', async (preview) => {
    const fixture = generationQueueFixture(preview);
    const dependencies = { now: () => fixture.now };
    const first = processNextDailyPracticeGeneration(fixture.prisma as never, dependencies);
    await fixture.firstStarted;
    try {
      await expect(
        processNextDailyPracticeGeneration(fixture.prisma as never, dependencies),
      ).resolves.toBe(true);
      await expect(
        processNextDailyPracticeGeneration(fixture.prisma as never, dependencies),
      ).resolves.toBe(true);
      expect(fixture.claimedIds).toEqual(['day-a', 'day-b', 'day-c']);
      await expect(
        processNextDailyPracticeGeneration(fixture.prisma as never, dependencies),
      ).resolves.toBe(false);
    } finally {
      fixture.releaseFirst();
      await first;
    }
  });

  it('does not process a candidate claimed by another lane after selection', async () => {
    const fixture = generationQueueFixture(false);
    fixture.prisma.dailyPracticeDay.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
    await expect(
      processNextDailyPracticeGeneration(fixture.prisma as never, { now: () => fixture.now }),
    ).resolves.toBe(true);
    expect(fixture.claimedIds).toEqual([]);
    expect(fixture.prisma.dailyPracticeDay.findUnique).toHaveBeenCalledTimes(1);
  });
});
