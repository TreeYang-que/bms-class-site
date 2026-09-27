import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  AccountStatus,
  DailyPracticeCycleStatus,
  DailyPracticeDayStatus,
  DailyPracticePlanTrigger,
  DailyPracticePlanItemSource,
  Prisma,
  QuestionType,
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
  Role,
} from '@prisma/client';
import { lockDailyPracticeSettings } from './daily-practice-gate';
import { DAILY_PRACTICE_ERROR_CODES } from './daily-practice.errors';
import { DailyPracticeService } from './daily-practice.service';
import { assertDailyQuestionEligibility, loadEligiblePracticeQuestions, loadPracticeCourses } from '@bmc3/daily-practice-prisma';

jest.mock('@bmc3/daily-practice-prisma', () => ({
  ...jest.requireActual('@bmc3/daily-practice-prisma'),
  assertDailyQuestionEligibility: jest.fn().mockResolvedValue(true),
  loadEligiblePracticeQuestions: jest.fn().mockResolvedValue([]),
  loadPracticeCourses: jest.fn().mockResolvedValue([]),
}));

jest.mock('./daily-practice-gate', () => ({
  lockDailyPracticeSettings: jest.fn().mockResolvedValue(undefined),
}));

const editor = {
  id: 'editor-1',
  role: Role.EDITOR,
  status: AccountStatus.ACTIVE,
} as never;

const admin = {
  id: 'admin-1',
  role: Role.ADMIN,
  status: AccountStatus.ACTIVE,
} as never;

const member = {
  id: 'member-1',
  role: Role.MEMBER,
  status: AccountStatus.ACTIVE,
} as never;

const mockedLockDailyPracticeSettings = jest.mocked(lockDailyPracticeSettings);

function createService(prisma: Record<string, unknown>) {
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const quizzes = { startDailyPractice: jest.fn() };
  return {
    service: new DailyPracticeService(
      prisma as never,
      audit as never,
      quizzes as never,
      { list: jest.fn().mockResolvedValue({ practiceDate: '2026-09-24', initialized: true, courses: [{ status: 'ACTIVE', examDate: '2099-01-01', topics: [{ learned: true }] }] }) } as never,
    ),
    audit,
    quizzes,
  };
}

function responseCode(error: unknown) {
  if (!(error instanceof ConflictException)) return undefined;
  const response = error.getResponse();
  return typeof response === 'object' && response
    ? (response as { code?: string }).code
    : undefined;
}

