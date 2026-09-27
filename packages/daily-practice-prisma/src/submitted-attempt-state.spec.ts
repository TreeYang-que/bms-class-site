import {
  applySubmittedAttemptState,
  lockUserPracticeProfile,
  parseAttemptResults,
  parseAttemptSnapshot,
} from './submitted-attempt-state';

function snapshotV2(withFrozenSources = true) {
  return {
    snapshotVersion: 2,
    questions: [
      {
        id: 'question-1',
        subject: { id: 'subject-1', name: '生理学', slug: 'physiology' },
        chapters: [
          {
            id: 'chapter-1',
            subjectId: 'subject-1',
            name: '细胞',
            slug: 'cell',
          },
          {
            id: 'chapter-1',
            subjectId: 'subject-1',
            name: '细胞',
            slug: 'cell',
          },
        ],
        prompt: '不应写入状态的完整题干',
        ...(withFrozenSources
          ? {
              knowledgeStateSources: [
                {
                  documentId: 'frozen-document',
                  nodePathHash: 'b'.repeat(64),
                  currentKnowledgeNodeId: 'frozen-node',
                  subjectId: 'subject-1',
                  libraryId: 'frozen-library',
                },
              ],
            }
          : {}),
      },
    ],
  };
}

function attemptResults() {
  return [
    {
      questionId: 'question-1',
      correct: false,
      score: 1,
      maxScore: 2,
      criterionScores: [
        {
          description: '说明离子梯度的作用',
          awardedPoints: 0,
          maxPoints: 1,
          reason: '不得持久化的模型自由文本',
        },
      ],
    },
  ];
}

interface FakeState {
  appliedAt: Date | null;
  questionAppliedAt: Date | null;
  questionWrites: unknown[];
  knowledgeStateRevision: number | null;
  profile: {
    stateRevision: number;
    lastAppliedAttemptAt: Date | null;
    attemptCount: number;
    questionCount: number;
    correctCount: number;
    wrongCount: number;
  } | null;
  knowledgeWrites: unknown[];
  chapterWrites: unknown[];
}

