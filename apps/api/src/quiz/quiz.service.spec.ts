import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  applySubmittedAttemptState,
  assertDailyQuestionEligibility,
  lockUserPracticeProfile,
} from '@bmc3/daily-practice-prisma';
import {
  DailyPracticeDayStatus,
  DailyPracticePlanItemSource,
  DailyPracticePlanTrigger,
  QuestionType,
  QuizAttemptStatus,
  QuizQuestionCategory,
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
  QuizQuestionSourceReviewStatus,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { lockDailyPracticeSettings } from '../daily-practice/daily-practice-gate';
import {
  QuestionSnapshot,
  QuizService,
  scoreSnapshot,
  validateAnswers,
} from './quiz.service';

jest.mock('@bmc3/daily-practice-prisma', () => ({
  assertDailyQuestionEligibility: jest.fn().mockResolvedValue(true),
  lockUserPracticeProfile: jest.fn().mockResolvedValue(undefined),
  applySubmittedAttemptState: jest.fn().mockResolvedValue({
    applied: true,
    stateRevision: 1,
    questionCount: 1,
    knowledgeStateCount: 0,
    chapterStateCount: 1,
  }),
}));

jest.mock('../daily-practice/daily-practice-gate', () => ({
  lockDailyPracticeSettings: jest.fn().mockResolvedValue(undefined),
}));

const mockedApplySubmittedAttemptState = jest.mocked(
  applySubmittedAttemptState,
);
const mockedLockUserPracticeProfile = jest.mocked(lockUserPracticeProfile);
const mockedLockDailyPracticeSettings = jest.mocked(lockDailyPracticeSettings);
const mockedAssertDailyQuestionEligibility = jest.mocked(assertDailyQuestionEligibility);

function snapshot(overrides: Partial<QuestionSnapshot> = {}): QuestionSnapshot {
  return {
    id: 'q1',
    type: QuestionType.MULTIPLE,
    typeLabel: '多选题',
    subject: { id: 'subject-1', name: '生理学', slug: 'physiology' },
    chapters: [
      {
        id: 'chapter-1',
        subjectId: 'subject-1',
        name: '绪论',
        slug: 'introduction',
      },
    ],
    category: QuizQuestionCategory.STANDARD,
    origin: QuizQuestionOrigin.MANUAL,
    prompt: '选择正确选项',
    options: [
      { id: 'a', text: 'A' },
      { id: 'b', text: 'B' },
      { id: 'c', text: 'C' },
    ],
    correctAnswer: ['a', 'c'],
    images: [],
    pastPaper: null,
    paperOrder: null,
    maxScore: 1,
    explanation: '解析',
    ...overrides,
  };
}

describe('scoreSnapshot', () => {
  it('scores multiple-choice answers independent of order', async () => {
    const result = await scoreSnapshot([snapshot()], { q1: ['c', 'a'] });
    expect(result).toMatchObject({ score: 1, total: 1 });
  });

  it('does not award a point for a partial objective answer', async () => {
    const result = await scoreSnapshot([snapshot()], { q1: ['a'] });
    expect(result.score).toBe(0);
  });

  it('uses rubric criterion scores for short answers', async () => {
    const grader = {
      grade: jest.fn().mockResolvedValue({
        model: 'deepseek-v4-flash',
        feedback: '第二点需要补充。',
        criterionScores: [
          { criterionIndex: 0, awardedPoints: 2, reason: '已答出' },
          { criterionIndex: 1, awardedPoints: 0, reason: '未答出' },
        ],
      }),
    };
    const question = snapshot({
      type: QuestionType.SHORT_ANSWER,
      options: [],
      correctAnswer: ['参考答案'],
      gradingRubric: {
        criteria: [
          { description: '要点一', points: 2 },
          { description: '要点二', points: 1 },
        ],
      },
      maxScore: 3,
    });

    const result = await scoreSnapshot(
      [question],
      { q1: ['学生答案'] },
      grader,
    );

    expect(result).toMatchObject({ score: 2, total: 3 });
    expect(result.results[0]).toMatchObject({
      correct: false,
      score: 2,
      maxScore: 3,
      gradingModel: 'deepseek-v4-flash',
    });
    expect(grader.grade).toHaveBeenCalledWith(
      expect.objectContaining({ studentAnswer: '学生答案' }),
    );
  });

  it('does not call the model for an unanswered short answer', async () => {
    const grader = { grade: jest.fn() };
    const question = snapshot({
      type: QuestionType.SHORT_ANSWER,
      options: [],
      correctAnswer: ['参考答案'],
      gradingRubric: { criteria: [{ description: '要点', points: 2 }] },
      maxScore: 2,
    });

    const result = await scoreSnapshot([question], {}, grader);

    expect(result).toMatchObject({ score: 0, total: 2 });
    expect(grader.grade).not.toHaveBeenCalled();
  });
});

describe('validateAnswers', () => {
  it('rejects answers for questions outside the attempt snapshot', () => {
    expect(() => validateAnswers([snapshot()], { forged: ['a'] })).toThrow(
      BadRequestException,
    );
  });

  it('trims a short answer while preserving it as one text value', () => {
    const question = snapshot({ type: QuestionType.SHORT_ANSWER, options: [] });
    expect(validateAnswers([question], { q1: ['  肺泡通气量  '] })).toEqual({
      q1: ['肺泡通气量'],
    });
  });
});

describe('QuizService attempt lifecycle', () => {
  it('returns 409 when a draft revision loses the compare-and-set race', async () => {
    const question = snapshot();
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      quizAttempt: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'attempt-1',
          userId: 'user-1',
          snapshot: { snapshotVersion: 2, questions: [question] },
        }),
        updateMany,
      },
    };
    const service = new QuizService(prisma as never, {} as never);

    await expect(
      service.saveDraft('user-1', 'attempt-1', 4, 0, { q1: ['a'] }),
    ).rejects.toThrow('草稿版本或状态已变化');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'attempt-1',
          userId: 'user-1',
          lifecycleStatus: QuizAttemptStatus.DRAFT,
          draftRevision: 4,
        }),
      }),
    );
  });

  it('reuses an in-flight submission only for the same normalized answers', async () => {
    const question = snapshot();
    const answers = { q1: ['a'] };
    const submissionHash = createHash('sha256')
      .update(
        JSON.stringify({
          snapshot: [question],
          answers,
        }),
        'utf8',
      )
      .digest('hex');
    const attempt = {
      id: 'attempt-1',
      userId: 'user-1',
      snapshot: { snapshotVersion: 2, questions: [question] },
      answers,
      lifecycleStatus: QuizAttemptStatus.SCORING,
      gradingLeasedUntil: new Date(Date.now() + 60_000),
      submissionHash,
      submittedAt: null,
      abandonedAt: null,
      savedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma = {
      quizAttempt: { findFirstOrThrow: jest.fn().mockResolvedValue(attempt) },
    };
    const service = new QuizService(prisma as never, {} as never);

    await expect(
      service.submit('user-1', 'attempt-1', answers),
    ).resolves.toEqual({
      attemptId: 'attempt-1',
      status: QuizAttemptStatus.SCORING,
      pending: true,
    });
    await expect(
      service.submit('user-1', 'attempt-1', { q1: ['b'] }),
    ).rejects.toThrow('评分开始后不能使用不同答案重新提交');
  });
});