describe('DailyPracticeService concurrency boundaries', () => {
  it('limits internal access changes to admins while globally paused and checks the revision before writing', async () => {
    const settings = { enabled: false, revision: 4, internalTestUserIds: ['existing-user'] };
    const transaction = {
      dailyPracticeSettings: { findUniqueOrThrow: jest.fn(async () => settings), update: jest.fn() },
      dailyPracticeDay: { updateMany: jest.fn() },
      user: { findUnique: jest.fn().mockResolvedValue({ status: AccountStatus.ACTIVE }) },
    };
    const prisma = { ...transaction, $transaction: jest.fn(async (work: (client: typeof transaction) => unknown) => work(transaction)) };
    const { service } = createService(prisma);
    await expect(service.updateTestAccess(editor, 'target-user', { enabled: true, expectedRevision: 4 })).rejects.toMatchObject({ status: 403 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    settings.enabled = true;
    await expect(service.updateTestAccess(admin, 'target-user', { enabled: true, expectedRevision: 4 })).rejects.toBeInstanceOf(ConflictException);
    settings.enabled = false;
    await expect(service.updateTestAccess(admin, 'target-user', { enabled: true, expectedRevision: 3 })).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.dailyPracticeSettings.update).not.toHaveBeenCalled();
    await service.updateTestAccess(admin, 'target-user', { enabled: true, expectedRevision: 4 });
    expect(transaction.dailyPracticeSettings.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ internalTestUserIds: ['existing-user', 'target-user'] }) }));
    expect(transaction.dailyPracticeDay.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'target-user' }) }));
  });

  it('returns a stable error when the settings revision changed', async () => {
    const transaction = {
      dailyPracticeSettings: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };
    const { service, audit } = createService(prisma);

    await expect(
      service.updateSettings(editor, {
        enabled: true,
        expectedRevision: 4,
        reason: '恢复每日练习',
      }),
    ).rejects.toMatchObject({
      response: {
        code: DAILY_PRACTICE_ERROR_CODES.serviceRevisionConflict,
      },
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects overlapping active service pauses before writing', async () => {
    const transaction = {
      dailyPracticeServicePause: {
        findFirst: jest.fn().mockResolvedValue({ id: 'pause-existing' }),
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };
    const { service, audit } = createService(prisma);

    await expect(
      service.createServicePause(editor, {
        startsAt: '2099-01-01T00:00:00.000Z',
        endsAt: '2099-01-02T00:00:00.000Z',
        reason: '假期停服',
      }),
    ).rejects.toMatchObject({
      response: {
        code: DAILY_PRACTICE_ERROR_CODES.serviceRevisionConflict,
      },
    });
    expect(transaction.dailyPracticeServicePause.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lets exactly one concurrent user suggestion consume the quota key', async () => {
    let created = false;
    const transaction = {
      dailyPracticeSettings: {
        findUnique: jest.fn().mockResolvedValue({
          enabled: true,
          revision: 1,
          reason: null,
        }),
      },
      dailyPracticeServicePause: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      dailyPracticeSuggestion: {
        create: jest.fn(async () => {
          if (created) {
            throw new Prisma.PrismaClientKnownRequestError('duplicate', {
              code: 'P2002',
              clientVersion: '6.13.0',
              meta: { target: ['userQuotaKey'] },
            });
          }
          created = true;
          return {
            id: 'suggestion-1',
            targetPracticeDate: new Date('2026-07-29T00:00:00.000Z'),
            payload: {
              intensity: 'STANDARD',
              desiredQuestionCount: 5,
              focusSubjectIds: [],
              focusChapterIds: [],
            },
            status: 'PENDING',
            createdAt: new Date('2026-07-28T08:00:00.000Z'),
            submittedBy: { role: Role.MEMBER },
          };
        }),
      },
    };
    const prisma = {
      ...transaction,
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };
    const { service } = createService(prisma);
    const dto = {
      intensity: 'STANDARD' as const,
      desiredQuestionCount: 5,
      focusSubjectIds: [],
      focusChapterIds: [],
    };

    const results = await Promise.allSettled([
      service.submitUserSuggestion(member, dto),
      service.submitUserSuggestion(member, dto),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(responseCode(rejected.reason)).toBe(
        DAILY_PRACTICE_ERROR_CODES.suggestionLimit,
      );
    }
  });

  it('recomputes the suggestion target after acquiring the settings gate at 04:00', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T19:59:59.999Z'));
    mockedLockDailyPracticeSettings.mockImplementationOnce(async () => {
      jest.setSystemTime(new Date('2026-07-27T20:00:00.000Z'));
    });
    const transaction = {
      dailyPracticeSettings: {
        findUnique: jest.fn().mockResolvedValue({
          enabled: true,
          revision: 1,
          reason: null,
        }),
      },
      dailyPracticeServicePause: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      dailyPracticeSuggestion: {
        create: jest.fn().mockResolvedValue({
          id: 'suggestion-boundary',
          targetPracticeDate: new Date('2026-07-29T00:00:00.000Z'),
          payload: {
            intensity: 'STANDARD',
            desiredQuestionCount: 5,
            focusSubjectIds: [],
            focusChapterIds: [],
          },
          status: 'PENDING',
          createdAt: new Date('2026-07-27T20:00:00.000Z'),
          submittedBy: { role: Role.MEMBER },
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };
    const { service } = createService(prisma);

    try {
      await service.submitUserSuggestion(member, {
        intensity: 'STANDARD',
        desiredQuestionCount: 5,
        focusSubjectIds: [],
        focusChapterIds: [],
      });
    } finally {
      jest.useRealTimers();
    }

    expect(transaction.dailyPracticeSuggestion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          targetPracticeDate: new Date('2026-07-29T00:00:00.000Z'),
          userQuotaKey: 'USER:member-1:2026-07-29',
        }),
      }),
    );
  });
});

describe('DailyPracticeService plan start boundary', () => {
  it('rejects an unstarted plan from a non-current practice date', async () => {
    const prisma = {
      dailyPracticePlanRevision: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'revision-old',
          trigger: 'AUTO',
          publishedAt: new Date('2000-01-01T00:00:00.000Z'),
          quizAttempt: null,
          items: [],
          day: {
            id: 'day-old',
            practiceDate: new Date('2000-01-01T00:00:00.000Z'),
            activeRevisionId: 'revision-old',
            status: DailyPracticeDayStatus.READY,
          },
        }),
      },
      dailyPracticeSettings: {
        findUnique: jest.fn().mockResolvedValue({
          enabled: true,
          revision: 1,
          reason: null,
        }),
      },
      dailyPracticeServicePause: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const { service, quizzes } = createService(prisma);

    await expect(service.start(member, 'revision-old')).rejects.toMatchObject({
      response: { code: DAILY_PRACTICE_ERROR_CODES.planStale },
    });
    expect(quizzes.startDailyPractice).not.toHaveBeenCalled();
  });

  it('starts a NO_CONTENT plan when it contains only administrator-fixed questions', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T04:00:00.000Z'));
    const prisma = {
      dailyPracticePlanRevision: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'revision-fixed',
          trigger: DailyPracticePlanTrigger.AUTO,
          publishedAt: new Date('2026-07-28T03:00:00.000Z'),
          quizAttempt: null,
          day: {
            id: 'day-fixed',
            practiceDate: new Date('2026-07-28T00:00:00.000Z'),
            activeRevisionId: 'revision-fixed',
            status: DailyPracticeDayStatus.NO_CONTENT,
          },
          items: [
            {
              source: DailyPracticePlanItemSource.ADMIN_FIXED,
              questionReviewRevision: 2,
              sourceRevision: null,
              question: {
                id: 'question-fixed',
                type: QuestionType.MULTIPLE,
                enabled: true,
                origin: QuizQuestionOrigin.MANUAL,
                reviewStatus: QuizQuestionReviewStatus.APPROVED,
                reviewRevision: 2,
                sourceRevision: 0,
                sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
                knowledgeSources: [],
              },
            },
          ],
        }),
      },
      dailyPracticeSettings: {
        findUnique: jest.fn().mockResolvedValue({
          enabled: true,
          revision: 1,
          reason: null,
        }),
      },
      dailyPracticeServicePause: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const { service, quizzes } = createService(prisma);
    quizzes.startDailyPractice.mockResolvedValue({
      attemptId: 'attempt-fixed',
      questions: [],
    });

    try {
      await expect(service.start(member, 'revision-fixed')).resolves.toEqual({
        attemptId: 'attempt-fixed',
        questions: [],
        planRevisionId: 'revision-fixed',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('marks an unstarted plan STALE when a frozen question is invalidated', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T04:00:00.000Z'));
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      dailyPracticePlanRevision: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'revision-invalid',
          trigger: DailyPracticePlanTrigger.AUTO,
          publishedAt: new Date('2026-07-28T03:00:00.000Z'),
          quizAttempt: null,
          day: {
            id: 'day-invalid',
            practiceDate: new Date('2026-07-28T00:00:00.000Z'),
            activeRevisionId: 'revision-invalid',
            status: DailyPracticeDayStatus.READY,
          },
          items: [
            {
              source: DailyPracticePlanItemSource.ADMIN_FIXED,
              questionReviewRevision: 2,
              sourceRevision: 0,
              question: {
                id: 'question-disabled',
                type: QuestionType.SINGLE,
                enabled: false,
                origin: QuizQuestionOrigin.MANUAL,
                reviewStatus: QuizQuestionReviewStatus.APPROVED,
                reviewRevision: 2,
                sourceRevision: 0,
                sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
                knowledgeSources: [],
              },
            },
          ],
        }),
      },
      dailyPracticeSettings: {
        findUnique: jest.fn().mockResolvedValue({
          enabled: true,
          revision: 1,
          reason: null,
        }),
      },
      dailyPracticeServicePause: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      dailyPracticeDay: { updateMany },
    };
    const { service, quizzes } = createService(prisma);

    try {
      await expect(service.start(member, 'revision-invalid')).rejects.toMatchObject({
        response: { code: DAILY_PRACTICE_ERROR_CODES.planStale },
      });
    } finally {
      jest.useRealTimers();
    }

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DailyPracticeDayStatus.STALE,
          lastErrorCategory: 'PLAN_ITEM_INVALIDATED',
        }),
      }),
    );
    expect(quizzes.startDailyPractice).not.toHaveBeenCalled();
  });
});

