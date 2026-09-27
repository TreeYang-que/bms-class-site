import { createHash } from 'node:crypto';
import {
  DAILY_PRACTICE_SPREAD_WINDOW_MS,
  practiceDayWindow,
} from './time';

export const DAILY_PRACTICE_GRADING_TYPES = [
  'SINGLE',
  'MULTIPLE',
  'TRUE_FALSE',
  'SHORT_ANSWER',
] as const;

export type DailyPracticeGradingType =
  (typeof DAILY_PRACTICE_GRADING_TYPES)[number];

export interface CandidateScoreInput {
  questionId: string;
  gradingType: DailyPracticeGradingType;
  reviewUrgency: number;
  errorRisk: number;
  masteryBps: number | null;
  coverageDebt: number;
  seenWithin24Hours: boolean;
  suggestionMatch: number;
  mandatoryEligible?: boolean;
}

export interface ScoredCandidate extends CandidateScoreInput {
  priorityScore: number;
  tieBreakHash: string;
  mandatory: boolean;
}

export type CurriculumQuestionBucket = 'RECENT' | 'REVIEW' | 'COVERAGE';

export interface CurriculumScoredCandidate extends ScoredCandidate {
  courseId: string;
  bucket: CurriculumQuestionBucket;
}

export interface CurriculumBucketQuota {
  courseId: string;
  bucket: CurriculumQuestionBucket;
  count: number;
}

type CurriculumQuotaCandidate = Pick<CurriculumScoredCandidate,
  'questionId' | 'courseId' | 'bucket' | 'gradingType' | 'priorityScore' | 'tieBreakHash' | 'mandatory'>;

/** Selects exact frozen bucket counts, reserving the single short-answer slot where needed. */
export function selectCurriculumQuestionsWithinQuotas<T extends CurriculumQuotaCandidate>(
  candidates: readonly T[],
  quotas: readonly CurriculumBucketQuota[],
): T[] {
  const ordered = [...candidates].sort(compareScoredCandidates);
  const mandatory = ordered.filter((candidate) => candidate.mandatory);
  const mandatoryShortAnswers = mandatory.filter((candidate) => candidate.gradingType === 'SHORT_ANSWER').length;
  if (mandatoryShortAnswers > 1) throw new RangeError('mandatory questions exceed the short-answer limit');
  const key = (item: { courseId: string; bucket: CurriculumQuestionBucket }) => `${item.courseId}\0${item.bucket}`;
  const keys = new Set(quotas.map(key));
  if (keys.size !== quotas.length || ordered.some((candidate) => !keys.has(key(candidate)))) {
    throw new RangeError('invalid curriculum bucket allocation');
  }
  let states = new Map<number, { selected: T[]; score: number }>([[mandatoryShortAnswers, { selected: [], score: 0 }]]);
  for (const quota of quotas) {
    integerInRange(quota.count, 0, 10, 'bucket count');
    const pool = ordered.filter((candidate) => key(candidate) === key(quota));
    const remaining = quota.count - pool.filter((candidate) => candidate.mandatory).length;
    if (remaining < 0) throw new RangeError('mandatory questions exceed bucket allocation');
    const ordinary = pool.filter((candidate) => !candidate.mandatory && candidate.gradingType !== 'SHORT_ANSWER');
    const shortAnswer = pool.find((candidate) => !candidate.mandatory && candidate.gradingType === 'SHORT_ANSWER');
    const options: Array<{ shortAnswers: number; selected: T[] }> = [];
    if (ordinary.length >= remaining) options.push({ shortAnswers: 0, selected: ordinary.slice(0, remaining) });
    if (remaining > 0 && shortAnswer && ordinary.length >= remaining - 1) {
      options.push({ shortAnswers: 1, selected: [shortAnswer, ...ordinary.slice(0, remaining - 1)].sort(compareScoredCandidates) });
    }
    const next = new Map<number, { selected: T[]; score: number }>();
    for (const [used, state] of states) {
      for (const option of options) {
        const totalShortAnswers = used + option.shortAnswers;
        if (totalShortAnswers > 1) continue;
        const score = state.score + option.selected.reduce((sum, candidate) => sum + candidate.priorityScore, 0);
        if (!next.has(totalShortAnswers) || score > next.get(totalShortAnswers)!.score) {
          next.set(totalShortAnswers, { selected: [...state.selected, ...option.selected], score });
        }
      }
    }
    states = next;
  }
  const best = [...states.values()].sort((left, right) => right.score - left.score)[0];
  if (!best) throw new RangeError('infeasible curriculum bucket allocation');
  return [...mandatory, ...best.selected];
}