describe('QuizService wrong-question index', () => {
  it('updates the attempt and increments only incorrect questions in one transaction', async () => {
    const questions = [
      snapshot({ id: 'q-wrong', origin: QuizQuestionOrigin.AI_GENERATED }),
      snapshot({ id: 'q-correct' }),
    ];
    const prisma = {
      quizAttempt: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'attempt-1',
          submittedAt: null,
          snapshot: { snapshotVersion: 2, questions },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quizWrongQuestion: {
        upsert: jest.fn().mockResolvedValue({ id: 'wrong-1' }),
      },
      quizWrongQuestionChapter: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    const result = await service.submit('user-1', 'attempt-1', {
      'q-wrong': ['b'],
      'q-correct': ['a', 'c'],
    });

    expect('score' in result).toBe(true);
    if (!('score' in result)) throw new Error('expected submitted result');
    expect(result.score).toBe(1);
    expect(mockedLockUserPracticeProfile).toHaveBeenCalledWith(
      prisma,
      'user-1',
    );
    expect(
      mockedLockUserPracticeProfile.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(
      prisma.quizAttempt.updateMany.mock.invocationCallOrder.at(-1)!,
    );
    expect(prisma.quizAttempt.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'attempt-1',
          userId: 'user-1',
          submittedAt: null,
        }),
      }),
    );
    expect(prisma.quizWrongQuestion.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.quizWrongQuestion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_questionId: { userId: 'user-1', questionId: 'q-wrong' },
        },
        create: expect.objectContaining({
          wrongCount: 1,
          lastWrongAnswer: null,
          lastFeedback: null,
        }),
        update: expect.objectContaining({
          wrongCount: { increment: 1 },
          lastWrongAnswer: null,
        }),
      }),
    );
    expect(prisma.quizWrongQuestionChapter.createMany).toHaveBeenCalledWith({
      data: [{ wrongQuestionId: 'wrong-1', chapterId: 'chapter-1' }],
      skipDuplicates: true,
    });
    expect(mockedApplySubmittedAttemptState).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        id: 'attempt-1',
        userId: 'user-1',
        dailyPracticePlanRevisionId: null,
      }),
      expect.any(Date),
    );
  });

  it('stores only the latest normalized wrong answer for short-answer questions', async () => {
    const question = snapshot({
      id: 'q-short',
      type: QuestionType.SHORT_ANSWER,
      typeLabel: '简答题',
      options: [],
      correctAnswer: ['参考答案'],
      gradingRubric: {
        criteria: [{ description: '核心要点', points: 2 }],
      },
      maxScore: 2,
    });
    const prisma = {
      quizAttempt: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'attempt-1',
          submittedAt: null,
          snapshot: { snapshotVersion: 2, questions: [question] },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quizWrongQuestion: {
        upsert: jest.fn().mockResolvedValue({ id: 'wrong-1' }),
      },
      quizWrongQuestionChapter: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const grader = {
      grade: jest.fn().mockResolvedValue({
        model: 'deepseek-v4-flash',
        feedback: '核心要点未答出。',
        criterionScores: [
          { criterionIndex: 0, awardedPoints: 0, reason: '未答出' },
        ],
      }),
    };
    const service = new QuizService(prisma as never, grader as never);

    await service.submit('user-1', 'attempt-1', {
      'q-short': ['  用户最近的错误答案  '],
    });

    expect(prisma.quizWrongQuestion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          lastWrongAnswer: '用户最近的错误答案',
        }),
        update: expect.objectContaining({
          lastWrongAnswer: '用户最近的错误答案',
        }),
      }),
    );
  });

  it('rolls back wrong-question updates when a duplicate submission loses the race', async () => {
    const question = snapshot();
    const prisma = {
      quizAttempt: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: 'attempt-1',
          submittedAt: null,
          snapshot: { snapshotVersion: 2, questions: [question] },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      quizWrongQuestion: { upsert: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    await expect(
      service.submit('user-1', 'attempt-1', { q1: ['b'] }),
    ).rejects.toThrow('答题状态已变化，请刷新后重试');
    expect(prisma.quizWrongQuestion.upsert).not.toHaveBeenCalled();
  });

  it('filters and paginates the materialized wrong-question index', async () => {
    const lastWrongAt = new Date('2026-07-24T08:00:00.000Z');
    const prisma = {
      subject: { findFirst: jest.fn().mockResolvedValue({ id: 'subject-1' }) },
      subjectChapter: { count: jest.fn().mockResolvedValue(2) },
      quizWrongQuestion: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'wrong-1',
            userId: 'user-1',
            questionId: 'q1',
            type: QuestionType.MULTIPLE,
            typeLabel: '多选题',
            subjectId: 'subject-1',
            category: QuizQuestionCategory.STANDARD,
            origin: QuizQuestionOrigin.MANUAL,
            prompt: '选择正确选项',
            crossChapter: true,
            isPastPaper: false,
            snapshot: snapshot(),
            wrongCount: 4,
            lastScore: 0,
            lastWrongAnswer: null,
            lastFeedback: null,
            lastCriterionScores: null,
            lastWrongAt,
            createdAt: lastWrongAt,
            updatedAt: lastWrongAt,
            chapters: [{ chapterId: 'chapter-1' }, { chapterId: 'chapter-2' }],
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new QuizService(prisma as never, {} as never);

    const result = await service.wrongQuestions('user-1', {
      subjectId: 'subject-1',
      chapterIds: ['chapter-1', 'chapter-2'],
      chapterMatch: 'ALL',
      includeCrossChapter: true,
      typeLabel: '多选题',
      source: 'NON_AI',
      search: '正确',
      page: 2,
      pageSize: 10,
    });

    expect(prisma.quizWrongQuestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          subjectId: 'subject-1',
          typeLabel: '多选题',
          origin: {
            in: [QuizQuestionOrigin.MANUAL, QuizQuestionOrigin.CSV],
          },
          prompt: { contains: '正确' },
          AND: [
            { chapters: { some: { chapterId: 'chapter-1' } } },
            { chapters: { some: { chapterId: 'chapter-2' } } },
          ],
        }),
        skip: 10,
        take: 10,
      }),
    );
    expect(result).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 10,
      items: [
        expect.objectContaining({
          id: 'q1',
          subject: '生理学',
          wrongCount: 4,
          lastWrongAt,
        }),
      ],
    });
  });
});