describe('DailyPracticeService late daily task creation', () => {
  it('creates one immediate supplemental task from the frozen cycle after 04:30', async () => {
    const now = new Date('2026-07-28T08:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const createdDay = {
      id: 'day-supplemental',
      status: DailyPracticeDayStatus.PENDING,
      createdAt: now,
      activeRevisionId: null,
      activeRevision: null,
      cycle: { deadlineAt: new Date('2026-07-27T20:30:00.000Z') },
    };
    const dailyPracticeDay = {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createdDay),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const transaction = {
      dailyPracticeSettings: {
        findUnique: jest.fn().mockResolvedValue({
          enabled: true,
          revision: 2,
          reason: null,
        }),
      },
      dailyPracticeServicePause: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          status: AccountStatus.ACTIVE,
        }),
      },
      userPracticeProfile: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({
          stateRevision: 7,
          initializationStatus: 'READY',
          attemptCount: 3,
        }),
      },
      quizAttempt: { count: jest.fn().mockResolvedValue(3) },
      dailyPracticeSuggestion: { findUnique: jest.fn().mockResolvedValue(null) },
      dailyPracticeCycle: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cycle-1',
          status: DailyPracticeCycleStatus.READY,
          deadlineAt: new Date('2026-07-27T20:30:00.000Z'),
          progressSetHash: 'a'.repeat(64),
          poolStats: { frozenFixedQuestions: [{ questionId: 'fixed-1' }] },
          counts: { finalizedAt: '2026-07-27T20:30:00.000Z' },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      dailyPracticeDay,
    };
    const prisma = {
      ...transaction,
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };
    const { service } = createService(prisma);

    try {
      await expect(service.today(member)).resolves.toMatchObject({
        dayId: 'day-supplemental',
        status: 'GENERATING',
        supplemental: true,
      });
    } finally {
      jest.useRealTimers();
    }

    expect(dailyPracticeDay.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          cycleId: 'cycle-1',
          userId: 'member-1',
          scheduledAt: now,
          deadlineAt: new Date(now.getTime() + 30 * 60_000),
          fixedQuestionSnapshot: [{ questionId: 'fixed-1' }],
        }),
      ],
      skipDuplicates: true,
    });
    expect(transaction.dailyPracticeCycle.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: DailyPracticeCycleStatus.GENERATING,
          counts: {},
        }),
      }),
    );
  });
});

describe('DailyPracticeService history contract', () => {
  it('reports personalized and administrator-fixed question counts separately', async () => {
    const prisma = {
      dailyPracticePlanRevision: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'revision-1',
            generationSource: 'DETERMINISTIC',
            generatedAt: new Date('2026-07-28T04:05:00.000Z'),
            summarySnapshot: null,
            quizAttempt: null,
            day: {
              practiceDate: new Date('2026-07-28T00:00:00.000Z'),
              status: DailyPracticeDayStatus.READY,
            },
            items: [
              { source: DailyPracticePlanItemSource.PERSONALIZED },
              { source: DailyPracticePlanItemSource.ADMIN_FIXED },
            ],
          },
        ]),
      },
    };
    const { service } = createService(prisma);

    const result = await service.history(member, { page: 1, pageSize: 20 });

    expect(result.items[0]).toMatchObject({
      questionCount: 1,
      fixedQuestionCount: 1,
    });
  });

  it('loads history detail only through the user-owned active revision and excludes previews', async () => {
    const prisma = {
      dailyPracticePlanRevision: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const { service } = createService(prisma);

    await expect(
      service.historyDetail(member, 'revision-preview'),
    ).rejects.toThrow('每日练习历史不存在');
    expect(prisma.dailyPracticePlanRevision.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'revision-preview',
          trigger: { not: DailyPracticePlanTrigger.ADMIN_PREVIEW },
          activeForDay: { is: { userId: 'member-1' } },
        },
      }),
    );
  });
});

