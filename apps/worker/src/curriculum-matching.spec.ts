import { validateCurriculumMappingOutput, queueStaleCurriculumMappings, processNextCurriculumQuestionMapping } from './curriculum-matching';
import { AiClientError } from '@bmc3/ai-core';
import type { PracticeCourseSnapshot } from '@bmc3/daily-practice-core';
import * as practicePrisma from '@bmc3/daily-practice-prisma';
import * as gateway from './ai-invocation-gateway';

jest.mock('@bmc3/daily-practice-prisma', () => ({
  ...jest.requireActual('@bmc3/daily-practice-prisma'),
  loadPracticeCourses: jest.fn(),
}));

const course: PracticeCourseSnapshot = {
  id: 'course', subjectId: 'subject', subjectName: '医学分子细胞遗传', termKey: 'test',
  startDate: '2026-09-01', examDate: '2026-10-30', enabled: true, revision: 1, topicHash: 'new-hash',
  topics: [{ id: 'membrane', title: '细胞膜', sessionDates: ['2026-09-01'], sourceRefs: [], paused: false, taughtOnOverride: null }],
};

describe('curriculum question mapping', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts evidence tied to a supplied image and rejects invented image indices', () => {
    const output = { topicIds: ['membrane'], confidence: 0.95, ambiguous: false, reason: '图示膜结构', evidence: [{ topicId: 'membrane', imageIndex: 1, description: '图中央的磷脂双分子层' }] };
    expect(validateCurriculumMappingOutput(JSON.stringify(output), course, '辨认结构图', 1).topicIds).toEqual(['membrane']);
    expect(() => validateCurriculumMappingOutput(JSON.stringify(output), course, '辨认结构图', 0)).toThrow('INVALID_MAPPING_IMAGE_EVIDENCE');
  });

  it('requires valid topic identities and quoted evidence even when model confidence is high', () => {
    const output = { topicIds: ['membrane'], confidence: 0.99, ambiguous: false, reason: '考查细胞膜', evidence: [{ topicId: 'membrane', quote: '细胞膜' }] };
    expect(validateCurriculumMappingOutput(JSON.stringify(output), course, '细胞膜的结构')).toMatchObject({ topicIds: ['membrane'] });
    expect(() => validateCurriculumMappingOutput(JSON.stringify({ ...output, topicIds: ['unknown'] }), course, '细胞膜的结构')).toThrow('UNKNOWN_MAPPING_TOPIC');
    expect(() => validateCurriculumMappingOutput(JSON.stringify({ ...output, evidence: [] }), course, '细胞膜的结构')).toThrow('MAPPING_EVIDENCE_MISSING');
    expect(() => validateCurriculumMappingOutput(JSON.stringify(output), course, '完全不同的题目')).toThrow('INVALID_MAPPING_EVIDENCE');
  });

  it('checks literal field values including quotes and newlines rather than serialized JSON', () => {
    const quote = '细胞膜的"流动镶嵌模型"\n说明';
    const output = { topicIds: ['membrane'], confidence: 0.99, ambiguous: false, reason: '考查细胞膜', evidence: [{ topicId: 'membrane', quote }] };
    const source = { prompt: '选择正确解释', options: [{ text: quote }], rubric: null };
    expect(validateCurriculumMappingOutput(JSON.stringify(output), course, source).topicIds).toEqual(['membrane']);
    expect(() => validateCurriculumMappingOutput(JSON.stringify({ ...output, evidence: [{ topicId: 'membrane', quote: 'prompt' }] }), course, source)).toThrow('INVALID_MAPPING_EVIDENCE');
  });

  it('keeps daily quota exhaustion pending until the next practice day without consuming a matching attempt', async () => {
    jest.mocked(practicePrisma.loadPracticeCourses).mockResolvedValue([course]);
    jest.spyOn(gateway, 'reserveAiInvocation').mockRejectedValue(new AiClientError('AI 调用日额度已用完', 'RATE_LIMIT', false, 429));
    const question = { id: 'question', subjectId: 'subject', contentRevision: 1, prompt: '细胞膜结构', options: [], correctAnswer: 'A', explanation: null, gradingRubric: null, _count: { photos: 0 }, curriculumMapping: { attempts: 2 } };
    const prisma = {
      quizQuestion: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => question) },
      practiceQuestionMapping: { upsert: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    const client = { model: jest.fn(() => 'model'), complete: jest.fn() };
    await processNextCurriculumQuestionMapping(prisma as never, { now: new Date('2026-09-24T00:00:00Z'), client });
    expect(client.complete).not.toHaveBeenCalled();
    expect(prisma.practiceQuestionMapping.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PENDING', attempts: { decrement: 1 }, leasedUntil: new Date('2026-09-24T20:00:00Z') }),
    }));
  });

  it('requeues stale automatic labels but sends stale manual labels for review', async () => {
    const mapping = { courseId: 'course', contentRevision: 1, topicHash: 'old-hash', status: 'READY', revision: 2, leasedUntil: null };
    const client = {
      quizQuestion: { findMany: jest.fn(async () => [
        { id: 'automatic', subjectId: 'subject', contentRevision: 2, curriculumMapping: { ...mapping, manual: false } },
        { id: 'manual', subjectId: 'subject', contentRevision: 2, curriculumMapping: { ...mapping, manual: true } },
      ]) },
      practiceQuestionMapping: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    await queueStaleCurriculumMappings(client as never, [course], new Date('2026-09-25T00:00:00Z'));
    expect(client.practiceQuestionMapping.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ status: 'PENDING', contentRevision: 2, topicIds: [] }) }));
    expect(client.practiceQuestionMapping.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ status: 'NEEDS_REVIEW' }) }));
  });
});