describe('QuizService.start', () => {
  it('applies subject, chapter, type, and non-AI source filters without exposing grading data', async () => {
    const question = {
      ...snapshot(),
      subjectId: 'subject-1',
      chapters: snapshot().chapters.map((chapter) => ({
        chapter: { ...chapter, sortOrder: 1 },
      })),
      gradingRubric: null,
      typeLabel: '病例分析题',
      pastPaperId: null,
      paperOrder: null,
      pastPaper: null,
      photos: [],
      enabled: true,
      authorId: 'author-1',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      subject: { findFirst: jest.fn().mockResolvedValue({ id: 'subject-1' }) },
      subjectChapter: { count: jest.fn().mockResolvedValue(1) },
      quizQuestion: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'q1' }])
          .mockResolvedValueOnce([question]),
      },
      quizAttempt: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ questionId: 'cross-1' }]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    const result = await service.start('user-1', 5, {
      subjectId: 'subject-1',
      chapterIds: ['chapter-1'],
      chapterMatch: 'ANY',
      types: [QuestionType.MULTIPLE],
      source: 'NON_AI',
    });

    expect(prisma.quizQuestion.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          subjectId: 'subject-1',
          type: { in: [QuestionType.MULTIPLE] },
          origin: {
            in: [QuizQuestionOrigin.MANUAL, QuizQuestionOrigin.CSV],
          },
          id: { notIn: ['cross-1'] },
          pastPaperId: null,
        }),
        select: { id: true },
      }),
    );
    expect(prisma.quizAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          snapshot: expect.objectContaining({ snapshotVersion: 2 }),
        }),
      }),
    );
    expect(result.questions[0]).not.toHaveProperty('correctAnswer');
    expect(result.questions[0]).not.toHaveProperty('gradingRubric');
    expect(result.questions[0]).not.toHaveProperty('explanation');
    expect(result.questions[0]).toMatchObject({
      gradingType: QuestionType.MULTIPLE,
      typeLabel: '病例分析题',
      isPastPaper: false,
    });
  });

  it('preserves selected question order and allows past-paper questions', async () => {
    const question = (id: string, pastPaperId: string | null) => ({
      ...snapshot({ id }),
      subjectId: 'subject-1',
      chapters: snapshot().chapters.map((chapter) => ({
        chapter: { ...chapter, sortOrder: 1 },
      })),
      typeLabel: '多选题',
      gradingRubric: null,
      enabled: true,
      authorId: 'author-1',
      pastPaperId,
      pastPaper: pastPaperId
        ? {
            id: pastPaperId,
            title: '2025 真题',
            subjectId: 'subject-1',
            subject: snapshot().subject,
            year: 2025,
          }
        : null,
      paperOrder: pastPaperId ? 1 : null,
      photos: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const prisma = {
      quizQuestion: {
        findMany: jest
          .fn()
          .mockResolvedValue([question('q2', 'paper-1'), question('q1', null)]),
      },
      quizAttempt: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'attempt-1' }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    const result = await service.start('user-1', undefined, {
      questionIds: ['q1', 'q2'],
    });

    expect(result.questions.map((item) => item.id)).toEqual(['q1', 'q2']);
    expect(prisma.quizQuestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['q1', 'q2'] },
          enabled: true,
        }),
      }),
    );
  });

  it('rejects duplicate selected question ids', async () => {
    const service = new QuizService({} as never, {} as never);
    await expect(
      service.start('user-1', undefined, { questionIds: ['q1', 'q1'] }),
    ).rejects.toThrow(BadRequestException);
  });

  it('resumes an existing AI-question daily attempt without reapplying new-question eligibility', async () => {
    mockedLockDailyPracticeSettings.mockClear();
    const prisma = {
      quizAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'attempt-daily',
          userId: 'user-1',
          snapshot: {
            snapshotVersion: 2,
            questions: [
              snapshot({
                origin: QuizQuestionOrigin.AI_GENERATED,
                knowledgeStateSources: [
                  {
                    documentId: 'document-1',
                    nodePathHash: 'a'.repeat(64),
                    currentKnowledgeNodeId: 'node-1',
                    subjectId: 'subject-1',
                    libraryId: 'library-1',
                  },
                ],
              }),
            ],
          },
        }),
      },
      $transaction: jest.fn(),
    };
    const service = new QuizService(prisma as never, {} as never);

    const result = await service.startDailyPractice('user-1', 'revision-1');

    expect(result).toMatchObject({ attemptId: 'attempt-daily' });
    expect(result.questions[0]).not.toHaveProperty('knowledgeStateSources');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mockedLockDailyPracticeSettings).not.toHaveBeenCalled();
  });

  it('refuses an unstarted daily plan when its curriculum or content revision is stale', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-24T04:00:00.000Z'));
    mockedAssertDailyQuestionEligibility.mockResolvedValueOnce(false);
    const prisma = {
      quizAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
      },
      dailyPracticeSettings: { findUnique: jest.fn().mockResolvedValue({ enabled: true }) },
      dailyPracticeServicePause: { findFirst: jest.fn().mockResolvedValue(null) },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }) },
      dailyPracticePlanRevision: { findFirst: jest.fn().mockResolvedValue({
        id: 'revision-stale', trigger: DailyPracticePlanTrigger.AUTO,
        publishedAt: new Date(),
        day: { id: 'day-1', practiceDate: new Date('2026-09-24T00:00:00.000Z'), activeRevisionId: 'revision-stale', status: DailyPracticeDayStatus.READY },
        items: [{ questionId: 'q1', questionContentRevision: null, source: DailyPracticePlanItemSource.PERSONALIZED }],
      }) },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(prisma as never));
    const service = new QuizService(prisma as never, {} as never);
    try {
      await expect(service.startDailyPractice('user-1', 'revision-stale')).rejects.toThrow('计划中的题目或教学范围已变化');
      expect(prisma.quizAttempt.create).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('creates a daily-practice attempt and marks the active day started atomically', async () => {
    mockedLockDailyPracticeSettings.mockClear();
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T04:00:00.000Z'));
    const base = snapshot({ origin: QuizQuestionOrigin.CSV });
    const question = {
      ...base,
      subjectId: 'subject-1',
      subject: base.subject,
      chapters: base.chapters.map((chapter) => ({
        chapter: { ...chapter, sortOrder: 1 },
      })),
      gradingRubric: null,
      typeLabel: '多选题',
      pastPaperId: null,
      paperOrder: null,
      pastPaper: null,
      photos: [],
      enabled: true,
      authorId: 'author-1',
      reviewStatus: QuizQuestionReviewStatus.APPROVED,
      reviewRevision: 3,
      contentRevision: 2,
      sourceRevision: 2,
      sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
      knowledgeSources: [
        {
          sourceRevision: 2,
          documentId: 'document-1',
          libraryId: 'library-1',
          nodePathHash: null,
          knowledgeNodeId: 'node-1',
          knowledgeNode: { pathHash: 'b'.repeat(64) },
          ordinal: 0,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      quizAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({
          id: 'attempt-daily',
          userId: 'user-1',
          snapshot: { snapshotVersion: 2, questions: [base] },
        }),
      },
      dailyPracticeSettings: {
        findUnique: jest.fn().mockResolvedValue({ enabled: true }),
      },
      dailyPracticeServicePause: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }) },
      dailyPracticePlanRevision: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'revision-1',
          trigger: DailyPracticePlanTrigger.AUTO,
          publishedAt: new Date(),
          day: {
            id: 'day-1',
            practiceDate: new Date('2026-07-28T00:00:00.000Z'),
            activeRevisionId: 'revision-1',
            status: DailyPracticeDayStatus.READY,
          },
          items: [
            {
              questionId: 'q1',
              source: DailyPracticePlanItemSource.PERSONALIZED,
              questionReviewRevision: 3,
              questionContentRevision: 2,
              sourceRevision: 2,
              question,
            },
          ],
        }),
      },
      quizQuestion: { count: jest.fn().mockResolvedValue(1) },
      dailyPracticeDay: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    try {
      await service.startDailyPractice('user-1', 'revision-1');
    } finally {
      jest.useRealTimers();
    }

    expect(prisma.quizAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          dailyPracticePlanRevisionId: 'revision-1',
          snapshot: expect.objectContaining({
            questions: [
              expect.objectContaining({
                id: 'q1',
                origin: QuizQuestionOrigin.CSV,
              }),
            ],
          }),
        }),
      }),
    );
    expect(mockedAssertDailyQuestionEligibility).toHaveBeenCalledWith(
      prisma,
      '2026-07-28',
      expect.arrayContaining([expect.objectContaining({ questionId: 'q1', questionContentRevision: 2 })]),
    );
    expect(prisma.quizAttempt.create.mock.calls[0]![0].data.snapshot.questions[0]).not.toHaveProperty('knowledgeStateSources');
    expect(prisma.dailyPracticeDay.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'day-1',
          activeRevisionId: 'revision-1',
        }),
        data: expect.objectContaining({
          status: DailyPracticeDayStatus.STARTED,
        }),
      }),
    );
    expect(
      mockedLockDailyPracticeSettings.mock.invocationCallOrder[0],
    ).toBeLessThan(
      prisma.dailyPracticeSettings.findUnique.mock.invocationCallOrder[0]!,
    );
    expect(
      mockedLockDailyPracticeSettings.mock.invocationCallOrder[0],
    ).toBeLessThan(
      prisma.dailyPracticeServicePause.findFirst.mock.invocationCallOrder[0]!,
    );
  });

  it('creates a fixed-only attempt from a NO_CONTENT daily plan', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-28T04:00:00.000Z'));
    const base = snapshot({ origin: QuizQuestionOrigin.MANUAL });
    const question = {
      ...base,
      subjectId: 'subject-1',
      subject: base.subject,
      chapters: base.chapters.map((chapter) => ({
        chapter: { ...chapter, sortOrder: 1 },
      })),
      gradingRubric: null,
      typeLabel: '多选题',
      pastPaperId: null,
      paperOrder: null,
      pastPaper: null,
      photos: [],
      enabled: true,
      authorId: 'author-1',
      reviewStatus: QuizQuestionReviewStatus.APPROVED,
      reviewRevision: 3,
      contentRevision: 1,
      sourceRevision: 0,
      sourceReviewStatus: QuizQuestionSourceReviewStatus.VALID,
      knowledgeSources: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      quizAttempt: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({
          id: 'attempt-fixed',
          userId: 'user-1',
          snapshot: { snapshotVersion: 2, questions: [base] },
        }),
      },
      dailyPracticeSettings: {
        findUnique: jest.fn().mockResolvedValue({ enabled: true }),
      },
      dailyPracticeServicePause: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-1' }) },
      dailyPracticePlanRevision: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'revision-fixed',
          trigger: DailyPracticePlanTrigger.AUTO,
          publishedAt: new Date(),
          day: {
            id: 'day-fixed',
            practiceDate: new Date('2026-07-28T00:00:00.000Z'),
            activeRevisionId: 'revision-fixed',
            status: DailyPracticeDayStatus.NO_CONTENT,
          },
          items: [
            {
              questionId: 'q1',
              source: DailyPracticePlanItemSource.ADMIN_FIXED,
              questionReviewRevision: 3,
              questionContentRevision: 1,
              sourceRevision: null,
              question,
            },
          ],
        }),
      },
      quizQuestion: { count: jest.fn().mockResolvedValue(1) },
      dailyPracticeDay: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    try {
      await expect(
        service.startDailyPractice('user-1', 'revision-fixed'),
      ).resolves.toMatchObject({ attemptId: 'attempt-fixed' });
    } finally {
      jest.useRealTimers();
    }

    expect(prisma.dailyPracticeDay.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'day-fixed',
          activeRevisionId: 'revision-fixed',
          status: {
            in: expect.arrayContaining([DailyPracticeDayStatus.NO_CONTENT]),
          },
        }),
      }),
    );
  });
});