/** Largest remainders with capacity redistribution. Input order breaks equal remainders. */
export function allocateWeightedCounts(
  total: number,
  groups: readonly { key: string; weight: number; capacity: number }[],
): Record<string, number> {
  integerInRange(total, 0, Number.MAX_SAFE_INTEGER, 'total');
  const result = Object.fromEntries(groups.map((group) => [group.key, 0]));
  if (new Set(groups.map((group) => group.key)).size !== groups.length) {
    throw new RangeError('allocation keys must be unique');
  }
  for (const group of groups) {
    if (!Number.isFinite(group.weight) || group.weight <= 0) {
      throw new RangeError('allocation weights must be positive');
    }
    integerInRange(group.capacity, 0, Number.MAX_SAFE_INTEGER, 'capacity');
  }
  let remaining = Math.min(total, groups.reduce((sum, group) => sum + group.capacity, 0));
  while (remaining > 0) {
    const available = groups.filter((group) => result[group.key]! < group.capacity);
    const weight = available.reduce((sum, group) => sum + group.weight, 0);
    const shares = available.map((group, index) => {
      const exact = (remaining * group.weight) / weight;
      return { group, index, exact, whole: Math.min(Math.floor(exact), group.capacity - result[group.key]!) };
    });
    for (const { group, whole } of shares) {
      result[group.key]! += whole;
      remaining -= whole;
    }
    shares.sort((left, right) =>
      (right.exact - Math.floor(right.exact)) - (left.exact - Math.floor(left.exact)) || left.index - right.index,
    );
    for (const { group } of shares) {
      if (!remaining) break;
      if (result[group.key]! >= group.capacity) continue;
      result[group.key]! += 1;
      remaining -= 1;
    }
  }
  return result;
}