describe('DailyPracticeService fixed and administrator controls', () => {
  it('rejects a teaching-progress revision whose effective date moves backwards', async () => {
    const latest = {
      id: 'progress-2',
      version: 2,
      effectivePracticeDate: new Date('2099-02-01T00:00:00.000Z'),
      nodes: [],
    };
    const transaction = {
      teachingProgress: {
        findFirst: jest.fn().mockResolvedValue(latest),
        create: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };
    const { service, audit } = createService(prisma);

    await expect(
      service.publishTeachingProgress(editor, {
        subjectId: 'subject-1',
        effectivePracticeDate: '2099-01-31',
        changeType: 'ADD',
        basedOnProgressId: latest.id,
        expectedVersion: latest.version,
        nodes: [],
      }),
    ).rejects.toMatchObject({
      response: {
        code: DAILY_PRACTICE_ERROR_CODES.progressConflict,
      },
    });
    expect(transaction.teachingProgress.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns a bounded fixed-assignment history with its full total', async () => {
    const assignment = {
      id: 'assignment-latest',
      practiceDate: new Date('2026-07-29T00:00:00.000Z'),
      revision: 51,
      basedOnAssignmentId: 'assignment-previous',
      assignmentHash: 'a'.repeat(64),
      note: null,
      publishedAt: new Date('2026-07-28T08:00:00.000Z'),
      publishedBy: null,
      questions: [],
    };
    const prisma = {
      dailyPracticeFixedAssignment: {
        count: jest.fn().mockResolvedValue(51),
        findMany: jest.fn().mockResolvedValue([assignment]),
      },
    };
    const { service } = createService(prisma);

    const result = await service.fixedAssignments('2026-07-29');

    expect(result.history).toHaveLength(1);
    expect(result.historyTotal).toBe(51);
    expect(prisma.dailyPracticeFixedAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it('paginates fixed-question candidates in SQL without an unbounded cross-chapter read', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ total: 42n }])
        .mockResolvedValueOnce([{ id: 'question-page-2' }]),
      quizQuestion: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'question-page-2',
            type: QuestionType.MULTIPLE,
            typeLabel: '多选题',
            subjectId: 'subject-1',
            subject: { name: '生理学' },
            chapters: [
              {
                chapter: {
                  id: 'chapter-1',
                  subjectId: 'subject-1',
                  name: '绪论',
                  slug: 'intro',
                  sortOrder: 1,
                },
              },
            ],
            prompt: '分页内题目',
            origin: QuizQuestionOrigin.MANUAL,
            pastPaperId: null,
          },
        ]),
      },
    };
    const { service } = createService(prisma);

    const result = await service.fixedQuestionCandidates({
      page: 2,
      pageSize: 1,
      chapterMatch: 'ANY',
      includeCrossChapter: false,
      pastPaper: 'ALL',
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.quizQuestion.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.quizQuestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['question-page-2'] } } }),
    );
    expect(result).toMatchObject({ total: 42, page: 2, pageSize: 1 });
    expect(result.items.map((item) => item.id)).toEqual(['question-page-2']);
  });

  it('rejects an AI-generated fixed assignment question', async () => {
    const transaction = {
      dailyPracticeCycle: { findUnique: jest.fn().mockResolvedValue(null) },
      dailyPracticeFixedAssignment: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      quizQuestion: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'question-ai',
            prompt: 'AI question',
            enabled: true,
            origin: QuizQuestionOrigin.AI_GENERATED,
            reviewStatus: QuizQuestionReviewStatus.APPROVED,
            reviewRevision: 1,
            subject: { active: true },
            chapters: [{ chapter: { active: true } }],
          },
        ]),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };
    const { service, audit } = createService(prisma);

    await expect(
      service.publishFixedAssignment(editor, {
        practiceDate: '2099-01-01',
        expectedRevision: 0,
        questionIds: ['question-ai'],
      }),
    ).rejects.toMatchObject({
      response: {
        code: DAILY_PRACTICE_ERROR_CODES.fixedQuestionInvalid,
      },
    });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects multiple short answers in an administrator fixed assignment', async () => {
    const questions = ['short-1', 'short-2'].map((id) => ({
      id, type: QuestionType.SHORT_ANSWER, enabled: true, origin: QuizQuestionOrigin.MANUAL,
      reviewStatus: QuizQuestionReviewStatus.APPROVED, subject: { active: true },
      chapters: [{ chapter: { active: true } }],
    }));
    const transaction = {
      dailyPracticeCycle: { findUnique: jest.fn().mockResolvedValue(null) },
      dailyPracticeFixedAssignment: { findFirst: jest.fn().mockResolvedValue(null) },
      quizQuestion: { findMany: jest.fn().mockResolvedValue(questions) },
    };
    const { service, audit } = createService({
      $transaction: jest.fn(async (work: (client: typeof transaction) => unknown) => work(transaction)),
    });
    await expect(service.publishFixedAssignment(editor, {
      practiceDate: '2099-01-01', expectedRevision: 0, questionIds: questions.map((question) => question.id),
    })).rejects.toMatchObject({ response: { code: DAILY_PRACTICE_ERROR_CODES.fixedQuestionInvalid } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('stores administrator-fixed question ordinals from one in published order', async () => {
    const questions = ['question-1', 'question-2'].map((id) => ({
      id,
      prompt: `Prompt ${id}`,
      enabled: true,
      origin: QuizQuestionOrigin.MANUAL,
      reviewStatus: QuizQuestionReviewStatus.APPROVED,
      reviewRevision: 2,
      subject: { active: true },
      chapters: [{ chapter: { active: true } }],
    }));
    const assignment = {
      id: 'assignment-1',
      practiceDate: new Date('2099-01-01T00:00:00.000Z'),
      revision: 1,
      basedOnAssignmentId: null,
      assignmentHash: 'a'.repeat(64),
      note: null,
      publishedAt: new Date('2098-12-01T00:00:00.000Z'),
      publishedBy: null,
      questions: [],
    };
    const transaction = {
      dailyPracticeCycle: { findUnique: jest.fn().mockResolvedValue(null) },
      dailyPracticeFixedAssignment: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: assignment.id, revision: 1 }),
      },
      quizQuestion: { findMany: jest.fn().mockResolvedValue(questions) },
    };
    const prisma = {
      ...transaction,
      dailyPracticeFixedAssignment: {
        ...transaction.dailyPracticeFixedAssignment,
        findUniqueOrThrow: jest.fn().mockResolvedValue(assignment),
      },
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };
    const { service } = createService(prisma);

    jest.mocked(loadEligiblePracticeQuestions).mockResolvedValueOnce(questions as never);
    await service.publishFixedAssignment(editor, {
      practiceDate: '2099-01-01',
      expectedRevision: 0,
      questionIds: questions.map(({ id }) => id),
    });

    expect(transaction.dailyPracticeFixedAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          questions: {
            createMany: {
              data: [
                expect.objectContaining({ questionId: 'question-1', ordinal: 1 }),
                expect.objectContaining({ questionId: 'question-2', ordinal: 2 }),
              ],
            },
          },
        }),
      }),
    );
  });

  it('allows repeated ADMIN suggestions while superseding prior active history', async () => {
    let sequence = 0;
    const transaction = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ id: 'member-1', status: AccountStatus.ACTIVE }]),
      dailyPracticeSuggestion: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'suggestion-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn(async () => ({ id: `suggestion-${++sequence}` })),
      },
      auditLog: { create: jest.fn() },
    };
    const prisma = {
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'member-1' }) },
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
      dailyPracticeSuggestion: {
        findUniqueOrThrow: jest.fn(
          async ({ where }: { where: { id: string } }) => ({
            id: where.id,
            targetPracticeDate: new Date('2099-01-01T00:00:00.000Z'),
            payload: {
              intensity: 'STANDARD',
              desiredQuestionCount: 5,
              focusSubjectIds: [],
              focusChapterIds: [],
            },
            status: 'PENDING',
            createdAt: new Date('2026-07-28T08:00:00.000Z'),
            submittedBy: { role: Role.ADMIN },
          }),
        ),
      },
    };
    const { service, audit } = createService(prisma);
    const dto = {
      targetPracticeDate: '2099-01-01',
      intensity: 'STANDARD' as const,
      desiredQuestionCount: 5,
      focusSubjectIds: [],
      focusChapterIds: [],
    };

    await expect(
      service.submitAdminSuggestion(admin, 'member-1', dto),
    ).resolves.toMatchObject({ id: 'suggestion-1' });
    await expect(
      service.submitAdminSuggestion(admin, 'member-1', dto),
    ).resolves.toMatchObject({ id: 'suggestion-2' });

    expect(transaction.dailyPracticeSuggestion.create).toHaveBeenCalledTimes(2);
    expect(
      transaction.dailyPracticeSuggestion.updateMany,
    ).toHaveBeenCalledTimes(2);
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('returns an explicit administrator detail projection without raw planning snapshots', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T04:00:00.000Z'));
    const candidateHash = 'a'.repeat(64);
    const fixedHash = 'b'.repeat(64);
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'member-1',
          displayName: '测试用户',
          role: Role.MEMBER,
          status: AccountStatus.ACTIVE,
          practiceProfile: {
            initializationStatus: 'READY',
            attemptCount: 3,
            stateRevision: 7,
          },
          _count: { quizAttempts: 3 },
        }),
      },
      dailyPracticeDay: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'day-1',
          practiceDate: new Date('2026-07-28T00:00:00.000Z'),
          status: DailyPracticeDayStatus.READY,
          profileRevision: 7,
          progressSetHash: candidateHash,
          candidateHash,
          activeRevisionId: null,
          activeRevision: null,
          candidateSnapshot: {
            rawModelInput: '不得返回的完整自由文本',
            studentNumber: 'sensitive-student-number',
            candidateQuestions: [
              {
                questionAlias: 'Q001',
                questionId: 'question-1',
                internalIdentity: 'secret-identity',
              },
            ],
            payload: {
              candidateQuestions: [
                {
                  questionAlias: 'Q001',
                  gradingType: QuestionType.MULTIPLE,
                  typeLabel: '多选题',
                  promptExcerpt: '允许展示的题干摘要',
                  knowledgeAliases: ['K001'],
                  chapterAliases: ['C001'],
                  priorityScore: 9,
                  fullPrompt: '不得返回的完整题干',
                },
              ],
            },
          },
          fixedQuestionSnapshot: [
            {
              questionId: 'fixed-1',
              ordinal: 1,
              gradingType: QuestionType.SINGLE,
              typeLabel: '单选题',
              promptExcerpt: '固定题摘要',
              subjectId: 'subject-1',
              subjectName: '生理学',
              chapterIds: ['chapter-1'],
              promptHash: fixedHash,
              correctAnswer: '不得返回的答案',
            },
          ],
          cycle: {
            fixedAssignmentId: 'assignment-1',
            frozenFixedAssignmentHash: fixedHash,
            poolStats: {
              invalidFixedQuestionIds: ['fixed-invalid'],
              privateDiagnostics: '不得返回的诊断',
            },
          },
        }),
      },
      userQuestionState: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(137),
      },
      userChapterState: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(129),
      },
      dailyPracticePlanRevision: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(61),
      },
      dailyPracticeSuggestion: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(70),
      },
    };
    const { service } = createService(prisma);

    let result: Awaited<ReturnType<typeof service.adminUserDetail>>;
    try {
      result = await service.adminUserDetail('member-1');
    } finally {
      jest.useRealTimers();
    }

    expect(Object.keys(result.todayPlan!).sort()).toEqual(
      [
        'candidateHash',
        'candidateQuestions',
        'dayId',
        'fixedAssignment',
        'fixedItems',
        'inputHash',
        'outputHash',
        'personalizedItems',
        'practiceDate',
        'profileRevision',
        'progressSetHash',
      ].sort(),
    );
    expect(result.todayPlan?.candidateQuestions).toEqual([
      {
        questionId: 'question-1',
        questionAlias: 'Q001',
        gradingType: QuestionType.MULTIPLE,
        typeLabel: '多选题',
        promptExcerpt: '允许展示的题干摘要',
        knowledgeAliases: ['K001'],
        chapterAliases: ['C001'],
        priorityScore: 9,
      },
    ]);
    expect(result.todayPlan?.fixedAssignment?.questions[0]).not.toHaveProperty(
      'correctAnswer',
    );
    expect(result).toMatchObject({
      knowledgeStates: [],
      knowledgeStatesTotal: 137,
      chapterStates: [],
      chapterStatesTotal: 129,
      planRevisions: [],
      planRevisionsTotal: 61,
      suggestions: [],
      suggestionsTotal: 70,
    });
    expect(prisma.userQuestionState.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
    expect(prisma.userChapterState.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
    expect(prisma.dailyPracticePlanRevision.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
    expect(prisma.dailyPracticeSuggestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
    const serialized = JSON.stringify(result.todayPlan);
    for (const forbidden of [
      'candidateSnapshot',
      'fixedQuestionSnapshot',
      'rawModelInput',
      '不得返回的完整自由文本',
      'sensitive-student-number',
      'secret-identity',
      '不得返回的完整题干',
      '不得返回的答案',
      '不得返回的诊断',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('DailyPracticeService anonymous cycle aggregate', () => {
  it('constructs an explicit aggregate without identity or per-user arrays', async () => {
    const prisma = {
      dailyPracticeCycle: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cycle-1',
          practiceDate: new Date('2026-07-28T00:00:00.000Z'),
          status: DailyPracticeCycleStatus.READY,
          baselineAt: new Date('2026-07-27T20:00:00.000Z'),
          deadlineAt: new Date('2026-07-27T20:30:00.000Z'),
          progressSetHash: 'c'.repeat(64),
          progressSnapshot: [
            {
              subjectId: 'subject-1',
              title: '节点甲',
              breadcrumb: '章/节/甲',
              documentId: 'doc-1',
              nodePathHash: 'ph-1',
              firstTaughtDate: '2026-07-20',
            },
            {
              subjectId: 'subject-1',
              title: '节点乙',
              breadcrumb: '章/节/乙',
              documentId: 'doc-new',
              remappedFromDocumentId: 'doc-old',
              firstTaughtDate: '2026-07-21',
            },
          ],
          poolStats: {
            gapSummary: [
              {
                subjectId: 'subject-1',
                subject: '遗传学',
                nodeCount: 10,
                eligibleQuestionCount: 20,
              },
            ],
            invalidFixedQuestionIds: ['fixed-invalid'],
            candidateQuestionCount: 30,
            candidateTypeCounts: { SINGLE: 30 },
            unresolvedProgressNodeCount: 0,
          },
          refreezeRequestedAt: new Date('2026-07-28T01:00:00.000Z'),
        }),
      },
      dailyPracticeDay: {
        groupBy: jest.fn().mockResolvedValue([
          { status: DailyPracticeDayStatus.READY, _count: { _all: 8 } },
          { status: DailyPracticeDayStatus.PROCESSING, _count: { _all: 2 } },
        ]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ generationSource: 'PRO_MAX', total: 8n }])
        .mockResolvedValueOnce([{ p50: 1000, p95: 2500 }])
        .mockResolvedValueOnce([
          { calls: 8n, inputTokens: 1200n, outputTokens: 300n },
        ]),
    };
    const { service } = createService(prisma);

    const result = await service.cycleAggregate('2026-07-28');

    expect(result).toEqual(
      expect.objectContaining({
        totalUsers: 10,
        progressPercent: 80,
        statusCounts: { READY: 8, PROCESSING: 2 },
        generationCounts: { PRO_MAX: 8 },
        gapSummary: [
          {
            subjectId: 'subject-1',
            subject: '遗传学',
            nodeCount: 10,
            eligibleQuestionCount: 20,
          },
        ],
        invalidFixedQuestionCount: 1,
        progressSetHash: 'c'.repeat(64),
        refreezeRequestedAt: '2026-07-28T01:00:00.000Z',
        pool: {
          progressNodeCount: 2,
          candidateQuestionCount: 30,
          candidateTypeCounts: { SINGLE: 30 },
          unresolvedProgressNodeCount: 0,
          remappedProgressNodeCount: 1,
          remappedNodes: [
            {
              subjectId: 'subject-1',
              title: '节点乙',
              breadcrumb: '章/节/乙',
              documentId: 'doc-new',
              remappedFromDocumentId: 'doc-old',
              firstTaughtDate: '2026-07-21',
            },
          ],
        },
      }),
    );
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'userId',
      'displayName',
      'studentNumber',
      'dayId',
      'planRevisionId',
      'suggestion',
      'summarySnapshot',
      'candidateSnapshot',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(result).sort()).toEqual(
      [
        'baselineAt',
        'deadlineAt',
        'gapSummary',
        'generationCounts',
        'invalidFixedQuestionCount',
        'latencyMs',
        'pool',
        'practiceDate',
        'progressPercent',
        'progress',
        'progressSetHash',
        'refreezeRequestedAt',
        'status',
        'statusCounts',
        'totalUsers',
        'usage',
      ].sort(),
    );
  });
});

describe('DailyPracticeService current access progress', () => {
  it('includes missing test users and excludes stale or failed plans from availability', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-25T09:00:00Z'));
    try {
      const prisma = {
        dailyPracticeSettings: { findUniqueOrThrow: jest.fn().mockResolvedValue({ enabled: false, internalTestUserIds: ['a', 'b', 'c', 'd'] }) },
        user: { count: jest.fn().mockResolvedValue(4) },
        dailyPracticeCycle: { findUnique: jest.fn().mockResolvedValue({
          id: 'cycle', practiceDate: new Date('2026-09-25T00:00:00Z'), status: 'GENERATING',
          baselineAt: new Date('2026-09-25T08:55:00Z'), deadlineAt: new Date('2026-09-25T09:25:00Z'),
          progressSnapshot: [], poolStats: {}, refreezeRequestedAt: null,
        }) },
        dailyPracticeDay: {
          groupBy: jest.fn().mockResolvedValue([{ status: 'STALE', _count: { _all: 1 } }, { status: 'FAILED', _count: { _all: 1 } }]),
          findFirst: jest.fn().mockResolvedValue({ scheduledAt: new Date('2026-09-25T09:08:00Z') }),
        },
        $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      };
      const { service } = createService(prisma);
      const result = await service.cycleAggregate('2026-09-25');
      expect(result).toMatchObject({ totalUsers: 4, progressPercent: 0, progress: {
        scope: 'CURRENT_ACCESS', enqueuedUsers: 2, missingUsers: 2, availableUsers: 0,
        aiReadyUsers: 0, fallbackReadyUsers: 0, nextScheduledAt: '2026-09-25T09:08:00.000Z',
      } });
      expect(prisma.dailyPracticeDay.groupBy).toHaveBeenCalledWith(expect.objectContaining({
        where: { cycleId: 'cycle', user: { status: 'ACTIVE', id: { in: ['a', 'b', 'c', 'd'] } } },
      }));
      const generationSql = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(generationSql.values).not.toContain('STALE');
      expect(generationSql.values).not.toContain('FAILED');
      expect(generationSql.sql).toContain('DailyPracticePlanItem');
      expect((prisma.$queryRaw.mock.calls[2][0] as Prisma.Sql).sql).toContain('invocation.correlationId = revision.id');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('DailyPracticeService curriculum suggestion scope', () => {
  it('allows an eligible chapter without consulting knowledge sources', async () => {
    const topic = { id: 'topic-1', title: '细胞', sessionDates: ['2099-01-01'], sourceRefs: [], paused: false, taughtOnOverride: null };
    jest.mocked(loadPracticeCourses).mockResolvedValueOnce([{
      id: 'course-1', subjectId: 'subject-1', subjectName: 'MCG', termKey: 'test',
      startDate: '2099-01-01', examDate: '2099-03-01', enabled: true, revision: 1,
      topicHash: 'hash', topics: [topic],
    }]);
    jest.mocked(loadEligiblePracticeQuestions).mockResolvedValueOnce([{
      subjectId: 'subject-1', chapters: [{ chapterId: 'chapter-1' }],
    }] as never);
    const client = { teachingProgress: { findMany: jest.fn() } };
    const { service } = createService({});
    await (service as unknown as { validateSuggestionScope(client: unknown, payload: unknown, date: string): Promise<void> })
      .validateSuggestionScope(client, { focusSubjectIds: ['subject-1'], focusChapterIds: ['chapter-1'] }, '2099-02-01');
    expect(client.teachingProgress.findMany).not.toHaveBeenCalled();
  });

  it('rejects a suggested subject outside the active curriculum', async () => {
    jest.mocked(loadPracticeCourses).mockResolvedValueOnce([]);
    const { service } = createService({});
    await expect((service as unknown as { validateSuggestionScope(client: unknown, payload: unknown, date: string): Promise<void> })
      .validateSuggestionScope({}, { focusSubjectIds: ['other-subject'], focusChapterIds: [] }, '2099-02-01'))
      .rejects.toMatchObject({ response: { code: DAILY_PRACTICE_ERROR_CODES.suggestionOutOfScope } });
  });
});

describe('DailyPracticeService teaching progress effective date boundary', () => {
  const selectedNode = {
    id: 'kn-1',
    parentId: null,
    level: 2,
    title: '细胞',
    breadcrumb: '第一章/细胞',
    pathHash: 'ph-1',
    documentVersionId: 'dv-1',
    documentVersion: {
      contentHash: 'ch-1',
      indexStatus: 'READY',
      renderStatus: 'READY',
      document: {
        id: 'doc-1',
        subjectId: 'subject-1',
        libraryId: 'lib-1',
        activeVersionId: 'dv-1',
        kind: 'MARKDOWN',
        status: 'PUBLISHED',
        indexStatus: 'READY',
        deletedAt: null,
        subject: { active: true },
        library: { scope: 'SHARED', active: true, deletedAt: null },
      },
    },
  };

  function createPublishPrisma() {
    const transaction = {
      teachingProgress: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockResolvedValue({ id: 'progress-1', version: 1 }),
      },
      knowledgeNode: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([selectedNode])
          .mockResolvedValueOnce([selectedNode]),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
      teachingProgress: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'progress-1',
          subjectId: 'subject-1',
          version: 1,
          effectivePracticeDate: new Date('2026-07-28T00:00:00.000Z'),
          changeType: 'INITIAL',
          note: null,
          correctionReason: null,
          scopeHash: 'a'.repeat(64),
          basedOnProgressId: null,
          publishedAt: new Date('2026-07-28T01:00:00.000Z'),
          subject: { id: 'subject-1', name: '生理学', slug: 'physiology' },
          publishedBy: null,
          _count: { nodes: 0 },
          nodes: [],
        }),
      },
    };
    return { prisma, transaction };
  }

  it('accepts an effective practice date equal to the current practice date', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const { prisma, transaction } = createPublishPrisma();
    const { service, audit } = createService(prisma);

    try {
      await service.publishTeachingProgress(editor, {
        subjectId: 'subject-1',
        effectivePracticeDate: '2026-07-28',
        changeType: 'INITIAL',
        expectedVersion: 0,
        nodes: [{ knowledgeNodeId: 'kn-1', firstTaughtDate: '2026-07-28' }],
      });
    } finally {
      jest.useRealTimers();
    }

    expect(transaction.teachingProgress.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          effectivePracticeDate: new Date('2026-07-28T00:00:00.000Z'),
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('rejects an effective practice date before the current practice date', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const { prisma, transaction } = createPublishPrisma();
    const { service, audit } = createService(prisma);

    try {
      await expect(
        service.publishTeachingProgress(editor, {
          subjectId: 'subject-1',
          effectivePracticeDate: '2026-07-27',
          changeType: 'INITIAL',
          expectedVersion: 0,
          nodes: [{ knowledgeNodeId: 'kn-1', firstTaughtDate: '2026-07-27' }],
        }),
      ).rejects.toMatchObject({
        response: {
          code: DAILY_PRACTICE_ERROR_CODES.progressConflict,
          message: '教学进度最早只能从 2026-07-28 练习日生效',
        },
      });
    } finally {
      jest.useRealTimers();
    }

    expect(transaction.teachingProgress.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('DailyPracticeService teaching node remap', () => {
  const progressRecord = {
    id: 'progress-1',
    subjectId: 'subject-1',
    version: 1,
    effectivePracticeDate: new Date('2026-07-28T00:00:00.000Z'),
    changeType: 'INITIAL',
    note: null,
    correctionReason: null,
    scopeHash: 'a'.repeat(64),
    basedOnProgressId: null,
    publishedAt: new Date('2026-07-27T08:00:00.000Z'),
    subject: { id: 'subject-1', name: '生理学', slug: 'physiology' },
    publishedBy: null,
    _count: { nodes: 1 },
    nodes: [
      {
        id: 'tpn-1',
        libraryId: 'lib-1',
        documentId: 'doc-old',
        nodePathHash: 'ph-1',
        titleSnapshot: '旧标题',
        breadcrumbSnapshot: '旧路径',
        firstTaughtDate: new Date('2026-07-20T00:00:00.000Z'),
      },
    ],
  };

  function createRemapPrisma(
    replacements: Array<{
      id: string;
      libraryId: string;
      activeVersion: {
        nodes: Array<{
          id: string;
          pathHash: string;
          title: string;
          breadcrumb: string;
        }>;
      };
    }>,
  ) {
    return {
      teachingProgress: {
        findUnique: jest.fn().mockResolvedValue(progressRecord),
      },
      knowledgeNode: { findMany: jest.fn().mockResolvedValue([]) },
      knowledgeDocument: {
        findMany: jest.fn().mockResolvedValue(replacements),
      },
      quizQuestion: { findMany: jest.fn().mockResolvedValue([]) },
    };
  }

  it('remaps a node to the single replacement document in the same library', async () => {
    const prisma = createRemapPrisma([
      {
        id: 'doc-new',
        libraryId: 'lib-1',
        activeVersion: {
          nodes: [
            {
              id: 'kn-new',
              pathHash: 'ph-1',
              title: '新标题',
              breadcrumb: '新路径',
            },
          ],
        },
      },
    ]);
    const { service } = createService(prisma);

    const result = await service.teachingProgressDetail('progress-1');

    expect(result.nodes[0]).toMatchObject({
      resolved: true,
      remapped: true,
      resolvedDocumentId: 'doc-new',
      currentKnowledgeNodeId: 'kn-new',
      title: '新标题',
      breadcrumb: '新路径',
    });
    expect(result.unresolvedNodeCount).toBe(0);
    expect(prisma.knowledgeDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          libraryId: { in: ['lib-1'] },
          subjectId: 'subject-1',
          kind: 'MARKDOWN',
        }),
      }),
    );
  });

  it('keeps a node unresolved when two replacement documents match', async () => {
    const replacement = (id: string) => ({
      id,
      libraryId: 'lib-1',
      activeVersion: {
        nodes: [
          {
            id: `kn-${id}`,
            pathHash: 'ph-1',
            title: '新标题',
            breadcrumb: '新路径',
          },
        ],
      },
    });
    const prisma = createRemapPrisma([
      replacement('doc-new-a'),
      replacement('doc-new-b'),
    ]);
    const { service } = createService(prisma);

    const result = await service.teachingProgressDetail('progress-1');

    expect(result.nodes[0]).toMatchObject({
      resolved: false,
      remapped: false,
      resolvedDocumentId: null,
      currentKnowledgeNodeId: null,
      title: '旧标题',
    });
    expect(result.unresolvedNodeCount).toBe(1);
  });
});

describe('DailyPracticeService eligible question counting', () => {
  function createEligiblePrisma(questions: Array<unknown>) {
    return {
      teachingProgress: {
        findUnique: jest.fn().mockResolvedValue({
          subjectId: 'subject-1',
          nodes: [
            { libraryId: 'lib-1', documentId: 'doc-old', nodePathHash: 'ph-1' },
          ],
        }),
      },
      knowledgeNode: { findMany: jest.fn().mockResolvedValue([]) },
      knowledgeDocument: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'doc-new',
            libraryId: 'lib-1',
            activeVersion: {
              nodes: [
                {
                  id: 'kn-new',
                  pathHash: 'ph-1',
                  title: '新标题',
                  breadcrumb: '新路径',
                },
              ],
            },
          },
        ]),
      },
      quizQuestion: { findMany: jest.fn().mockResolvedValue(questions) },
    };
  }

  async function countEligible(
    service: DailyPracticeService,
  ): Promise<number> {
    return (
      service as unknown as {
        eligibleQuestionCountForProgress(progressId: string): Promise<number>;
      }
    ).eligibleQuestionCountForProgress('progress-1');
  }

  it('counts questions whose sources resolve through the remapped document', async () => {
    const prisma = createEligiblePrisma([
      {
        id: 'question-1',
        sourceRevision: 3,
        knowledgeSources: [
          {
            documentId: 'doc-new',
            nodePathHash: null,
            sourceRevision: 3,
            knowledgeNode: { pathHash: 'ph-1' },
          },
        ],
      },
      {
        id: 'question-2',
        sourceRevision: 4,
        knowledgeSources: [
          {
            documentId: 'doc-new',
            nodePathHash: 'ph-1',
            sourceRevision: 2,
            knowledgeNode: null,
          },
        ],
      },
    ]);
    const { service } = createService(prisma);

    await expect(countEligible(service)).resolves.toBe(1);

    const where = prisma.quizQuestion.findMany.mock.calls[0]![0] as {
      where: {
        knowledgeSources: {
          some: { OR: Array<Record<string, unknown>> };
        };
      };
    };
    expect(where.where.knowledgeSources.some.OR).toEqual([
      {
        documentId: 'doc-new',
        OR: [
          { nodePathHash: 'ph-1' },
          { nodePathHash: null, knowledgeNode: { pathHash: 'ph-1' } },
        ],
      },
    ]);
  });

  it('returns zero without querying questions when the node stays unresolved', async () => {
    const prisma = createEligiblePrisma([]);
    prisma.knowledgeDocument.findMany.mockResolvedValue([]);
    const { service } = createService(prisma);

    await expect(countEligible(service)).resolves.toBe(0);
    expect(prisma.quizQuestion.findMany).not.toHaveBeenCalled();
  });
});

