import type { PracticeCourseSnapshot } from '@bmc3/daily-practice-core';
import {
  assertDailyQuestionEligibility,
  dailyCurriculumEligibilitySql,
  isCurriculumQuestionEligible,
  loadEligiblePracticeQuestions,
  type CurriculumCandidate,
  type CurriculumClient,
} from './curriculum';

const course: PracticeCourseSnapshot = {
  id: 'course',
  subjectId: 'subject',
  subjectName: '医学分子细胞遗传',
  termKey: '2026-2027-1',
  startDate: '2026-08-31',
  examDate: '2027-01-06',
  enabled: true,
  revision: 1,
  topicHash: 'hash',
  topics: [
    {
      id: 'old',
      title: '已学',
      sessionDates: ['2026-09-21'],
      sourceRefs: [],
      paused: false,
      taughtOnOverride: null,
    },
    {
      id: 'new',
      title: '未学',
      sessionDates: ['2026-09-25'],
      sourceRefs: [],
      paused: false,
      taughtOnOverride: null,
    },
  ],
};

function question(id: string, topicIds = ['old']): CurriculumCandidate {
  return {
    id,
    subjectId: course.subjectId,
    contentRevision: 2,
    curriculumMapping: {
      courseId: course.id,
      status: 'READY',
      contentRevision: 2,
      topicHash: course.topicHash,
      topicIds,
    },
  } as CurriculumCandidate;
}

describe('curriculum eligibility at the database boundary', () => {
  it('requires every topic, current content and a matching curriculum version', () => {
    const eligible = question('q');
    expect(isCurriculumQuestionEligible(eligible, [course], '2026-09-24')).toBe(true);
    expect(
      isCurriculumQuestionEligible(question('q', ['old', 'new']), [course], '2026-09-24'),
    ).toBe(false);
    expect(
      isCurriculumQuestionEligible({ ...eligible, contentRevision: 3 }, [course], '2026-09-24'),
    ).toBe(false);
    expect(
      isCurriculumQuestionEligible(eligible, [{ ...course, topicHash: 'changed' }], '2026-09-24'),
    ).toBe(false);
    expect(
      isCurriculumQuestionEligible(eligible, [{ ...course, enabled: false }], '2026-09-24'),
    ).toBe(false);
    expect(isCurriculumQuestionEligible(eligible, [course], '2027-01-07')).toBe(false);
  });

  it('scans beyond 1000 questions with the same cutoff and stable cursor', async () => {
    const pages = [500, 500, 201].map((count, page) =>
      Array.from({ length: count }, (_, index) => question(`q-${page * 500 + index}`)),
    );
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(pages[0])
      .mockResolvedValueOnce(pages[1])
      .mockResolvedValueOnce(pages[2]);
    const cutoffAt = new Date('2026-09-23T20:00:00Z');
    const result = await loadEligiblePracticeQuestions(
      { quizQuestion: { findMany } } as unknown as CurriculumClient,
      '2026-09-24',
      { courses: [course], cutoffAt },
    );
    expect(result).toHaveLength(1201);
    expect(result.at(-1)?.id).toBe('q-1200');
    expect(findMany.mock.calls[2]![0]).toMatchObject({ cursor: { id: 'q-999' }, skip: 1 });
    for (const [query] of findMany.mock.calls) {
      expect(query.where).toMatchObject({
        origin: { in: ['MANUAL', 'CSV'] },
        createdAt: { lte: cutoffAt },
        updatedAt: { lte: cutoffAt },
        curriculumMapping: { is: { updatedAt: { lte: cutoffAt } } },
      });
    }
  });

  it('rejects a published item whose content revision was not frozen', async () => {
    const client = {
      practiceCourse: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              ...course,
              startDate: new Date('2026-08-31'),
              examDate: new Date('2027-01-06'),
              subject: { name: course.subjectName },
            },
          ]),
      },
      quizQuestion: { findMany: jest.fn().mockResolvedValue([question('q')]) },
    } as unknown as CurriculumClient;
    expect(await assertDailyQuestionEligibility(client, '2026-09-24', [{ questionId: 'q' }])).toBe(
      false,
    );
    expect(
      await assertDailyQuestionEligibility(client, '2026-09-24', [
        { questionId: 'q', questionContentRevision: 1 },
      ]),
    ).toBe(false);
    expect(
      await assertDailyQuestionEligibility(client, '2026-09-24', [
        { questionId: 'q', questionContentRevision: 2 },
      ]),
    ).toBe(true);
  });

  it('limits the paginated SQL scope to all learned topics and disables ended courses', () => {
    const sql = dailyCurriculumEligibilitySql([course], '2026-09-24');
    expect(sql.sql).toContain('JSON_CONTAINS(?, mapping.topicIds)');
    expect(sql.values).toContain('["old"]');
    expect(sql.values).not.toContain('["old","new"]');
    expect(dailyCurriculumEligibilitySql([course], '2027-01-07').sql).toBe('1 = 0');
  });
});
