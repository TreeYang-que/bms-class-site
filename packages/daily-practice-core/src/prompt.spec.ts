import { createHash } from 'node:crypto';
import {
  DAILY_PERSONALIZATION_PROMPT_VERSION,
  DAILY_PERSONALIZATION_SYSTEM_PROMPT,
  buildDailyPersonalizationPayload,
  projectPreviousLearningSummary,
  serializeDailyPersonalizationPayload,
} from './prompt';
import { buildTestPayload } from './test-fixture';

const priorSummary = {
  dataQuality: 'LIMITED',
  headline: '昨日记录仍然有限',
  overview: '昨日主要完成了基础练习，当前信号仍应优先。',
  strengths: [
    {
      knowledgeAlias: 'K999',
      text: '基础概念已有一定稳定表现。',
      evidenceRefs: ['S999'],
    },
  ],
  priorities: [
    {
      knowledgeAlias: 'K998',
      text: '继续复习跨膜转运的关键机制。',
      evidenceRefs: ['S998'],
    },
  ],
  previousLearningSummary: { nested: true },
};

describe('daily personalization prompt', () => {
  it('pins the reviewed system prompt as one exact versioned message', () => {
    expect(DAILY_PERSONALIZATION_PROMPT_VERSION).toBe('daily-personalization-v3');
    expect(
      createHash('sha256')
        .update(DAILY_PERSONALIZATION_SYSTEM_PROMPT, 'utf8')
        .digest('hex'),
    ).toBe('18f61af2ee22d7b3dff711451213056183a315eb5aa323e689624327fd28468d');
  });

  it('serializes null history, null suggestions, and fixed-question fields explicitly', () => {
    const payload = buildTestPayload();
    const serialized = JSON.parse(serializeDailyPersonalizationPayload(payload));
    expect(serialized.previousLearningSummary).toBeNull();
    expect(serialized.suggestion).toEqual({
      userSuggestion: null,
      adminSuggestion: null,
      precedence: '当两者冲突时优先考虑 adminSuggestion，但仍必须服从 inputPolicy。',
    });
    expect(serialized.inputPolicy).toMatchObject({
      fixedQuestionCount: 1,
      fixedQuestionAliases: ['F001'],
      maxShortAnswerQuestionCount: 1,
    });
    expect(serialized.fixedQuestions).toHaveLength(1);
    expect(Object.keys(serialized)).toEqual([
      'task',
      'schemaVersion',
      'practiceDate',
      'timeZone',
      'inputPolicy',
      'profile',
      'previousLearningSummary',
      'candidateKnowledge',
      'candidateQuestions',
      'fixedQuestions',
      'suggestion',
      'responseContract',
    ]);
  });

  it('projects only bounded prior text at the inclusive 14-day boundary', () => {
    const projected = projectPreviousLearningSummary('2026-07-28', '2026-07-14', {
      practiceDate: '2026-07-14',
      generationSource: 'PRO_MAX',
      trigger: 'AUTO',
      published: true,
      validated: true,
      learningSummary: priorSummary,
    });
    expect(projected).toEqual({
      practiceDate: '2026-07-14',
      ageInDays: 14,
      generationSource: 'PRO_MAX',
      dataQuality: 'LIMITED',
      headline: '昨日记录仍然有限',
      overview: '昨日主要完成了基础练习，当前信号仍应优先。',
      strengths: ['基础概念已有一定稳定表现。'],
      priorities: ['继续复习跨膜转运的关键机制。'],
    });
    expect(JSON.stringify(projected)).not.toMatch(/K999|S999|nested/u);
  });

  it('returns null at 15 days and for every excluded source or preview', () => {
    const base = {
      practiceDate: '2026-07-13',
      generationSource: 'PRO_MAX',
      trigger: 'AUTO',
      published: true,
      validated: true,
      learningSummary: priorSummary,
    };
    expect(
      projectPreviousLearningSummary('2026-07-28', '2026-07-13', base),
    ).toBeNull();
    for (const generationSource of [
      'DETERMINISTIC',
      'NO_MODEL',
      'ADMIN_PREVIEW',
    ]) {
      expect(
        projectPreviousLearningSummary('2026-07-28', '2026-07-27', {
          ...base,
          practiceDate: '2026-07-27',
          generationSource,
        }),
      ).toBeNull();
    }
    expect(
      projectPreviousLearningSummary('2026-07-28', '2026-07-27', {
        ...base,
        practiceDate: '2026-07-27',
        trigger: 'ADMIN_PREVIEW',
      }),
    ).toBeNull();
    expect(
      projectPreviousLearningSummary('2026-07-28', '2026-07-27', {
        ...base,
        practiceDate: '2026-07-27',
        published: false,
      }),
    ).toBeNull();
  });

  it('rejects an impossible mandatory short-answer contract before calling a model', () => {
    expect(() =>
      buildTestPayload((input) => {
        input.inputPolicy.mandatoryQuestionAliases = ['Q002', 'Q003'];
      }),
    ).toThrow('mandatory questions exceed the short-answer limit');
  });

  it('builds a default-empty fixed assignment without omitting fields', () => {
    const original = buildTestPayload();
    const payload = buildDailyPersonalizationPayload({
      practiceDate: original.practiceDate,
      inputPolicy: {
        ...original.inputPolicy,
        fixedQuestionCount: 0,
        fixedQuestionAliases: [],
      },
      profile: original.profile,
      previousLearningSummary: null,
      candidateKnowledge: original.candidateKnowledge,
      candidateQuestions: original.candidateQuestions,
      fixedQuestions: [],
    });
    expect(payload.inputPolicy.fixedQuestionCount).toBe(0);
    expect(payload.inputPolicy.fixedQuestionAliases).toEqual([]);
    expect(payload.fixedQuestions).toEqual([]);
  });

  it('strictly validates history objects, grading types, and knowledge signals', () => {
    const baseline = buildTestPayload();
    expect(() =>
      buildDailyPersonalizationPayload({
        practiceDate: baseline.practiceDate,
        inputPolicy: baseline.inputPolicy,
        profile: baseline.profile,
        previousLearningSummary: {
          practiceDate: '2026-07-27',
          ageInDays: 1,
          generationSource: 'PRO_MAX',
          dataQuality: 'LIMITED',
          headline: '记录有限',
          overview: '当前记录有限。',
          strengths: [],
          priorities: [],
          unexpected: true,
        } as never,
        candidateKnowledge: baseline.candidateKnowledge,
        candidateQuestions: baseline.candidateQuestions,
        fixedQuestions: baseline.fixedQuestions,
      }),
    ).toThrow('previousLearningSummary contains unexpected or missing fields');

    expect(() =>
      buildTestPayload((input) => {
        input.fixedQuestions[0]!.gradingType = 'ESSAY' as never;
      }),
    ).toThrow('invalid fixed question gradingType');
    expect(() =>
      buildTestPayload((input) => {
        input.profile.recentWrongSignals[0]!.gradingType = 'ESSAY' as never;
      }),
    ).toThrow('invalid wrong signal gradingType');
    expect(() =>
      buildTestPayload((input) => {
        input.profile.knowledgeSignals[0]!.knowledgeAlias = 'K999';
      }),
    ).toThrow('knowledge signal references an unknown knowledge alias');
  });
});