function createFakeTransaction(
  options: {
    failChapterOnce?: boolean;
    withFrozenSources?: boolean;
    earlierAttempt?: boolean;
    dailyRevision?: boolean;
  } = {},
) {
  const submittedAt = new Date('2026-07-28T04:30:00.000Z');
  const state: FakeState = {
    appliedAt: null,
    questionAppliedAt: null,
    questionWrites: [],
    knowledgeStateRevision: null,
    profile: null,
    knowledgeWrites: [],
    chapterWrites: [],
  };
  let failChapterOnce = Boolean(options.failChapterOnce);
  const attempt = {
    id: 'attempt-1',
    userId: 'user-1',
    snapshot: snapshotV2(options.withFrozenSources ?? true),
    results: attemptResults(),
    submittedAt,
    knowledgeStateAppliedAt: null,
    knowledgeStateRevision: null,
    dailyPracticePlanRevisionId: options.dailyRevision ? 'revision-1' : null,
  };
  const transaction = {
    quizAttempt: {
      update: jest.fn(async ({ data }: { data: { questionStateAppliedAt: Date } }) => {
        state.questionAppliedAt = data.questionStateAppliedAt;
      }),
      updateMany: jest.fn(
        async ({ data }: { data: Record<string, unknown> }) => {
          if ('knowledgeStateAppliedAt' in data) {
            if (state.appliedAt) return { count: 0 };
            state.appliedAt = data.knowledgeStateAppliedAt as Date;
            return { count: 1 };
          }
          if (
            'knowledgeStateRevision' in data &&
            !state.knowledgeStateRevision
          ) {
            state.knowledgeStateRevision =
              data.knowledgeStateRevision as number;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
      findUnique: jest.fn(async () => ({
        knowledgeStateRevision: state.knowledgeStateRevision,
      })),
      findUniqueOrThrow: jest.fn(async () => ({ ...attempt, knowledgeStateAppliedAt: state.appliedAt, knowledgeStateRevision: state.knowledgeStateRevision, questionStateAppliedAt: state.questionAppliedAt })),
      findFirst: jest.fn(async () =>
        options.earlierAttempt ? { id: 'attempt-0' } : null,
      ),
    },
    quizQuestion: {
      findMany: jest.fn(async () => [
        {
          id: 'question-1',
          subjectId: 'subject-1',
          chapters: [{ chapterId: 'chapter-1' }],
        },
      ]),
    },
    quizQuestionKnowledgeSource: {
      findMany: jest.fn(async () => [
        {
          questionId: 'question-1',
          documentId: 'document-1',
          libraryId: 'library-1',
          nodePathHash: null,
          knowledgeNodeId: 'node-1',
          knowledgeNode: { pathHash: 'a'.repeat(64) },
          question: { subjectId: 'subject-1' },
        },
      ]),
    },
    knowledgeNode: {
      findMany: jest.fn(async () => [{ id: 'frozen-node' }]),
    },
    userPracticeProfile: {
      upsert: jest.fn(async () => {
        state.profile ??= {
          stateRevision: 0,
          lastAppliedAttemptAt: null,
          attemptCount: 0,
          questionCount: 0,
          correctCount: 0,
          wrongCount: 0,
        };
        return state.profile;
      }),
      findUniqueOrThrow: jest.fn(async () => state.profile),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const profile = state.profile!;
        profile.stateRevision = typeof data.stateRevision === 'number' ? data.stateRevision : profile.stateRevision + (data.stateRevision as { increment: number }).increment;
        if (data.lastAppliedAttemptAt) profile.lastAppliedAttemptAt = data.lastAppliedAttemptAt as Date;
        for (const name of [
          'attemptCount',
          'questionCount',
          'correctCount',
          'wrongCount',
        ] as const) {
          profile[name] += (data[name] as { increment: number } | undefined)?.increment ?? 0;
        }
        return profile;
      }),
    },
    userKnowledgeState: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async (value: unknown) => {
        state.knowledgeWrites.push(value);
        return value;
      }),
    },
    userQuestionState: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async (value: unknown) => { state.questionWrites.push(value); return value; }),
    },
    userChapterState: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async (value: unknown) => {
        if (failChapterOnce) {
          failChapterOnce = false;
          throw new Error('synthetic chapter write failure');
        }
        state.chapterWrites.push(value);
        return value;
      }),
    },
    dailyPracticePlanRevision: {
      findUnique: jest.fn(async () =>
        options.dailyRevision ? { dayId: 'day-1' } : null,
      ),
    },
    dailyPracticeDay: { updateMany: jest.fn(async () => ({ count: 1 })) },
    $queryRaw: jest.fn(async () => [{ userId: 'user-1' }]),
  };
  return { transaction, state, attempt };
}

async function runWithRollback<T>(
  state: FakeState,
  action: () => Promise<T>,
): Promise<T> {
  const before = structuredClone(state);
  try {
    return await action();
  } catch (error) {
    Object.assign(state, before);
    throw error;
  }
}