describe('QuizService library', () => {
  it('returns browsable questions without grading data', async () => {
    const prisma = {
      quizQuestion: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'q1',
            type: QuestionType.SINGLE,
            typeLabel: '影像识别题',
            subjectId: 'subject-1',
            subject: { id: 'subject-1', name: '解剖学', slug: 'anatomy' },
            chapters: [
              {
                chapter: {
                  id: 'chapter-1',
                  subjectId: 'subject-1',
                  name: '胸部',
                  slug: 'thorax',
                  sortOrder: 1,
                },
              },
            ],
            category: QuizQuestionCategory.STANDARD,
            origin: QuizQuestionOrigin.MANUAL,
            prompt: '图中结构是什么？',
            options: [{ id: 'a', text: '心脏' }],
            maxScore: 1,
            paperOrder: null,
            pastPaper: null,
            photos: [
              {
                photo: {
                  id: 'photo-1',
                  caption: '胸部示意图',
                  mimeType: 'image/webp',
                  size: 100,
                  width: 800,
                  height: 600,
                },
              },
            ],
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
      subject: { findFirst: jest.fn().mockResolvedValue({ id: 'subject-1' }) },
      subjectChapter: { count: jest.fn().mockResolvedValue(1) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new QuizService(prisma as never, {} as never);

    const result = await service.listQuestions({
      subjectId: 'subject-1',
      chapterIds: ['chapter-1'],
      chapterMatch: 'ANY',
      typeLabel: '影像识别题',
      pastPaper: 'ALL',
      page: 1,
      pageSize: 30,
    });

    expect(result.items[0]).toMatchObject({
      typeLabel: '影像识别题',
      isPastPaper: false,
      images: [{ url: '/api/v1/media/images/photo-1/content' }],
    });
    expect(result.items[0]).not.toHaveProperty('correctAnswer');
    expect(result.items[0]).not.toHaveProperty('gradingRubric');
    expect(result.items[0]).not.toHaveProperty('explanation');
    expect(prisma.quizQuestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ subjectId: 'subject-1' }),
      }),
    );
  });

  it('groups display types under their own subjects', async () => {
    const prisma = {
      quizQuestion: {
        groupBy: jest.fn().mockResolvedValue([
          {
            subjectId: 'subject-1',
            type: QuestionType.SINGLE,
            typeLabel: '机制题',
            category: QuizQuestionCategory.STANDARD,
            origin: QuizQuestionOrigin.MANUAL,
            pastPaperId: null,
            _count: { _all: 1 },
          },
          {
            subjectId: 'subject-1',
            type: QuestionType.SINGLE,
            typeLabel: '机制题',
            category: QuizQuestionCategory.STANDARD,
            origin: QuizQuestionOrigin.MANUAL,
            pastPaperId: 'paper-1',
            _count: { _all: 1 },
          },
          {
            subjectId: 'subject-2',
            type: QuestionType.SINGLE,
            typeLabel: '识图题',
            category: QuizQuestionCategory.STANDARD,
            origin: QuizQuestionOrigin.MANUAL,
            pastPaperId: null,
            _count: { _all: 1 },
          },
        ]),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        {
          chapterId: 'chapter-circulation',
          type: QuestionType.SINGLE,
          typeLabel: '机制题',
          category: QuizQuestionCategory.STANDARD,
          origin: QuizQuestionOrigin.MANUAL,
          isPastPaper: 0,
          total: 1,
        },
        {
          chapterId: 'chapter-respiration',
          type: QuestionType.SINGLE,
          typeLabel: '机制题',
          category: QuizQuestionCategory.STANDARD,
          origin: QuizQuestionOrigin.MANUAL,
          isPastPaper: 1,
          total: 1,
        },
        {
          chapterId: 'chapter-thorax',
          type: QuestionType.SINGLE,
          typeLabel: '识图题',
          category: QuizQuestionCategory.STANDARD,
          origin: QuizQuestionOrigin.MANUAL,
          isPastPaper: 0,
          total: 1,
        },
      ]),
      subject: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'subject-1',
            name: '生理学',
            slug: 'physiology',
            chapters: [
              {
                id: 'chapter-respiration',
                subjectId: 'subject-1',
                name: '呼吸',
                slug: 'respiration',
                sortOrder: 1,
              },
              {
                id: 'chapter-circulation',
                subjectId: 'subject-1',
                name: '循环',
                slug: 'circulation',
                sortOrder: 2,
              },
            ],
          },
          {
            id: 'subject-2',
            name: '解剖学',
            slug: 'anatomy',
            chapters: [
              {
                id: 'chapter-thorax',
                subjectId: 'subject-2',
                name: '胸部',
                slug: 'thorax',
                sortOrder: 1,
              },
            ],
          },
        ]),
      },
      quizPaper: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'paper-1',
            title: '2025 真题',
            subjectId: 'subject-1',
            subject: { id: 'subject-1', name: '生理学', slug: 'physiology' },
            year: 2025,
            _count: { questions: 1 },
          },
        ]),
      },
    };
    const service = new QuizService(prisma as never, {} as never);

    const result = await service.filters();

    expect(result.subjectGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: '生理学',
          pastPaperCount: 1,
          types: [
            expect.objectContaining({
              label: '机制题',
              total: 2,
              randomEligibleCount: 1,
              pastPaperCount: 1,
            }),
          ],
          chapters: [
            expect.objectContaining({
              chapter: '呼吸',
              total: 1,
              randomEligibleCount: 0,
              pastPaperCount: 1,
              types: [expect.objectContaining({ label: '机制题', total: 1 })],
            }),
            expect.objectContaining({
              chapter: '循环',
              total: 1,
              randomEligibleCount: 1,
              pastPaperCount: 0,
            }),
          ],
          pastPapers: [expect.objectContaining({ id: 'paper-1' })],
        }),
        expect.objectContaining({
          subject: '解剖学',
          types: [expect.objectContaining({ label: '识图题' })],
        }),
      ]),
    );
  });
});