describe('DailyPracticeService cycle refreeze requests', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects a non-current practice date with a conflict', async () => {
    const prisma = {
      dailyPracticeCycle: {
        findUnique: jest.fn(),
      },
      dailyPracticeDay: { count: jest.fn() },
      $transaction: jest.fn(),
    };
    const { service } = createService(prisma);

    for (const practiceDate of ['2026-07-27', '2026-07-29']) {
      await expect(
        service.requestCycleRefreeze(admin, practiceDate),
      ).rejects.toMatchObject({
        response: {
          code: DAILY_PRACTICE_ERROR_CODES.cycleRefreezeDateConflict,
        },
      });
    }
    expect(prisma.dailyPracticeCycle.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an unknown practice date with a 404', async () => {
    const prisma = {
      dailyPracticeCycle: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const { service } = createService(prisma);

    await expect(
      service.requestCycleRefreeze(admin, '2026-07-28'),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects a cycle whose days all started or completed', async () => {
    const prisma = {
      dailyPracticeCycle: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cycle-1',
          status: DailyPracticeCycleStatus.READY,
        }),
      },
      dailyPracticeDay: { count: jest.fn().mockResolvedValue(0) },
    };
    const { service } = createService(prisma);

    await expect(
      service.requestCycleRefreeze(admin, '2026-07-28'),
    ).rejects.toMatchObject({
      response: {
        code: DAILY_PRACTICE_ERROR_CODES.cycleNoRebuildableDays,
      },
    });
  });

  it('claims the refreeze once and reports later calls as already requested', async () => {
    const transaction = {
      dailyPracticeCycle: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          refreezeRequestedAt: new Date('2026-07-27T12:00:00.000Z'),
        }),
      },
    };
    const prisma = {
      dailyPracticeCycle: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cycle-1',
          status: DailyPracticeCycleStatus.READY,
        }),
      },
      dailyPracticeDay: { count: jest.fn().mockResolvedValue(3) },
      $transaction: jest.fn(
        async (work: (client: typeof transaction) => unknown) =>
          work(transaction),
      ),
    };
    const { service, audit } = createService(prisma);

    const first = await service.requestCycleRefreeze(admin, '2026-07-28');
    expect(first).toMatchObject({
      practiceDate: '2026-07-28',
      status: DailyPracticeCycleStatus.READY,
      rebuildableDayCount: 3,
      alreadyRequested: false,
    });
    expect(first.refreezeRequestedAt).toEqual(expect.any(String));
    expect(transaction.dailyPracticeCycle.updateMany).toHaveBeenCalledWith({
      where: { id: 'cycle-1', refreezeRequestedAt: null },
      data: {
        refreezeRequestedAt: expect.any(Date),
        refreezeRequestedById: 'admin-1',
      },
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      'admin-1',
      'daily-practice.cycle.refreeze',
      'DailyPracticeCycle',
      'cycle-1',
      expect.objectContaining({
        practiceDate: '2026-07-28',
        rebuildableDayCount: 3,
      }),
      transaction,
    );

    const second = await service.requestCycleRefreeze(admin, '2026-07-28');
    expect(second).toMatchObject({
      practiceDate: '2026-07-28',
      rebuildableDayCount: 3,
      alreadyRequested: true,
      refreezeRequestedAt: '2026-07-27T12:00:00.000Z',
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});

describe('DailyPracticeService cycle listing', () => {
  it('defaults to the last fourteen practice dates and parses pool stats defensively', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const prisma = {
      dailyPracticeCycle: {
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([
          {
            practiceDate: new Date('2026-07-28T00:00:00.000Z'),
            status: DailyPracticeCycleStatus.GENERATING,
            baselineAt: new Date('2026-07-27T20:00:00.000Z'),
            deadlineAt: new Date('2026-07-27T20:30:00.000Z'),
            refreezeRequestedAt: new Date('2026-07-28T01:00:00.000Z'),
            counts: {
              activeUsers: 10,
              createdDays: 10,
              terminalUsers: 4,
              statusCounts: { READY: 4, PENDING: 6 },
            },
            poolStats: {
              candidateQuestionCount: 42,
              unresolvedProgressNodeCount: 1,
              remappedProgressNodeCount: 2,
              invalidFixedQuestionIds: ['question-invalid'],
              frozenFixedQuestions: [
                { questionId: 'question-1' },
                { questionId: 'question-2' },
              ],
              gapSummary: [{ subjectId: 'subject-1' }],
            },
          },
          {
            practiceDate: new Date('2026-07-27T00:00:00.000Z'),
            status: DailyPracticeCycleStatus.READY,
            baselineAt: new Date('2026-07-26T20:00:00.000Z'),
            deadlineAt: new Date('2026-07-26T20:30:00.000Z'),
            refreezeRequestedAt: null,
            counts: null,
            poolStats: null,
          },
        ]),
      },
    };
    const { service } = createService(prisma);

    let result: Awaited<ReturnType<typeof service.listCycles>>;
    try {
      result = await service.listCycles({ page: 1, pageSize: 20 });
    } finally {
      jest.useRealTimers();
    }

    expect(prisma.dailyPracticeCycle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          practiceDate: {
            gte: new Date('2026-07-15T00:00:00.000Z'),
            lte: new Date('2026-07-28T00:00:00.000Z'),
          },
        },
        orderBy: { practiceDate: 'desc' },
        skip: 0,
        take: 20,
      }),
    );
    expect(result).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(result.items[0]).toEqual({
      practiceDate: '2026-07-28',
      status: DailyPracticeCycleStatus.GENERATING,
      baselineAt: '2026-07-27T20:00:00.000Z',
      deadlineAt: '2026-07-27T20:30:00.000Z',
      refreezeRequestedAt: '2026-07-28T01:00:00.000Z',
      activeUsers: 10,
      createdDays: 10,
      terminalUsers: 4,
      statusCounts: { READY: 4, PENDING: 6 },
      pool: {
        candidateQuestionCount: 42,
        unresolvedProgressNodeCount: 1,
        remappedProgressNodeCount: 2,
        invalidFixedQuestionCount: 1,
        fixedQuestionCount: 2,
        gapCount: 1,
      },
    });
    expect(result.items[1]).toEqual({
      practiceDate: '2026-07-27',
      status: DailyPracticeCycleStatus.READY,
      baselineAt: '2026-07-26T20:00:00.000Z',
      deadlineAt: '2026-07-26T20:30:00.000Z',
      refreezeRequestedAt: null,
      activeUsers: 0,
      createdDays: 0,
      terminalUsers: 0,
      statusCounts: {},
      pool: {
        candidateQuestionCount: 0,
        unresolvedProgressNodeCount: 0,
        remappedProgressNodeCount: 0,
        invalidFixedQuestionCount: 0,
        fixedQuestionCount: 0,
        gapCount: 0,
      },
    });
  });

  it('rejects a semantically invalid range boundary', async () => {
    const prisma = {
      dailyPracticeCycle: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
    };
    const { service } = createService(prisma);

    await expect(
      service.listCycles({ page: 1, pageSize: 20, from: '2026-13-01' }),
    ).rejects.toMatchObject({
      response: { code: DAILY_PRACTICE_ERROR_CODES.noContent },
    });
    expect(prisma.dailyPracticeCycle.findMany).not.toHaveBeenCalled();
  });
});