describe('submitted attempt practice state', () => {
  it('creates and locks the user profile before state reads or writes', async () => {
    const transaction = {
      userPracticeProfile: {
        upsert: jest.fn().mockResolvedValue({ userId: 'user-1' }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ userId: 'user-1' }]),
    };

    await lockUserPracticeProfile(transaction as never, 'user-1');

    expect(transaction.userPracticeProfile.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: {
        userId: 'user-1',
        initializationStatus: 'PENDING',
      },
      update: {},
    });
    expect(
      transaction.userPracticeProfile.upsert.mock.invocationCallOrder[0],
    ).toBeLessThan(transaction.$queryRaw.mock.invocationCallOrder[0]!);
  });

  it('parses v1/v2 snapshots and finite result values', () => {
    expect(parseAttemptSnapshot(snapshotV2() as never)).toEqual([
      {
        id: 'question-1',
        subjectId: 'subject-1',
        chapterIds: ['chapter-1'],
        knowledgeStateSources: [
          {
            documentId: 'frozen-document',
            nodePathHash: 'b'.repeat(64),
            currentKnowledgeNodeId: 'frozen-node',
            subjectId: 'subject-1',
            libraryId: 'frozen-library',
          },
        ],
      },
    ]);
    expect(
      parseAttemptSnapshot([
        { id: 'legacy-question', subject: '旧学科', chapter: '旧章节' },
      ] as never),
    ).toEqual([
      {
        id: 'legacy-question',
        subjectId: null,
        chapterIds: [],
        knowledgeStateSources: null,
      },
    ]);
    expect(parseAttemptResults(attemptResults() as never)[0]).toMatchObject({
      questionId: 'question-1',
      score: 1,
      maxScore: 2,
    });
  });

  it('applies question and chapter observations exactly once without reading knowledge sources', async () => {
    const { transaction, state, attempt } = createFakeTransaction();
    const first = await applySubmittedAttemptState(
      transaction as never,
      attempt as never,
      new Date('2026-07-28T04:31:00.000Z'),
    );
    const second = await applySubmittedAttemptState(
      transaction as never,
      attempt as never,
      new Date('2026-07-28T04:32:00.000Z'),
    );

    expect(first).toMatchObject({
      applied: true,
      deferred: false,
      stateRevision: 1,
      knowledgeStateCount: 0,
      chapterStateCount: 1,
    });
    expect(second).toMatchObject({ applied: false, stateRevision: 1 });
    expect(state.profile).toMatchObject({
      stateRevision: 1,
      attemptCount: 1,
      questionCount: 1,
      correctCount: 0,
      wrongCount: 1,
    });
    expect(state.knowledgeWrites).toHaveLength(0);
    expect(state.questionWrites).toHaveLength(1);
    expect(state.chapterWrites).toHaveLength(1);
    expect(JSON.stringify(state.chapterWrites)).toContain(
      '说明离子梯度的作用',
    );
    expect(JSON.stringify(state.knowledgeWrites)).not.toContain('模型自由文本');
    expect(JSON.stringify(state.knowledgeWrites)).not.toContain('完整题干');
    expect(
      transaction.quizQuestionKnowledgeSource.findMany,
    ).not.toHaveBeenCalled();
  });

  it('keeps legacy snapshots usable without resolving their old knowledge sources', async () => {
    const { transaction, state, attempt } = createFakeTransaction({
      withFrozenSources: false,
    });
    await applySubmittedAttemptState(transaction as never, attempt as never);
    expect(state.knowledgeWrites).toHaveLength(0);
    expect(state.questionWrites).toHaveLength(1);
    expect(
      transaction.quizQuestionKnowledgeSource.findMany,
    ).not.toHaveBeenCalled();
  });

  it('backfills the new question marker without applying old profile totals again', async () => {
    const { transaction, state, attempt } = createFakeTransaction();
    await transaction.userPracticeProfile.upsert();
    state.appliedAt = new Date('2026-07-28T05:00:00Z');
    state.knowledgeStateRevision = 5;
    state.profile!.attemptCount = 9;
    await applySubmittedAttemptState(transaction as never, attempt as never);
    await applySubmittedAttemptState(transaction as never, attempt as never);
    expect(state.questionWrites).toHaveLength(1);
    expect(state.chapterWrites).toHaveLength(0);
    expect(state.profile!.attemptCount).toBe(9);
    expect(state.questionAppliedAt).not.toBeNull();
  });

  it('accepts a first answer after assignment created a zero-attempt question state', async () => {
    const { transaction, state, attempt } = createFakeTransaction();
    transaction.userQuestionState.findMany.mockResolvedValueOnce([{ questionId: 'question-1', attemptCount: 0 }] as never);
    await expect(applySubmittedAttemptState(transaction as never, attempt as never)).resolves.toMatchObject({ applied: true });
    expect(state.questionWrites).toHaveLength(1);
  });

  it('defers a newer observation behind older work but still completes its daily day', async () => {
    const { transaction, attempt } = createFakeTransaction({
      earlierAttempt: true,
      dailyRevision: true,
    });
    await expect(
      applySubmittedAttemptState(transaction as never, attempt as never),
    ).resolves.toMatchObject({ applied: false, deferred: true });
    expect(transaction.quizAttempt.updateMany).not.toHaveBeenCalled();
    expect(transaction.dailyPracticeDay.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'day-1', activeRevisionId: 'revision-1' },
      }),
    );
  });

  it('rolls the CAS back on a transaction fault and remains retryable', async () => {
    const { transaction, state, attempt } = createFakeTransaction({
      failChapterOnce: true,
    });
    await expect(
      runWithRollback(state, () =>
        applySubmittedAttemptState(transaction as never, attempt as never),
      ),
    ).rejects.toThrow('synthetic chapter write failure');
    expect(state.appliedAt).toBeNull();
    expect(state.profile).toBeNull();

    await expect(
      runWithRollback(state, () =>
        applySubmittedAttemptState(transaction as never, attempt as never),
      ),
    ).resolves.toMatchObject({ applied: true, stateRevision: 1 });
  });
});
