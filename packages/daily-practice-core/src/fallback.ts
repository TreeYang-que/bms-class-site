import {
  validateDailyPersonalizationOutput,
  type DailyPersonalizationOutput,
  type SuggestionEvaluationStatus,
} from './output';
import type {
  CandidateKnowledgePayload,
  CandidateQuestionPayload,
  DailyKnowledgeSignal,
  DailyPersonalizationPayload,
} from './prompt';
import { DAILY_PERSONALIZATION_PROMPT_VERSION } from './prompt';
import { selectCurriculumQuestions, selectCurriculumQuestionsWithinQuotas } from './candidate';

export interface DeterministicFallbackResult {
  generationSource: 'DETERMINISTIC';
  degradedReason: string;
  output: DailyPersonalizationOutput;
}

export function buildDeterministicFallback(
  payload: DailyPersonalizationPayload,
  degradedReason: string,
): DeterministicFallbackResult {
  const defaultEvidence = payload.inputPolicy.allowedSignalAliases[0];
  if (
    !defaultEvidence &&
    (payload.inputPolicy.questionCount.minimum > 0 ||
      payload.inputPolicy.knowledgeCount.minimum > 0)
  ) {
    throw new RangeError(
      'deterministic selection requires a current data-quality signal alias',
    );
  }
  const signalByKnowledge = new Map(
    payload.profile.knowledgeSignals.map((signal) => [signal.knowledgeAlias, signal]),
  );
  const evidenceForKnowledge = (knowledgeAlias: string): string[] => {
    const signal = signalByKnowledge.get(knowledgeAlias);
    return signal ? [signal.signalAlias] : defaultEvidence ? [defaultEvidence] : [];
  };

  const targetQuestionCount = deterministicTargetQuestionCount(payload);
  const selectedQuestions = deterministicQuestionOrder(
    payload,
    targetQuestionCount,
  ).map((question) => ({
    questionAlias: question.questionAlias,
    reason: payload.inputPolicy.mandatoryQuestionAliases.includes(
      question.questionAlias,
    )
      ? '该题属于当前高风险或逾期项目，按规则必须优先复习。'
      : '该题的复习优先级较高，按规则纳入今日练习。',
    evidenceRefs: evidenceForQuestion(question, payload, defaultEvidence),
  }));

  const selectedKnowledge = deterministicKnowledgeOrder(
    payload,
    selectedQuestions.map((item) => item.questionAlias),
  ).map((knowledge) => ({
    knowledgeAlias: knowledge.knowledgeAlias,
    reason: '该知识点的当前复习优先级较高，按规则纳入今日重点。',
    evidenceRefs: evidenceForKnowledge(knowledge.knowledgeAlias),
  }));

  const strengths = deterministicStrengths(payload.profile.knowledgeSignals).map(
    (signal) => ({
      knowledgeAlias: signal.knowledgeAlias,
      text: `该知识点近期掌握度为${formatPercent(signal.masteryBps)}，已有可观察的稳定表现。`,
      evidenceRefs: [signal.signalAlias],
    }),
  );
  const priorities = deterministicPriorities(payload.profile.knowledgeSignals).map(
    (signal) => ({
      knowledgeAlias: signal.knowledgeAlias,
      text: priorityText(signal),
      evidenceRefs: [signal.signalAlias],
    }),
  );
  const suggestion = activeSuggestion(payload);
  const suggestionStatus = suggestionEvaluationStatus(
    suggestion?.desiredQuestionCount,
    selectedQuestions.length,
  );
  const output: DailyPersonalizationOutput = {
    schemaVersion: DAILY_PERSONALIZATION_PROMPT_VERSION,
    learningSummary: {
      headline: summaryHeadline(payload),
      overview: summaryOverview(payload),
      dataQuality: payload.profile.dataQuality,
      strengths: payload.profile.dataQuality === 'NONE' ? [] : strengths,
      priorities,
    },
    selectedKnowledge,
    selectedQuestions,
    suggestionEvaluation: {
      status: suggestionStatus,
      message: suggestionEvaluationMessage(suggestionStatus),
    },
  };
  return {
    generationSource: 'DETERMINISTIC',
    degradedReason: boundedReason(degradedReason),
    output: validateDailyPersonalizationOutput(output, payload),
  };
}

