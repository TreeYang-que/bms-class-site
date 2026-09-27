import { buildDeterministicFallback } from './fallback';
import { buildTestPayload } from './test-fixture';

describe('deterministic daily fallback', () => {
  it('keeps exact course quotas when one mandatory short answer consumes the global limit', () => {
    const payload = buildTestPayload((input) => {
      input.inputPolicy.courseQuestionCounts = [{ courseAlias: 'P001', count: 2 }, { courseAlias: 'P002', count: 2 }];
      input.candidateQuestions.forEach((question) => {
        question.courseAlias = ['Q001', 'Q002', 'Q003'].includes(question.questionAlias) ? 'P001' : 'P002';
        question.selectionBucket = 'COVERAGE';
      });
    });
    const result = buildDeterministicFallback(payload, 'TIMEOUT');
    expect(result.output.selectedQuestions.map((question) => question.questionAlias)).toEqual(['Q002', 'Q001', 'Q004', 'Q005']);
  });
  it('produces a stable strict plan with mandatory questions first', () => {
    const payload = buildTestPayload();
    const first = buildDeterministicFallback(payload, 'PROVIDER_TIMEOUT');
    const second = buildDeterministicFallback(payload, 'PROVIDER_TIMEOUT');
    expect(first).toEqual(second);
    expect(first.generationSource).toBe('DETERMINISTIC');
    expect(first.output.selectedQuestions.map((item) => item.questionAlias)).toEqual([
      'Q002',
      'Q001',
      'Q004',
      'Q005',
    ]);
    expect(
      first.output.selectedQuestions.filter(
        (item) =>
          payload.candidateQuestions.find(
            (candidate) => candidate.questionAlias === item.questionAlias,
          )?.gradingType === 'SHORT_ANSWER',
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(first.output)).not.toContain('F001');
    expect(
      first.output.selectedQuestions.every((item) => item.evidenceRefs.length > 0),
    ).toBe(true);
  });

  it('keeps strengths empty for a no-data profile', () => {
    const payload = buildTestPayload((input) => {
      input.profile.dataQuality = 'NONE';
      input.profile.knowledgeSignals = [];
      input.profile.recentWrongSignals = [];
      input.profile.overall = {
        submittedAttempts30d: 0,
        answeredQuestions30d: 0,
        accuracyBps30d: null,
        activeDays30d: 0,
        overdueKnowledgeCount: 0,
        overdueChapterCount: 0,
      };
    });
    const result = buildDeterministicFallback(payload, 'NO_MODEL');
    expect(result.output.learningSummary).toMatchObject({
      headline: '当前学习记录不足',
      dataQuality: 'NONE',
      strengths: [],
      priorities: [],
    });
  });

  it('uses the administrator or user suggested question count within the dynamic range', () => {
    const payload = buildTestPayload((input) => {
      input.inputPolicy.questionCount = { minimum: 5, maximum: 8 };
      const extra = ['Q006', 'Q007', 'Q008', 'Q009'].map(
        (questionAlias, index) => ({
          questionAlias,
          knowledgeAliases: ['K001'],
          chapterAliases: ['C001'],
          gradingType: 'SINGLE' as const,
          typeLabel: '选择题',
          promptExcerpt: `${questionAlias} 的课程题干`,
          priorityScore: 50 - index,
          daysSinceLastSeen: null,
        }),
      );
      input.candidateQuestions.push(...extra);
      input.inputPolicy.allowedQuestionAliases.push(
        ...extra.map((question) => question.questionAlias),
      );
      input.suggestion = {
        userSuggestion: {
          intensity: 'STANDARD',
          desiredQuestionCount: 6,
          focusSubjectNames: [],
          focusChapterAliases: [],
          note: '',
        },
        adminSuggestion: null,
      };
    });

    expect(
      buildDeterministicFallback(payload, 'MODEL_UNAVAILABLE').output
        .selectedQuestions,
    ).toHaveLength(6);

    payload.suggestion.adminSuggestion = {
      intensity: 'CHALLENGING',
      desiredQuestionCount: 7,
      focusSubjectNames: [],
      focusChapterAliases: [],
      note: '',
    };
    expect(
      buildDeterministicFallback(payload, 'MODEL_UNAVAILABLE').output
        .selectedQuestions,
    ).toHaveLength(7);
  });
});