/** The same feasible quotas are used by model validation and the deterministic fallback. */
export function selectCurriculumQuestions<T extends CurriculumScoredCandidate>(
  candidates: readonly T[],
  target: number,
  courseWeights: ReadonlyMap<string, number>,
  fixedCourseQuotas?: Readonly<Record<string, number>>,
): T[] {
  const maximum = integerInRange(target, 0, 10, 'target');
  const ordered = [...candidates].sort(compareScoredCandidates);
  const courses = [...new Set(ordered.map((candidate) => candidate.courseId))].sort(compareAscii);
  const quotas = fixedCourseQuotas ?? allocateWeightedCounts(maximum, courses.map((key) => ({
    key,
    weight: courseWeights.get(key) ?? 1,
    capacity: countEffectiveSelectable(ordered.filter((candidate) => candidate.courseId === key)),
  })));
  const selected: T[] = [];
  const selectedIds = new Set<string>();
  let shortAnswers = 0;
  const append = (candidate: T) => {
    if (selected.length >= maximum || selectedIds.has(candidate.questionId)) return false;
    if (candidate.gradingType === 'SHORT_ANSWER' && shortAnswers >= 1) return false;
    if (candidate.gradingType === 'SHORT_ANSWER') shortAnswers += 1;
    selected.push(candidate);
    selectedIds.add(candidate.questionId);
    return true;
  };
  ordered.filter((candidate) => candidate.mandatory).forEach(append);
  for (const courseId of courses) {
    const pool = ordered.filter((candidate) => candidate.courseId === courseId);
    const courseTarget = quotas[courseId]!;
    const recent = pool.some((candidate) => candidate.bucket === 'RECENT');
    const buckets: CurriculumQuestionBucket[] = recent ? ['RECENT', 'REVIEW', 'COVERAGE'] : ['REVIEW', 'COVERAGE'];
    const weights = recent ? [5, 3, 2] : [6, 4];
    const bucketQuotas = allocateWeightedCounts(courseTarget, buckets.map((key, index) => ({
      key,
      weight: weights[index]!,
      capacity: countEffectiveSelectable(pool.filter((candidate) => candidate.bucket === key)),
    })));
    const courseCount = () => selected.filter((candidate) => candidate.courseId === courseId).length;
    for (const bucket of buckets) {
      for (const candidate of pool.filter((item) => item.bucket === bucket)) {
        if (courseCount() >= courseTarget) break;
        if (selected.filter((item) => item.courseId === courseId && item.bucket === bucket).length >= bucketQuotas[bucket]!) break;
        append(candidate);
      }
    }
    for (const candidate of pool) {
      if (courseCount() >= courseTarget) break;
      append(candidate);
    }
  }
  // A mandatory question or the global short-answer limit can exhaust one course.
  // Redistribute its remaining seats instead of reducing otherwise available content.
  ordered.forEach(append);
  return selected;
}