function deterministicQuestionOrder(
  payload: DailyPersonalizationPayload,
  targetQuestionCount: number,
): CandidateQuestionPayload[] {
  if (payload.inputPolicy.courseQuestionCounts) {
    const weights = new Map(payload.inputPolicy.courseQuestionCounts.map((quota) => [quota.courseAlias, Math.max(1, quota.count)]));
    const candidates = payload.candidateQuestions.map((question, index) => ({
      ...question,
      questionId: question.questionAlias,
      courseId: question.courseAlias!,
      bucket: question.selectionBucket ?? 'COVERAGE',
      reviewUrgency: 0,
      errorRisk: 0,
      masteryBps: null,
      coverageDebt: 0,
      seenWithin24Hours: false,
      suggestionMatch: 0,
      mandatory: payload.inputPolicy.mandatoryQuestionAliases.includes(question.questionAlias),
      tieBreakHash: String(index).padStart(8, '0'),
    }));
    const result = payload.inputPolicy.courseBucketQuestionCounts
      ? selectCurriculumQuestionsWithinQuotas(candidates, payload.inputPolicy.courseBucketQuestionCounts.map((quota) => ({ courseId: quota.courseAlias, bucket: quota.bucket, count: quota.count })))
      : selectCurriculumQuestions(candidates, targetQuestionCount, weights, Object.fromEntries(payload.inputPolicy.courseQuestionCounts.map((quota) => [quota.courseAlias, quota.count])));
    if (result.length < targetQuestionCount) throw new RangeError('insufficient curriculum candidates');
    return result;
  }
  const byAlias = new Map(
    payload.candidateQuestions.map((question, index) => [
      question.questionAlias,
      { question, index },
    ]),
  );
  const ordered = [...payload.candidateQuestions]
    .map((question, index) => ({ question, index }))
    .sort(
      (left, right) =>
        right.question.priorityScore - left.question.priorityScore ||
        left.index - right.index,
    );
  const result: CandidateQuestionPayload[] = [];
  const selected = new Set<string>();
  let shortAnswers = 0;
  const append = (question: CandidateQuestionPayload) => {
    if (
      result.length >= targetQuestionCount ||
      selected.has(question.questionAlias)
    ) {
      return;
    }
    if (question.gradingType === 'SHORT_ANSWER') {
      if (shortAnswers >= payload.inputPolicy.maxShortAnswerQuestionCount) return;
      shortAnswers += 1;
    }
    selected.add(question.questionAlias);
    result.push(question);
  };
  for (const alias of payload.inputPolicy.mandatoryQuestionAliases) {
    const mandatory = byAlias.get(alias)?.question;
    if (!mandatory) throw new RangeError('mandatory question is missing');
    append(mandatory);
  }
  ordered.forEach(({ question }) => append(question));
  if (result.length < targetQuestionCount) {
    throw new RangeError('deterministic fallback could not meet questionCount');
  }
  return result;
}

function deterministicTargetQuestionCount(payload: DailyPersonalizationPayload) {
  const range = payload.inputPolicy.questionCount;
  const requested = activeSuggestion(payload)?.desiredQuestionCount;
  if (requested === undefined) return range.maximum;
  return Math.max(range.minimum, Math.min(range.maximum, requested));
}

function deterministicKnowledgeOrder(
  payload: DailyPersonalizationPayload,
  selectedQuestionAliases: string[],
): CandidateKnowledgePayload[] {
  const selectedQuestions = new Set(selectedQuestionAliases);
  const preferredAliases: string[] = [];
  for (const question of payload.candidateQuestions) {
    if (!selectedQuestions.has(question.questionAlias)) continue;
    for (const alias of question.knowledgeAliases) {
      if (!preferredAliases.includes(alias)) preferredAliases.push(alias);
    }
  }
  const indexByAlias = new Map(
    payload.candidateKnowledge.map((knowledge, index) => [
      knowledge.knowledgeAlias,
      { knowledge, index },
    ]),
  );
  const remaining = [...payload.candidateKnowledge]
    .map((knowledge, index) => ({ knowledge, index }))
    .sort(
      (left, right) =>
        right.knowledge.reviewPriority - left.knowledge.reviewPriority ||
        left.index - right.index,
    )
    .map(({ knowledge }) => knowledge.knowledgeAlias);
  const order = [...preferredAliases, ...remaining].filter(
    (alias, index, all) => all.indexOf(alias) === index,
  );
  const result = order
    .map((alias) => indexByAlias.get(alias)?.knowledge)
    .filter((value): value is CandidateKnowledgePayload => Boolean(value))
    .slice(0, payload.inputPolicy.knowledgeCount.maximum);
  if (result.length < payload.inputPolicy.knowledgeCount.minimum) {
    throw new RangeError('deterministic fallback could not meet knowledgeCount');
  }
  return result;
}

