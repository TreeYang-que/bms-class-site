import Ajv, { type ErrorObject } from 'ajv';
import {
  DAILY_PERSONALIZATION_PROMPT_VERSION,
  assertDailyPersonalizationPayload,
  type DailyDataQuality,
  type DailyPersonalizationPayload,
} from './prompt';

export type SuggestionEvaluationStatus =
  | 'NONE'
  | 'APPLIED'
  | 'PARTIALLY_APPLIED'
  | 'NOT_APPLIED';

export interface LearningSummaryItem {
  knowledgeAlias: string;
  text: string;
  evidenceRefs: string[];
}

export interface DailyPersonalizationOutput {
  schemaVersion: typeof DAILY_PERSONALIZATION_PROMPT_VERSION;
  learningSummary: {
    headline: string;
    overview: string;
    dataQuality: DailyDataQuality;
    strengths: LearningSummaryItem[];
    priorities: LearningSummaryItem[];
  };
  selectedKnowledge: Array<{
    knowledgeAlias: string;
    reason: string;
    evidenceRefs: string[];
  }>;
  selectedQuestions: Array<{
    questionAlias: string;
    reason: string;
    evidenceRefs: string[];
  }>;
  suggestionEvaluation: {
    status: SuggestionEvaluationStatus;
    message: string;
  };
}

export type DailyPersonalizationValidationCode =
  | 'INVALID_JSON'
  | 'SCHEMA_INVALID'
  | 'UNSAFE_TEXT'
  | 'LANGUAGE_INVALID'
  | 'ALIAS_INVALID'
  | 'COUNT_INVALID'
  | 'MANDATORY_MISSING'
  | 'SHORT_ANSWER_LIMIT';

export class DailyPersonalizationValidationError extends Error {
  constructor(
    readonly code: DailyPersonalizationValidationCode,
    message: string,
    readonly schemaErrors: ErrorObject[] = [],
  ) {
    super(message);
    this.name = 'DailyPersonalizationValidationError';
  }
}

const evidenceRefsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  uniqueItems: true,
  items: { type: 'string', minLength: 1, maxLength: 20 },
} as const;

const summaryItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['knowledgeAlias', 'text', 'evidenceRefs'],
  properties: {
    knowledgeAlias: { type: 'string', minLength: 4, maxLength: 20 },
    text: { type: 'string', minLength: 1, maxLength: 100 },
    evidenceRefs: evidenceRefsSchema,
  },
} as const;

