import {
  countEffectiveSelectable,
  allocateWeightedCounts,
  selectCurriculumQuestions,
  selectCurriculumQuestionsWithinQuotas,
  shortlistCurriculumCandidates,
  prepareCandidates,
  requiredDailyPlanConcurrency,
  scheduleUsersAcrossWindow,
  scoreCandidate,
  selectDeterministicCandidates,
  type CandidateScoreInput,
} from './candidate';
import { practiceDayWindow } from './time';

function candidate(
  questionId: string,
  overrides: Partial<CandidateScoreInput> = {},
): CandidateScoreInput {
  return {
    questionId,
    gradingType: 'SINGLE',
    reviewUrgency: 20,
    errorRisk: 10,
    masteryBps: 5_000,
    coverageDebt: 5,
    seenWithin24Hours: false,
    suggestionMatch: 0,
    ...overrides,
  };
}

describe('candidate scoring and scheduling', () => {
  it('reserves the sole short answer for a bucket that cannot be filled by objective questions', () => {
    const common = { courseId: 'a', bucket: 'RECENT' as const, mandatory: false, tieBreakHash: '' };
    const pool = [
      { ...common, questionId: 'sa-a', gradingType: 'SHORT_ANSWER' as const, priorityScore: 100 },
      { ...common, questionId: 'q-a', gradingType: 'SINGLE' as const, priorityScore: 10 },
      { ...common, courseId: 'b', bucket: 'REVIEW' as const, questionId: 'sa-b', gradingType: 'SHORT_ANSWER' as const, priorityScore: 20 },
    ];
    const quotas = [{ courseId: 'a', bucket: 'RECENT' as const, count: 1 }, { courseId: 'b', bucket: 'REVIEW' as const, count: 1 }];
    expect(selectCurriculumQuestionsWithinQuotas(pool, quotas).map((item) => item.questionId)).toEqual(['q-a', 'sa-b']);
    expect(() => selectCurriculumQuestionsWithinQuotas(pool.map((item) => ({ ...item, mandatory: item.questionId === 'sa-a' })), quotas)).toThrow('infeasible curriculum bucket allocation');
  });

  it('allocates seven seats equally or by the exam weight and redistributes shortages', () => {
    expect(allocateWeightedCounts(7, [{ key: 'a', weight: 1, capacity: 10 }, { key: 'b', weight: 1, capacity: 10 }])).toEqual({ a: 4, b: 3 });
    expect(allocateWeightedCounts(7, [{ key: 'a', weight: 2, capacity: 10 }, { key: 'b', weight: 1, capacity: 10 }])).toEqual({ a: 5, b: 2 });
    expect(allocateWeightedCounts(7, [{ key: 'a', weight: 2, capacity: 1 }, { key: 'b', weight: 1, capacity: 10 }])).toEqual({ a: 1, b: 6 });
  });

  it('scores the complete pool and keeps course and bucket diversity beyond the first thousand IDs', () => {
    const prepared = prepareCandidates(Array.from({ length: 1_200 }, (_, index) => candidate(`q${index}`, {
      reviewUrgency: index === 1_199 ? 40 : 0,
      errorRisk: index === 1_199 ? 30 : 0,
      mandatoryEligible: index === 1_199,
    })), '2026-09-24', 'user-1');
    const pool = prepared.candidates.map((entry) => ({ ...entry, courseId: Number(entry.questionId.slice(1)) % 2 ? 'a' : 'b', bucket: 'COVERAGE' as const }));
    const selected = selectCurriculumQuestions(pool, 7, new Map([['a', 1], ['b', 1]]));
    expect(selected).toHaveLength(7);
    expect(selected.some((entry) => entry.questionId === 'q1199')).toBe(true);
    expect(selected.filter((entry) => entry.courseId === 'a')).toHaveLength(4);
    expect(shortlistCurriculumCandidates(pool, selected, 50)).toHaveLength(50);
  });

  it('keeps multiple short-answer options in the shortlist while the feasible plan contains at most one', () => {
    const prepared = prepareCandidates([
      ...Array.from({ length: 8 }, (_, index) => candidate(`s${index}`, { gradingType: 'SHORT_ANSWER' })),
      ...Array.from({ length: 8 }, (_, index) => candidate(`q${index}`)),
    ], '2026-09-24', 'user-1');
    const pool = prepared.candidates.map((entry) => ({ ...entry, courseId: 'a', bucket: 'COVERAGE' as const }));
    const selected = selectCurriculumQuestions(pool, 7, new Map([['a', 1]]));
    expect(selected.filter((entry) => entry.gradingType === 'SHORT_ANSWER').length).toBeLessThanOrEqual(1);
    expect(shortlistCurriculumCandidates(pool, selected, 50).filter((entry) => entry.gradingType === 'SHORT_ANSWER').length).toBe(8);
  });
  it('uses the bounded transparent score components', () => {
    expect(
      scoreCandidate(
        candidate('q1', {
          reviewUrgency: 40,
          errorRisk: 30,
          masteryBps: 0,
          coverageDebt: 10,
          suggestionMatch: 10,
        }),
      ),
    ).toBe(110);
    expect(
      scoreCandidate(candidate('q2', { seenWithin24Hours: true })),
    ).toBe(scoreCandidate(candidate('q2')) - 30);
  });

  it('uses stable SHA-256 tie breaks independent of input order', () => {
    const left = prepareCandidates(
      [candidate('q1'), candidate('q2'), candidate('q3')],
      '2026-07-28',
      'user-1',
    );
    const right = prepareCandidates(
      [candidate('q3'), candidate('q1'), candidate('q2')],
      '2026-07-28',
      'user-1',
    );
    expect(left.candidates.map((item) => item.questionId)).toEqual(
      right.candidates.map((item) => item.questionId),
    );
    expect(left.candidates.every((item) => item.tieBreakHash.length === 64)).toBe(
      true,
    );
  });

  it('counts an all-short-answer pool as one effective selectable question', () => {
    const candidates = Array.from({ length: 5 }, (_, index) =>
      candidate(`short-${index}`, { gradingType: 'SHORT_ANSWER' }),
    );
    expect(countEffectiveSelectable(candidates)).toBe(1);
    expect(
      prepareCandidates(candidates, '2026-07-28', 'user-1').questionCount,
    ).toEqual({ minimum: 1, maximum: 1 });
  });

  it('allows only the highest-priority short answer to be mandatory', () => {
    const prepared = prepareCandidates(
      [
        candidate('short-high', {
          gradingType: 'SHORT_ANSWER',
          reviewUrgency: 40,
          mandatoryEligible: true,
        }),
        candidate('short-low', {
          gradingType: 'SHORT_ANSWER',
          reviewUrgency: 30,
          mandatoryEligible: true,
        }),
        candidate('choice', {
          reviewUrgency: 25,
          mandatoryEligible: true,
        }),
      ],
      '2026-07-28',
      'user-1',
    );
    expect(prepared.mandatoryQuestionIds).toEqual(['short-high', 'choice']);
    const selected = selectDeterministicCandidates(prepared.candidates, 3);
    expect(
      selected.filter((item) => item.gradingType === 'SHORT_ANSWER'),
    ).toHaveLength(1);
    expect(selected.map((item) => item.questionId)).toEqual(
      expect.arrayContaining(prepared.mandatoryQuestionIds),
    );
  });

  it.each([100, 1_000])(
    'stably spreads %i users inside the dispatch budget',
    (count) => {
      const users = Array.from({ length: count }, (_, index) => `user-${index}`);
      const first = scheduleUsersAcrossWindow('2026-07-28', users, 120_000);
      const second = scheduleUsersAcrossWindow(
        '2026-07-28',
        [...users].reverse(),
        120_000,
      );
      expect(first).toEqual(second);
      const window = practiceDayWindow('2026-07-28');
      const latestAllowed = window.deadlineAt.getTime() - 120_000;
      expect(
        first.every(
          (item) =>
            item.scheduledAt >= window.dayStartedAt &&
            item.scheduledAt.getTime() < latestAllowed,
        ),
      ).toBe(true);
      expect(new Set(first.map((item) => item.userId)).size).toBe(count);
    },
  );

  it('calculates the minimum capacity and rejects budgets that cannot execute', () => {
    expect(
      requiredDailyPlanConcurrency({
        activeUserCount: 101,
        providerP95Ms: 10_000,
        dispatchBudgetMs: 1_500_000,
      }),
    ).toBe(1);
    expect(
      requiredDailyPlanConcurrency({
        activeUserCount: 1_000,
        providerP95Ms: 20_000,
        dispatchBudgetMs: 1_500_000,
      }),
    ).toBe(14);
    expect(
      requiredDailyPlanConcurrency({
        activeUserCount: 0,
        providerP95Ms: 20_000,
        dispatchBudgetMs: 1_500_000,
      }),
    ).toBe(0);
    for (const input of [
      { activeUserCount: 1.5, providerP95Ms: 1_000, dispatchBudgetMs: 1_000 },
      { activeUserCount: 1, providerP95Ms: 0, dispatchBudgetMs: 1_000 },
      { activeUserCount: 1, providerP95Ms: 1_000, dispatchBudgetMs: 0 },
      { activeUserCount: 1, providerP95Ms: 300_000, dispatchBudgetMs: 1_500_000 },
    ]) {
      expect(() => requiredDailyPlanConcurrency(input)).toThrow(RangeError);
    }
  });
});