function deterministicStrengths(
  signals: DailyKnowledgeSignal[],
): DailyKnowledgeSignal[] {
  return [...signals]
    .filter((signal) => signal.attemptCount > 0 && signal.masteryBps >= 8_000)
    .sort(
      (left, right) =>
        right.masteryBps - left.masteryBps ||
        right.correctStreak - left.correctStreak ||
        compareAscii(left.signalAlias, right.signalAlias),
    )
    .slice(0, 3);
}

function deterministicPriorities(
  signals: DailyKnowledgeSignal[],
): DailyKnowledgeSignal[] {
  const dueRank = { OVERDUE: 2, DUE: 1, NOT_DUE: 0 } as const;
  return [...signals]
    .filter(
      (signal) =>
        signal.reviewDue !== 'NOT_DUE' ||
        signal.wrongCount > 0 ||
        signal.masteryBps < 8_000,
    )
    .sort(
      (left, right) =>
        dueRank[right.reviewDue] - dueRank[left.reviewDue] ||
        right.wrongCount - left.wrongCount ||
        left.masteryBps - right.masteryBps ||
        compareAscii(left.signalAlias, right.signalAlias),
    )
    .slice(0, 5);
}

function evidenceForQuestion(
  question: CandidateQuestionPayload,
  payload: DailyPersonalizationPayload,
  defaultEvidence: string | undefined,
): string[] {
  const wrong = payload.profile.recentWrongSignals.find(
    (signal) => signal.questionAlias === question.questionAlias,
  );
  if (wrong) return [wrong.signalAlias];
  const knowledge = payload.profile.knowledgeSignals.find((signal) =>
    question.knowledgeAliases.includes(signal.knowledgeAlias),
  );
  return knowledge
    ? [knowledge.signalAlias]
    : defaultEvidence
      ? [defaultEvidence]
      : [];
}

function summaryHeadline(payload: DailyPersonalizationPayload) {
  if (payload.profile.dataQuality === 'NONE') return '当前学习记录不足';
  const accuracy = payload.profile.overall.accuracyBps30d;
  if (accuracy === null) return '近期学习数据仍需积累';
  if (accuracy >= 8_000) return '近期学习状态较为稳定';
  if (accuracy >= 6_000) return '近期基础表现仍可提升';
  return '近期复习需要优先巩固';
}

function summaryOverview(payload: DailyPersonalizationPayload) {
  const overall = payload.profile.overall;
  if (payload.profile.dataQuality === 'NONE') {
    return '当前缺少足够的已提交练习记录，暂时只能按已发布教学范围安排基础练习。';
  }
  const accuracy =
    overall.accuracyBps30d === null
      ? '暂无可计算正确率'
      : `正确率约为${formatPercent(overall.accuracyBps30d)}`;
  return `近三十日已提交${overall.submittedAttempts30d}次练习，回答${overall.answeredQuestions30d}道题，${accuracy}；当前有${overall.overdueKnowledgeCount}个课程主题和${overall.overdueChapterCount}个章节需要复习。`;
}

function priorityText(signal: DailyKnowledgeSignal) {
  if (signal.reviewDue === 'OVERDUE') {
    return `该知识点已经逾期复习，当前掌握度为${formatPercent(signal.masteryBps)}。`;
  }
  if (signal.reviewDue === 'DUE') {
    return `该知识点已到复习时间，当前掌握度为${formatPercent(signal.masteryBps)}。`;
  }
  return `该知识点累计错误${signal.wrongCount}次，当前掌握度为${formatPercent(signal.masteryBps)}。`;
}

function activeSuggestion(payload: DailyPersonalizationPayload) {
  return payload.suggestion.adminSuggestion ?? payload.suggestion.userSuggestion;
}

function suggestionEvaluationStatus(
  desiredQuestionCount: number | undefined,
  selectedQuestionCount: number,
): SuggestionEvaluationStatus {
  if (desiredQuestionCount === undefined) return 'NONE';
  if (selectedQuestionCount === 0) return 'NOT_APPLIED';
  return selectedQuestionCount === desiredQuestionCount
    ? 'APPLIED'
    : 'PARTIALLY_APPLIED';
}

function suggestionEvaluationMessage(status: SuggestionEvaluationStatus) {
  if (status === 'NONE') return '今日没有待处理的学习建议。';
  if (status === 'APPLIED') return '建议题量已在服务端规则允许的范围内采纳。';
  if (status === 'PARTIALLY_APPLIED') {
    return '建议已部分采纳，最终安排仍受候选数量和服务端规则限制。';
  }
  return '当前候选不足，今日未能采纳该建议。';
}

function formatPercent(bps: number) {
  return `${Math.round(bps / 100)}%`;
}

function boundedReason(value: string) {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(normalized || 'MODEL_UNAVAILABLE').slice(0, 120).join('');
}

function compareAscii(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