export const DAILY_PERSONALIZATION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'learningSummary',
    'selectedKnowledge',
    'selectedQuestions',
    'suggestionEvaluation',
  ],
  properties: {
    schemaVersion: { const: DAILY_PERSONALIZATION_PROMPT_VERSION },
    learningSummary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'headline',
        'overview',
        'dataQuality',
        'strengths',
        'priorities',
      ],
      properties: {
        headline: { type: 'string', minLength: 1, maxLength: 40 },
        overview: { type: 'string', minLength: 1, maxLength: 220 },
        dataQuality: { enum: ['SUFFICIENT', 'LIMITED', 'NONE'] },
        strengths: {
          type: 'array',
          maxItems: 3,
          items: summaryItemSchema,
        },
        priorities: {
          type: 'array',
          maxItems: 5,
          items: summaryItemSchema,
        },
      },
    },
    selectedKnowledge: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['knowledgeAlias', 'reason', 'evidenceRefs'],
        properties: {
          knowledgeAlias: { type: 'string', minLength: 4, maxLength: 20 },
          reason: { type: 'string', minLength: 1, maxLength: 100 },
          evidenceRefs: evidenceRefsSchema,
        },
      },
    },
    selectedQuestions: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['questionAlias', 'reason', 'evidenceRefs'],
        properties: {
          questionAlias: { type: 'string', minLength: 4, maxLength: 20 },
          reason: { type: 'string', minLength: 1, maxLength: 100 },
          evidenceRefs: evidenceRefsSchema,
        },
      },
    },
    suggestionEvaluation: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'message'],
      properties: {
        status: {
          enum: ['NONE', 'APPLIED', 'PARTIALLY_APPLIED', 'NOT_APPLIED'],
        },
        message: { type: 'string', minLength: 1, maxLength: 160 },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile<DailyPersonalizationOutput>(
  DAILY_PERSONALIZATION_OUTPUT_SCHEMA,
);

export function parseDailyPersonalizationOutput(
  content: string,
  payload: DailyPersonalizationPayload,
): DailyPersonalizationOutput {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new DailyPersonalizationValidationError(
      'INVALID_JSON',
      'model output must be one JSON object',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new DailyPersonalizationValidationError(
      'INVALID_JSON',
      'model output is not valid JSON',
    );
  }
  return validateDailyPersonalizationOutput(parsed, payload);
}

export function validateDailyPersonalizationOutput(
  value: unknown,
  payload: DailyPersonalizationPayload,
): DailyPersonalizationOutput {
  assertDailyPersonalizationPayload(payload);
  if (!validateSchema(value)) {
    throw new DailyPersonalizationValidationError(
      'SCHEMA_INVALID',
      'model output does not match the strict response schema',
      validateSchema.errors ?? [],
    );
  }
  assertSafeOutputText(value);
  assertBusinessContract(value, payload);
  return value;
}

function assertBusinessContract(
  output: DailyPersonalizationOutput,
  payload: DailyPersonalizationPayload,
) {
  const policy = payload.inputPolicy;
  const allowedKnowledge = new Set(policy.allowedKnowledgeAliases);
  const allowedQuestions = new Set(policy.allowedQuestionAliases);
  const allowedSignals = new Set(policy.allowedSignalAliases);
  const fixedAliases = new Set(policy.fixedQuestionAliases);

  const knowledgeReferences = [
    ...output.learningSummary.strengths,
    ...output.learningSummary.priorities,
    ...output.selectedKnowledge,
  ];
  if (knowledgeReferences.some((item) => !allowedKnowledge.has(item.knowledgeAlias))) {
    aliasError('output contains a knowledge alias outside the whitelist');
  }
  if (
    output.selectedQuestions.some(
      (item) => !allowedQuestions.has(item.questionAlias),
    )
  ) {
    aliasError('output contains a question alias outside the whitelist');
  }
  const allEvidenceItems = [
    ...output.learningSummary.strengths,
    ...output.learningSummary.priorities,
    ...output.selectedKnowledge,
    ...output.selectedQuestions,
  ];
  for (const item of allEvidenceItems) {
    if (
      !item.evidenceRefs.length ||
      new Set(item.evidenceRefs).size !== item.evidenceRefs.length ||
      item.evidenceRefs.some((alias) => !allowedSignals.has(alias))
    ) {
      aliasError('evidenceRefs must be unique current signal aliases');
    }
  }
  const serialized = JSON.stringify(output);
  if (
    /F\d{3,}/u.test(serialized) ||
    [...fixedAliases].some((alias) => serialized.includes(alias))
  ) {
    aliasError('fixed question aliases must never appear in model output');
  }

  assertUniqueSelectedAliases(
    output.selectedKnowledge.map((item) => item.knowledgeAlias),
    'selectedKnowledge',
  );
  const selectedQuestionAliases = output.selectedQuestions.map(
    (item) => item.questionAlias,
  );
  assertUniqueSelectedAliases(selectedQuestionAliases, 'selectedQuestions');
  if (
    output.selectedKnowledge.length < policy.knowledgeCount.minimum ||
    output.selectedKnowledge.length > policy.knowledgeCount.maximum
  ) {
    countError('selectedKnowledge count is outside the dynamic range');
  }
  if (
    output.selectedQuestions.length < policy.questionCount.minimum ||
    output.selectedQuestions.length > policy.questionCount.maximum
  ) {
    countError('selectedQuestions count is outside the personalized range');
  }
  const selectedSet = new Set(selectedQuestionAliases);
  if (policy.mandatoryQuestionAliases.some((alias) => !selectedSet.has(alias))) {
    throw new DailyPersonalizationValidationError(
      'MANDATORY_MISSING',
      'model output omitted a mandatory question',
    );
  }
  const questionsByAlias = new Map(
    payload.candidateQuestions.map((question) => [question.questionAlias, question]),
  );
  const shortAnswers = selectedQuestionAliases.filter(
    (alias) => questionsByAlias.get(alias)?.gradingType === 'SHORT_ANSWER',
  ).length;
  const fixedShortAnswers = payload.fixedQuestions.filter((question) => question.gradingType === 'SHORT_ANSWER').length;
  if (shortAnswers + fixedShortAnswers > policy.maxShortAnswerQuestionCount) {
    throw new DailyPersonalizationValidationError(
      'SHORT_ANSWER_LIMIT',
      'model output selected too many short-answer questions',
    );
  }
  if (policy.courseQuestionCounts) {
    for (const quota of policy.courseQuestionCounts) {
      const actual = selectedQuestionAliases.filter(
        (alias) => questionsByAlias.get(alias)?.courseAlias === quota.courseAlias,
      ).length;
      if (actual !== quota.count) countError('selectedQuestions violates course allocation');
    }
  }
  if (policy.courseBucketQuestionCounts) {
    for (const quota of policy.courseBucketQuestionCounts) {
      const actual = selectedQuestionAliases.filter((alias) => {
        const question = questionsByAlias.get(alias);
        return question?.courseAlias === quota.courseAlias && question.selectionBucket === quota.bucket;
      }).length;
      if (actual !== quota.count) countError('selectedQuestions violates course bucket allocation');
    }
  }
  if (
    output.learningSummary.dataQuality === 'NONE' &&
    output.learningSummary.strengths.length
  ) {
    countError('strengths must be empty when dataQuality is NONE');
  }
}

function assertSafeOutputText(output: DailyPersonalizationOutput) {
  const texts = [
    output.learningSummary.headline,
    output.learningSummary.overview,
    ...output.learningSummary.strengths.map((item) => item.text),
    ...output.learningSummary.priorities.map((item) => item.text),
    ...output.selectedKnowledge.map((item) => item.reason),
    ...output.selectedQuestions.map((item) => item.reason),
    output.suggestionEvaluation.message,
  ];
  for (const value of texts) {
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
      unsafeText('control characters are not allowed');
    }
    if (/```|\[[^\]]*\]\([^)]*\)|<\/?[A-Za-z][^>]*>/u.test(value)) {
      unsafeText('HTML, Markdown links, and code fences are not allowed');
    }
    if (!hasSimplifiedChineseContext(value)) {
      throw new DailyPersonalizationValidationError(
        'LANGUAGE_INVALID',
        'human-facing output must contain Simplified Chinese context',
      );
    }
  }
}

function hasSimplifiedChineseContext(value: string) {
  const hanCount = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) ?? []).length;
  const latinCount = (value.match(/[A-Za-z]/gu) ?? []).length;
  if (hanCount === 0) return false;
  if (latinCount <= 4) return true;
  return hanCount / (hanCount + latinCount) >= 0.2;
}

function assertUniqueSelectedAliases(values: string[], name: string) {
  if (new Set(values).size !== values.length) {
    aliasError(`${name} aliases must be unique`);
  }
}

function aliasError(message: string): never {
  throw new DailyPersonalizationValidationError('ALIAS_INVALID', message);
}

function countError(message: string): never {
  throw new DailyPersonalizationValidationError('COUNT_INVALID', message);
}

function unsafeText(message: string): never {
  throw new DailyPersonalizationValidationError('UNSAFE_TEXT', message);
}