describe('QuizService.disableQuestion', () => {
  it('soft disables an enabled question without touching related records', async () => {
    const prisma = {
      quizQuestion: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
      quizQuestionPhoto: { deleteMany: jest.fn() },
      photo: { deleteMany: jest.fn() },
      quizAttempt: { deleteMany: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    await expect(service.disableQuestion('q1')).resolves.toEqual({
      id: 'q1',
      deleted: true,
      changed: true,
    });
    expect(prisma.quizQuestion.updateMany).toHaveBeenCalledWith({
      where: { id: 'q1', enabled: true },
      data: { enabled: false },
    });
    expect(prisma.quizQuestionPhoto.deleteMany).not.toHaveBeenCalled();
    expect(prisma.photo.deleteMany).not.toHaveBeenCalled();
    expect(prisma.quizAttempt.deleteMany).not.toHaveBeenCalled();
  });

  it('returns idempotent success for an already disabled question', async () => {
    const prisma = {
      quizQuestion: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({ id: 'q1' }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    await expect(service.disableQuestion('q1')).resolves.toEqual({
      id: 'q1',
      deleted: true,
      changed: false,
    });
  });

  it('returns 404 when the question does not exist', async () => {
    const prisma = {
      quizQuestion: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    await expect(service.disableQuestion('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('QuizService.importQuestions', () => {
  it('creates each missing chapter once with a deterministic hash slug', async () => {
    const prisma = {
      subject: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'subject-1', name: '生理学' }]),
      },
      subjectChapter: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'chapter-1',
            subjectId: 'subject-1',
            name: '循环',
            slug: 'circulation',
            active: true,
          },
        ]),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quizQuestion: {
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quizCapacityCounter: {
        upsert: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          reservedQuestions: 0,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      quizQuestionChapter: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([{ singletonId: 1 }]),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    const result = await service.importQuestions(
      'user-1',
      [
        {
          gradingType: QuestionType.SINGLE,
          subject: '生理学',
          chapters: ['循环', '呼吸'],
          prompt: '请选择最符合题意的选项。',
          options: [
            { id: 'a', text: '选项 A' },
            { id: 'b', text: '选项 B' },
          ],
          correctAnswer: ['a'],
          explanation: '解析',
        },
      ],
      { createMissingChapters: true },
    );

    const expectedSlug = `csv-${createHash('sha256')
      .update('subject-1\u0000呼吸', 'utf8')
      .digest('hex')
      .slice(0, 48)}`;
    expect(prisma.subjectChapter.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          subjectId: 'subject-1',
          name: '呼吸',
          slug: expectedSlug,
          sortOrder: 0,
          active: true,
        }),
      ],
    });
    expect(result).toMatchObject({
      imported: 1,
      pastPaper: null,
      createdChapters: [
        { subjectId: 'subject-1', name: '呼吸', slug: expectedSlug },
      ],
    });
    const links = prisma.quizQuestionChapter.createMany.mock.calls[0]![0].data;
    expect(links).toHaveLength(2);
  });

  it('does not create a replacement for an inactive chapter', async () => {
    const prisma = {
      subject: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'subject-1', name: '生理学' }]),
      },
      subjectChapter: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'chapter-1',
            subjectId: 'subject-1',
            name: '循环',
            slug: 'circulation',
            active: false,
          },
        ]),
        createMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    await expect(
      service.importQuestions(
        'user-1',
        [
          {
            gradingType: QuestionType.SINGLE,
            subject: '生理学',
            chapter: '循环',
            prompt: '请选择最符合题意的选项。',
            options: [
              { id: 'a', text: '选项 A' },
              { id: 'b', text: '选项 B' },
            ],
            correctAnswer: ['a'],
            explanation: '解析',
          },
        ],
        { createMissingChapters: true },
      ),
    ).rejects.toThrow('章节“循环”已停用');
    expect(prisma.subjectChapter.createMany).not.toHaveBeenCalled();
  });

  it('keeps a custom type label while appending to an existing past paper', async () => {
    const prisma = {
      subject: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'subject-1', name: '生理学' }]),
      },
      subjectChapter: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'chapter-1', subjectId: 'subject-1', name: '循环' },
          ]),
      },
      quizPaper: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'paper-1',
          title: '2025 真题',
          subjectId: 'subject-1',
          subject: { id: 'subject-1', name: '生理学', slug: 'physiology' },
          year: 2025,
        }),
      },
      quizQuestion: {
        findFirst: jest.fn().mockResolvedValue({ paperOrder: 12 }),
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      quizCapacityCounter: {
        upsert: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          reservedQuestions: 0,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      quizQuestionChapter: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([{ singletonId: 1 }]),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    const result = await service.importQuestions(
      'user-1',
      [
        {
          gradingType: QuestionType.SINGLE,
          typeLabel: '病例判断题',
          subject: '生理学',
          chapter: '循环',
          prompt: '请选择最符合题意的选项。',
          options: [
            { id: 'a', text: '选项 A' },
            { id: 'b', text: '选项 B' },
          ],
          correctAnswer: ['a'],
          explanation: '解析',
        },
      ],
      { pastPaperId: 'paper-1' },
    );

    expect(result).toMatchObject({ imported: 1, pastPaper: { id: 'paper-1' } });
    expect(prisma.quizQuestion.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          type: QuestionType.SINGLE,
          typeLabel: '病例判断题',
          pastPaperId: 'paper-1',
          paperOrder: 13,
        }),
      ],
    });
  });

  it('rejects a past paper containing a different subject', async () => {
    const prisma = {
      subject: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'subject-1', name: '生理学' }]),
      },
      subjectChapter: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'chapter-1', subjectId: 'subject-1', name: '循环' },
          ]),
      },
      quizPaper: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'paper-1',
          title: '2025 真题',
          subjectId: 'subject-2',
          subject: { id: 'subject-2', name: '解剖学', slug: 'anatomy' },
          year: 2025,
        }),
      },
      quizQuestion: {
        findFirst: jest.fn().mockResolvedValue(null),
        createMany: jest.fn(),
      },
      quizQuestionChapter: { createMany: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    await expect(
      service.importQuestions(
        'user-1',
        [
          {
            gradingType: QuestionType.SINGLE,
            subject: '生理学',
            chapter: '循环',
            prompt: '请选择最符合题意的选项。',
            options: [
              { id: 'a', text: '选项 A' },
              { id: 'b', text: '选项 B' },
            ],
            correctAnswer: ['a'],
            explanation: '解析',
          },
        ],
        { pastPaperId: 'paper-1' },
      ),
    ).rejects.toThrow('所有导入题目的学科必须与往年真题试卷一致');
    expect(prisma.quizQuestion.createMany).not.toHaveBeenCalled();
  });
});