export function shortlistCurriculumCandidates<T extends CurriculumScoredCandidate>(
  candidates: readonly T[],
  selected: readonly T[],
  maximumCount = 50,
): T[] {
  const ordered = [...candidates].sort(compareScoredCandidates);
  const result = [...selected];
  const ids = new Set(result.map((candidate) => candidate.questionId));
  const groups = new Map<string, T[]>();
  for (const candidate of ordered) {
    const key = `${candidate.courseId}\0${candidate.bucket}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  // Round robin across all course/bucket groups, including several short-answer options.
  while (result.length < maximumCount) {
    let appended = false;
    for (const group of groups.values()) {
      while (group.length && ids.has(group[0]!.questionId)) group.shift();
      const candidate = group.shift();
      if (!candidate || result.length >= maximumCount) continue;
      ids.add(candidate.questionId);
      result.push(candidate);
      appended = true;
    }
    if (!appended) break;
  }
  return result;
}

export interface CandidatePreparation {
  candidates: ScoredCandidate[];
  mandatoryQuestionIds: string[];
  effectiveSelectableCount: number;
  questionCount: { minimum: number; maximum: number };
}

export interface ScheduledUser {
  userId: string;
  rank: number;
  scheduledAt: Date;
  tieBreakHash: string;
}

export interface DailyPlanCapacityInput {
  activeUserCount: number;
  providerP95Ms: number;
  dispatchBudgetMs: number;
}

export function requiredDailyPlanConcurrency(
  input: DailyPlanCapacityInput,
): number {
  const activeUserCount = integerInRange(
    input.activeUserCount,
    0,
    Number.MAX_SAFE_INTEGER,
    'activeUserCount',
  );
  const providerP95Ms = integerInRange(
    input.providerP95Ms,
    1,
    DAILY_PRACTICE_SPREAD_WINDOW_MS - 1,
    'providerP95Ms',
  );
  const dispatchBudgetMs = integerInRange(
    input.dispatchBudgetMs,
    1,
    DAILY_PRACTICE_SPREAD_WINDOW_MS - 1,
    'dispatchBudgetMs',
  );
  if (providerP95Ms >= DAILY_PRACTICE_SPREAD_WINDOW_MS - dispatchBudgetMs) {
    throw new RangeError(
      'capacity configuration must leave execution time after the dispatch budget',
    );
  }
  if (activeUserCount === 0) return 0;
  const totalProviderMs = activeUserCount * providerP95Ms;
  if (!Number.isSafeInteger(totalProviderMs)) {
    throw new RangeError('capacity calculation exceeds the safe integer range');
  }
  return Math.ceil(totalProviderMs / dispatchBudgetMs);
}

export function scoreCandidate(input: CandidateScoreInput): number {
  assertGradingType(input.gradingType);
  const review = integerInRange(input.reviewUrgency, 0, 40, 'reviewUrgency');
  const error = integerInRange(input.errorRisk, 0, 30, 'errorRisk');
  const masteryGap =
    input.masteryBps === null
      ? 20
      : Math.round(
          (10_000 - integerInRange(input.masteryBps, 0, 10_000, 'masteryBps')) /
            500,
        );
  const coverage = integerInRange(input.coverageDebt, 0, 10, 'coverageDebt');
  const suggestion = integerInRange(input.suggestionMatch, 0, 10, 'suggestionMatch');
  return (
    review +
    error +
    masteryGap +
    coverage +
    suggestion -
    (input.seenWithin24Hours ? 30 : 0)
  );
}

export function stableCandidateHash(
  practiceDate: string,
  userId: string,
  questionId: string,
): string {
  if (!userId || !questionId) throw new RangeError('userId and questionId are required');
  practiceDayWindow(practiceDate);
  return sha256(`${practiceDate}\0${userId}\0${questionId}`);
}

export function prepareCandidates(
  input: readonly CandidateScoreInput[],
  practiceDate: string,
  userId: string,
): CandidatePreparation {
  const ids = new Set<string>();
  const scored = input.map((candidate): ScoredCandidate => {
    if (!candidate.questionId || ids.has(candidate.questionId)) {
      throw new RangeError('candidate questionId values must be unique and non-empty');
    }
    ids.add(candidate.questionId);
    return {
      ...candidate,
      priorityScore: scoreCandidate(candidate),
      tieBreakHash: stableCandidateHash(practiceDate, userId, candidate.questionId),
      mandatory: false,
    };
  });
  scored.sort(compareScoredCandidates);

  const mandatory: ScoredCandidate[] = [];
  let mandatoryShortAnswerCount = 0;
  for (const candidate of scored) {
    if (!candidate.mandatoryEligible || mandatory.length >= 2) continue;
    if (candidate.gradingType === 'SHORT_ANSWER') {
      if (mandatoryShortAnswerCount >= 1) continue;
      mandatoryShortAnswerCount += 1;
    }
    candidate.mandatory = true;
    mandatory.push(candidate);
  }
  const effectiveSelectableCount = countEffectiveSelectable(scored);
  return {
    candidates: scored,
    mandatoryQuestionIds: mandatory.map((candidate) => candidate.questionId),
    effectiveSelectableCount,
    questionCount: dynamicQuestionCount(effectiveSelectableCount),
  };
}

export function countEffectiveSelectable(
  candidates: readonly Pick<CandidateScoreInput, 'gradingType'>[],
): number {
  let selectionQuestions = 0;
  let shortAnswers = 0;
  for (const candidate of candidates) {
    assertGradingType(candidate.gradingType);
    if (candidate.gradingType === 'SHORT_ANSWER') shortAnswers += 1;
    else selectionQuestions += 1;
  }
  return selectionQuestions + Math.min(shortAnswers, 1);
}

export function dynamicQuestionCount(effectiveSelectableCount: number): {
  minimum: number;
  maximum: number;
} {
  const effective = integerInRange(
    effectiveSelectableCount,
    0,
    Number.MAX_SAFE_INTEGER,
    'effectiveSelectableCount',
  );
  const maximum = Math.min(effective, 10);
  return {
    minimum: effective === 0 ? 0 : effective < 5 ? effective : 5,
    maximum,
  };
}

export function dynamicKnowledgeCount(candidateCount: number): {
  minimum: number;
  maximum: number;
} {
  const count = integerInRange(
    candidateCount,
    0,
    Number.MAX_SAFE_INTEGER,
    'candidateCount',
  );
  return {
    minimum: count === 0 ? 0 : Math.min(count, 3),
    maximum: Math.min(count, 5),
  };
}

export function scheduleUsersAcrossWindow(
  practiceDate: string,
  userIds: readonly string[],
  executionBudgetMs = 0,
): ScheduledUser[] {
  if (
    !Number.isSafeInteger(executionBudgetMs) ||
    executionBudgetMs < 0 ||
    executionBudgetMs >= DAILY_PRACTICE_SPREAD_WINDOW_MS
  ) {
    throw new RangeError('executionBudgetMs must leave a positive dispatch window');
  }
  const uniqueIds = new Set(userIds);
  if (uniqueIds.size !== userIds.length || userIds.some((id) => !id)) {
    throw new RangeError('userIds must be unique and non-empty');
  }
  const window = practiceDayWindow(practiceDate);
  const dispatchMs = DAILY_PRACTICE_SPREAD_WINDOW_MS - executionBudgetMs;
  const ordered = userIds
    .map((userId) => ({
      userId,
      tieBreakHash: sha256(`${practiceDate}\0${userId}`),
    }))
    .sort((left, right) =>
      compareAscii(left.tieBreakHash, right.tieBreakHash) ||
      compareAscii(left.userId, right.userId),
    );
  return ordered.map((item, rank) => ({
    ...item,
    rank,
    scheduledAt: scheduledAtForRank(
      window.dayStartedAt,
      rank,
      ordered.length,
      dispatchMs,
    ),
  }));
}

export function selectDeterministicCandidates(
  candidates: readonly ScoredCandidate[],
  maximumCount: number,
): ScoredCandidate[] {
  const target = integerInRange(maximumCount, 0, 10, 'maximumCount');
  const byId = new Map(candidates.map((candidate) => [candidate.questionId, candidate]));
  if (byId.size !== candidates.length) throw new RangeError('candidate IDs must be unique');
  const ordered = [...candidates].sort(compareScoredCandidates);
  const selected: ScoredCandidate[] = [];
  const selectedIds = new Set<string>();
  let shortAnswerCount = 0;
  const append = (candidate: ScoredCandidate) => {
    if (selected.length >= target || selectedIds.has(candidate.questionId)) return;
    if (candidate.gradingType === 'SHORT_ANSWER') {
      if (shortAnswerCount >= 1) return;
      shortAnswerCount += 1;
    }
    selected.push(candidate);
    selectedIds.add(candidate.questionId);
  };
  ordered.filter((candidate) => candidate.mandatory).forEach(append);
  ordered.forEach(append);
  return selected;
}

function scheduledAtForRank(
  startedAt: Date,
  rank: number,
  total: number,
  dispatchMs: number,
): Date {
  if (total === 0) throw new RangeError('cannot schedule a rank in an empty set');
  const offset = Math.floor(((rank + 0.5) * dispatchMs) / total);
  return new Date(startedAt.getTime() + offset);
}

function compareScoredCandidates(
  left: Pick<ScoredCandidate, 'priorityScore' | 'tieBreakHash' | 'questionId'>,
  right: Pick<ScoredCandidate, 'priorityScore' | 'tieBreakHash' | 'questionId'>,
) {
  return (
    right.priorityScore - left.priorityScore ||
    compareAscii(left.tieBreakHash, right.tieBreakHash) ||
    compareAscii(left.questionId, right.questionId)
  );
}

function assertGradingType(value: string): asserts value is DailyPracticeGradingType {
  if (!(DAILY_PRACTICE_GRADING_TYPES as readonly string[]).includes(value)) {
    throw new RangeError(`unsupported grading type: ${value}`);
  }
}

function integerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function compareAscii(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