describe('QuizService question editing', () => {
  it('updates mutable fields and chapter links without rewriting provenance', async () => {
    const prisma = {
      subject: {
        findFirst: jest.fn().mockResolvedValue({ id: 'subject-1' }),
      },
      subjectChapter: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'chapter-1' }, { id: 'chapter-2' }]),
      },
      quizQuestion: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'question-1',
          pastPaper: null,
        }),
        update: jest.fn().mockResolvedValue({ id: 'question-1' }),
      },
      quizQuestionChapter: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    const service = new QuizService(prisma as never, {} as never);

    await service.updateQuestion('question-1', {
      gradingType: QuestionType.SINGLE,
      typeLabel: '单选题',
      subjectId: 'subject-1',
      chapterIds: ['chapter-1', 'chapter-2'],
      prompt: '更新后的题干',
      options: [
        { id: 'A', text: '选项甲' },
        { id: 'B', text: '选项乙' },
      ],
      correctAnswer: ['A'],
      explanation: '更新后的解析',
    });

    const data = prisma.quizQuestion.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      subjectId: 'subject-1',
      prompt: '更新后的题干',
      contentRevision: { increment: 1 },
      chapters: {
        createMany: {
          data: [{ chapterId: 'chapter-1' }, { chapterId: 'chapter-2' }],
        },
      },
    });
    expect(data).toHaveProperty('gradingRubric');
    expect(data).not.toHaveProperty('authorId');
    expect(data).not.toHaveProperty('origin');
    expect(data).not.toHaveProperty('reviewStatus');
  });

  it('rejects missing management detail records', async () => {
    const prisma = {
      quizQuestion: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new QuizService(prisma as never, {} as never);

    await expect(service.getQuestionForEdit('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
