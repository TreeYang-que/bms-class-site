import { hasDailyPracticeAccess } from '@bmc3/daily-practice-core';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  DailyPracticeDayStatus,
  DailyPracticePlanItemSource,
  DailyPracticePlanTrigger,
  Prisma,
  QuestionType,
  QuizQuestionCategory,
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
  QuizAttemptStatus,
  type QuizAttempt,
} from '@prisma/client';
import {
  practiceDateForInstant,
  practiceDateFromDbDate,
} from '@bmc3/daily-practice-core';
import {
  applySubmittedAttemptState,
  assertDailyQuestionEligibility,
  lockUserPracticeProfile,
} from '@bmc3/daily-practice-prisma';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import {
  DAILY_PRACTICE_ERROR_CODES,
  dailyPracticeConflict,
  dailyPracticeNotFound,
} from '../daily-practice/daily-practice.errors';
import { lockDailyPracticeSettings } from '../daily-practice/daily-practice-gate';
import {
  GradingRubric,
  PreparedQuestion,
  QuestionInput,
  QuizOption,
  prepareQuestion,
} from './quiz-question';
import { ShortAnswerGraderService } from './short-answer-grader.service';

const SUBJECT_SELECT = {
  id: true,
  name: true,
  slug: true,
} satisfies Prisma.SubjectSelect;

const CHAPTER_SELECT = {
  id: true,
  subjectId: true,
  name: true,
  slug: true,
  sortOrder: true,
} satisfies Prisma.SubjectChapterSelect;

const QUIZ_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ACTIVE_QUIZ_DRAFTS = 5;
const QUIZ_GRADING_LEASE_MS = 15 * 60 * 1_000;
const DEFAULT_QUIZ_TOTAL_QUESTION_LIMIT = 100_000;

type QuizQuestionMutationHook = (
  transaction: Prisma.TransactionClient,
  question: { id: string },
) => Promise<void>;

const QUESTION_INCLUDE = {
  subject: { select: SUBJECT_SELECT },
  chapters: {
    orderBy: [
      { chapter: { sortOrder: 'asc' as const } },
      { createdAt: 'asc' as const },
    ],
    select: { chapter: { select: CHAPTER_SELECT } },
  },
  pastPaper: {
    select: {
      id: true,
      title: true,
      subjectId: true,
      subject: { select: SUBJECT_SELECT },
      year: true,
    },
  },
  photos: {
    orderBy: { sortOrder: 'asc' as const },
    select: {
      photo: {
        select: {
          id: true,
          caption: true,
          mimeType: true,
          size: true,
          width: true,
          height: true,
        },
      },
    },
  },
} satisfies Prisma.QuizQuestionInclude;

const LIBRARY_QUESTION_SELECT = {
  id: true,
  type: true,
  typeLabel: true,
  subjectId: true,
  subject: { select: SUBJECT_SELECT },
  chapters: QUESTION_INCLUDE.chapters,
  category: true,
  origin: true,
  prompt: true,
  options: true,
  maxScore: true,
  paperOrder: true,
  pastPaper: {
    select: { id: true, title: true, subject: true, year: true },
  },
  photos: QUESTION_INCLUDE.photos,
} satisfies Prisma.QuizQuestionSelect;

type QuestionWithRelations = Prisma.QuizQuestionGetPayload<{
  include: typeof QUESTION_INCLUDE;
}>;
type LibraryQuestion = Prisma.QuizQuestionGetPayload<{
  select: typeof LIBRARY_QUESTION_SELECT;
}>;

export interface QuizImage {
  id: string;
  caption: string;
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
}

export interface QuestionSnapshot {
  id: string;
  type: QuestionType;
  typeLabel?: string;
  subject: { id: string; name: string; slug: string };
  chapters: Array<{
    id: string;
    subjectId: string;
    name: string;
    slug: string;
  }>;
  category?: QuizQuestionCategory;
  origin?: QuizQuestionOrigin;
  prompt: string;
  options: QuizOption[];
  images?: QuizImage[];
  pastPaper?: {
    id: string;
    title: string;
    subjectId: string;
    subject: { id: string; name: string; slug: string };
    year: number | null;
  } | null;
  paperOrder?: number | null;
  correctAnswer: string[];
  gradingRubric?: GradingRubric;
  maxScore: number;
  explanation: string;
  knowledgeStateSources?: Array<{
    documentId: string;
    nodePathHash: string;
    currentKnowledgeNodeId: string | null;
    subjectId: string;
    libraryId: string;
  }>;
}

export interface QuizResult {
  questionId: string;
  correct: boolean;
  score: number;
  maxScore: number;
  correctAnswer: string[];
  explanation: string;
  feedback?: string;
  gradingModel?: string;
  criterionScores?: Array<{
    description: string;
    awardedPoints: number;
    maxPoints: number;
    reason: string;
  }>;
}

export interface StartQuizFilters {
  subjectId?: string;
  chapterIds?: string[];
  chapterMatch?: ChapterMatch;
  includeCrossChapter?: boolean;
  typeLabels?: string[];
  types?: QuestionType[];
  source?: QuestionSourceFilter;
  includePastPapers?: boolean;
  questionIds?: string[];
}

export type PastPaperScope = 'ALL' | 'EXCLUDE' | 'ONLY';
export type ChapterMatch = 'ANY' | 'ALL';
export type QuestionSourceFilter = 'AI' | 'NON_AI';

export interface LibraryFilters {
  subjectId?: string;
  chapterIds?: string[];
  chapterMatch: ChapterMatch;
  includeCrossChapter?: boolean;
  typeLabel?: string;
  source?: QuestionSourceFilter;
  pastPaper?: PastPaperScope;
  paperId?: string;
  search?: string;
  page: number;
  pageSize: number;
}

export interface WrongQuestionFilters {
  subjectId?: string;
  chapterIds?: string[];
  chapterMatch: ChapterMatch;
  includeCrossChapter?: boolean;
  typeLabel?: string;
  source?: QuestionSourceFilter;
  search?: string;
  page: number;
  pageSize: number;
}

export interface QuestionImportInput extends Omit<
  QuestionInput,
  'subjectId' | 'chapterIds'
> {
  subject: unknown;
  chapter?: unknown;
  chapters?: unknown;
  paperOrder?: unknown;
}

export interface ImportQuestionsOptions {
  createMissingChapters?: boolean;
  pastPaperId?: string;
  pastPaper?: {
    title: string;
    subjectId: string;
    year?: number;
  };
}

export interface AutoCreatedChapter {
  id: string;
  subjectId: string;
  name: string;
  slug: string;
}

interface AttemptSnapshotV2 {
  snapshotVersion: 2;
  questions: QuestionSnapshot[];
}

interface ShortAnswerGrader {
  grade: ShortAnswerGraderService['grade'];
}

export function normalizeAnswer(answer: unknown): string[] {
  if (!Array.isArray(answer)) return [];
  return [
    ...new Set(
      answer.filter((value): value is string => typeof value === 'string'),
    ),
  ].sort();
}

export function validateAnswers(
  snapshot: QuestionSnapshot[],
  answers: unknown,
): Record<string, string[]> {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new BadRequestException('answers 必须是题目 id 到答案数组的映射');
  }
  const questionById = new Map(
    snapshot.map((question) => [question.id, question]),
  );
  const validated: Record<string, string[]> = {};
  for (const [questionId, answer] of Object.entries(
    answers as Record<string, unknown>,
  )) {
    const question = questionById.get(questionId);
    if (!question)
      throw new BadRequestException(
        `答案包含不属于本次答题的题目 ${questionId}`,
      );
    if (
      !Array.isArray(answer) ||
      answer.some((value) => typeof value !== 'string')
    ) {
      throw new BadRequestException(
        `题目 ${questionId} 的答案必须是字符串数组`,
      );
    }
    if (question.type === QuestionType.SHORT_ANSWER) {
      if (answer.length > 1)
        throw new BadRequestException(
          `题目 ${questionId} 的简答答案只能有一项`,
        );
      if (answer.some((value) => value.length > 10_000))
        throw new BadRequestException(`题目 ${questionId} 的答案超过 10000 字`);
      validated[questionId] = answer
        .map((value) => value.trim())
        .filter(Boolean);
      continue;
    }
    if (
      answer.length > question.options.length ||
      answer.some((value) => value.length > 80)
    ) {
      throw new BadRequestException(`题目 ${questionId} 的选项答案无效`);
    }
    const optionIds = new Set(question.options.map((option) => option.id));
    if (answer.some((value) => !optionIds.has(value))) {
      throw new BadRequestException(`题目 ${questionId} 的答案包含无效选项`);
    }
    validated[questionId] = normalizeAnswer(answer);
  }
  return validated;
}

async function gradeQuestion(
  question: QuestionSnapshot,
  answers: Record<string, string[]>,
  grader: ShortAnswerGrader,
): Promise<QuizResult> {
  const maxScore = question.maxScore || 1;
  if (question.type !== QuestionType.SHORT_ANSWER) {
    const actual = normalizeAnswer(answers[question.id]);
    const expected = normalizeAnswer(question.correctAnswer);
    const correct =
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]);
    return {
      questionId: question.id,
      correct,
      score: correct ? maxScore : 0,
      maxScore,
      correctAnswer: expected,
      explanation: question.explanation,
    };
  }

  const rubric = question.gradingRubric;
  if (!rubric?.criteria.length)
    throw new InternalServerErrorException(
      `简答题 ${question.id} 缺少评分标准`,
    );
  const studentAnswer = answers[question.id]?.[0] ?? '';
  if (!studentAnswer) {
    return {
      questionId: question.id,
      correct: false,
      score: 0,
      maxScore,
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
      feedback: '未作答。',
      criterionScores: rubric.criteria.map((criterion) => ({
        description: criterion.description,
        awardedPoints: 0,
        maxPoints: criterion.points,
        reason: '未作答',
      })),
    };
  }

  const grade = await grader.grade({
    question: question.prompt,
    studentAnswer,
    referenceAnswers: question.correctAnswer,
    rubric,
  });
  const criterionScores = grade.criterionScores.map((item) => ({
    description: rubric.criteria[item.criterionIndex]!.description,
    awardedPoints: item.awardedPoints,
    maxPoints: rubric.criteria[item.criterionIndex]!.points,
    reason: item.reason,
  }));
  const score = criterionScores.reduce(
    (sum, item) => sum + item.awardedPoints,
    0,
  );
  return {
    questionId: question.id,
    correct: score === maxScore,
    score,
    maxScore,
    correctAnswer: question.correctAnswer,
    explanation: question.explanation,
    feedback: grade.feedback,
    gradingModel: grade.model,
    criterionScores,
  };
}

export async function scoreSnapshot(
  snapshot: QuestionSnapshot[],
  answers: Record<string, string[]>,
  grader?: ShortAnswerGrader,
  concurrency = 3,
) {
  const results = new Array<QuizResult>(snapshot.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < snapshot.length) {
      const index = nextIndex;
      nextIndex += 1;
      const question = snapshot[index]!;
      if (question.type === QuestionType.SHORT_ANSWER && !grader) {
        throw new InternalServerErrorException('简答题判分服务未配置');
      }
      results[index] = await gradeQuestion(question, answers, grader!);
    }
  };
  const workerCount = Math.max(
    1,
    Math.min(Math.trunc(concurrency) || 1, snapshot.length),
  );
  await Promise.all(Array.from({ length: workerCount }, worker));
  return {
    score: results.reduce((sum, result) => sum + result.score, 0),
    total: results.reduce((sum, result) => sum + result.maxScore, 0),
    results,
  };
}

function imageUrl(id: string) {
  return `/api/v1/media/images/${id}/content`;
}

export function serializeImages(
  photos: QuestionWithRelations['photos'] | LibraryQuestion['photos'],
): QuizImage[] {
  return photos.map(({ photo }) => ({
    ...photo,
    url: imageUrl(photo.id),
  }));
}

function toSnapshot(question: QuestionWithRelations): QuestionSnapshot {
  return {
    id: question.id,
    type: question.type,
    typeLabel: question.typeLabel,
    subject: question.subject,
    chapters: question.chapters.map(({ chapter }) => chapter),
    category: question.category,
    origin: question.origin,
    prompt: question.prompt,
    options: question.options as unknown as QuizOption[],
    images: serializeImages(question.photos),
    pastPaper: question.pastPaper,
    paperOrder: question.paperOrder,
    correctAnswer: question.correctAnswer as unknown as string[],
    ...(question.gradingRubric
      ? { gradingRubric: question.gradingRubric as unknown as GradingRubric }
      : {}),
    maxScore: question.maxScore,
    explanation: question.explanation,
  };
}

function toPublicSnapshot(question: QuestionSnapshot) {
  const {
    correctAnswer: _answer,
    gradingRubric: _rubric,
    explanation: _explanation,
    knowledgeStateSources: _knowledgeStateSources,
    ...publicQuestion
  } = question;
  return {
    ...publicQuestion,
    subjectId: question.subject.id,
    subject: question.subject.name,
    chapterIds: question.chapters.map((chapter) => chapter.id),
    chapter: question.chapters[0]?.name ?? '',
    chapters: question.chapters,
    pastPaper: question.pastPaper
      ? {
          ...question.pastPaper,
          subject: question.pastPaper.subject.name,
        }
      : null,
    gradingType: question.type,
    isPastPaper: Boolean(question.pastPaper),
  };
}

function toLibraryQuestion(question: LibraryQuestion) {
  return {
    id: question.id,
    type: question.type,
    gradingType: question.type,
    typeLabel: question.typeLabel,
    subjectId: question.subjectId,
    subject: question.subject.name,
    chapterIds: question.chapters.map(({ chapter }) => chapter.id),
    chapter: question.chapters[0]?.chapter.name ?? '',
    chapters: question.chapters.map(({ chapter }) => chapter),
    category: question.category,
    origin: question.origin,
    prompt: question.prompt,
    options: question.options as unknown as QuizOption[],
    maxScore: question.maxScore,
    images: serializeImages(question.photos),
    isPastPaper: Boolean(question.pastPaper),
    pastPaper: question.pastPaper
      ? {
          ...question.pastPaper,
          subject: question.pastPaper.subject.name,
        }
      : null,
    paperOrder: question.paperOrder,
  };
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function parsePaperOrder(value: unknown, fallback: number, context: string) {
  if (value === undefined || value === null || value === '') return fallback;
  const order = Number(value);
  if (!Number.isInteger(order) || order < 1 || order > 10_000) {
    throw new BadRequestException(
      `${context}的 paperOrder 必须是 1-10000 的整数`,
    );
  }
  return order;
}

function importedChapterSlug(subjectId: string, name: string) {
  const digest = createHash('sha256')
    .update(`${subjectId}\u0000${name}`, 'utf8')
    .digest('hex')
    .slice(0, 48);
  return `csv-${digest}`;
}

function prismaQuestionData(
  question: PreparedQuestion,
  authorId: string,
  origin: QuizQuestionOrigin,
  id?: string,
  paper?: { id: string; order: number },
) {
  return {
    ...(id ? { id } : {}),
    type: question.type,
    typeLabel: question.typeLabel,
    subjectId: question.subjectId,
    category: question.category,
    origin,
    reviewStatus: QuizQuestionReviewStatus.APPROVED,
    prompt: question.prompt,
    options: question.options as unknown as Prisma.InputJsonValue,
    correctAnswer: question.correctAnswer as Prisma.InputJsonValue,
    ...(question.gradingRubric
      ? {
          gradingRubric:
            question.gradingRubric as unknown as Prisma.InputJsonValue,
        }
      : {}),
    maxScore: question.maxScore,
    explanation: question.explanation,
    authorId,
    ...(paper ? { pastPaperId: paper.id, paperOrder: paper.order } : {}),
  };
}

function prismaQuestionUpdateData(
  question: PreparedQuestion,
): Prisma.QuizQuestionUncheckedUpdateInput {
  return {
    type: question.type,
    typeLabel: question.typeLabel,
    subjectId: question.subjectId,
    category: question.category,
    prompt: question.prompt,
    options: question.options as unknown as Prisma.InputJsonValue,
    correctAnswer: question.correctAnswer as Prisma.InputJsonValue,
    gradingRubric: question.gradingRubric
      ? (question.gradingRubric as unknown as Prisma.InputJsonValue)
      : Prisma.DbNull,
    maxScore: question.maxScore,
    explanation: question.explanation,
  };
}

function questionWhere(
  filters: Omit<StartQuizFilters, 'questionIds'> | LibraryFilters,
): Prisma.QuizQuestionWhereInput {
  const where: Prisma.QuizQuestionWhereInput = {
    enabled: true,
    reviewStatus: QuizQuestionReviewStatus.APPROVED,
    subject: { active: true },
    chapters: {
      some: {},
      none: { chapter: { active: false } },
    },
    origin: {
      in: [QuizQuestionOrigin.MANUAL, QuizQuestionOrigin.CSV],
    },
  };
  if (filters.subjectId) where.subjectId = filters.subjectId;
  if (filters.chapterIds?.length) {
    if (filters.chapterMatch === 'ALL') {
      where.AND = filters.chapterIds.map((chapterId) => ({
        chapters: { some: { chapterId } },
      }));
    } else {
      where.chapters = {
        none: { chapter: { active: false } },
        some: { chapterId: { in: filters.chapterIds } },
      };
    }
  }
  if ('typeLabels' in filters && filters.typeLabels?.length) {
    where.typeLabel = { in: filters.typeLabels };
  }
  if ('types' in filters && filters.types?.length) {
    where.type = { in: filters.types };
  }
  if (filters.source === 'AI') {
    // Keep legacy clients compatible without reopening the retired question pool.
    where.origin = { in: [] };
  }
  return where;
}

function readAttemptSnapshot(value: Prisma.JsonValue): QuestionSnapshot[] {
  if (Array.isArray(value)) return value as unknown as QuestionSnapshot[];
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.snapshotVersion === 2 &&
    Array.isArray(value.questions)
  ) {
    return value.questions as unknown as QuestionSnapshot[];
  }
  throw new InternalServerErrorException('答题快照格式无效');
}

function serializeAttemptStart(attempt: {
  id: string;
  snapshot: Prisma.JsonValue;
}) {
  const snapshot = readAttemptSnapshot(attempt.snapshot);
  return {
    attemptId: attempt.id,
    questions: snapshot.map(toPublicSnapshot),
  };
}

function serializeAttemptLifecycle(attempt: QuizAttempt) {
  const snapshot = readAttemptSnapshot(attempt.snapshot);
  return {
    attemptId: attempt.id,
    status:
      attempt.lifecycleStatus ??
      (attempt.submittedAt ? QuizAttemptStatus.SUBMITTED : null),
    revision: attempt.draftRevision,
    position: attempt.position,
    answers: attempt.answers ?? {},
    questions: snapshot.map(toPublicSnapshot),
    savedAt: attempt.savedAt,
    expiresAt: attempt.expiresAt,
    abandonedAt: attempt.abandonedAt,
    submittedAt: attempt.submittedAt,
    score: attempt.score,
    total: attempt.total,
    results: attempt.results,
    gradingError: attempt.gradingError,
  };
}

function serializeSubmittedAttempt(attempt: QuizAttempt) {
  return {
    attemptId: attempt.id,
    status: QuizAttemptStatus.SUBMITTED,
    pending: false as const,
    score: attempt.score,
    total: attempt.total,
    results: attempt.results,
    submittedAt: attempt.submittedAt,
  };
}

function attemptSubmissionHash(
  snapshot: QuestionSnapshot[],
  answers: Record<string, string[]>,
) {
  const orderedAnswers = Object.fromEntries(
    Object.keys(answers)
      .sort()
      .map((questionId) => [questionId, answers[questionId]]),
  );
  return createHash('sha256')
    .update(JSON.stringify({ snapshot, answers: orderedAnswers }), 'utf8')
    .digest('hex');
}

async function assertQuizDraftCapacity(
  transaction: Prisma.TransactionClient,
  userId: string,
  now: Date,
) {
  await transaction.$queryRaw(
    Prisma.sql`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`,
  );
  const activeDrafts = await transaction.quizAttempt.count({
    where: {
      userId,
      savedAt: { not: null },
      expiresAt: { gt: now },
      lifecycleStatus: {
        in: [
          QuizAttemptStatus.DRAFT,
          QuizAttemptStatus.SCORING,
          QuizAttemptStatus.SCORING_FAILED,
        ],
      },
    },
  });
  if (activeDrafts >= MAX_ACTIVE_QUIZ_DRAFTS) {
    quizConflict(
      'QUIZ_DRAFT_LIMIT_REACHED',
      '最多保留 5 个未提交练习，请先继续或放弃已有草稿',
    );
  }
}

function quizTotalQuestionLimit() {
  const configured = Number(
    process.env.QUIZ_TOTAL_QUESTION_LIMIT ?? DEFAULT_QUIZ_TOTAL_QUESTION_LIMIT,
  );
  return Number.isInteger(configured) &&
    configured >= 5_000 &&
    configured <= 1_000_000
    ? configured
    : DEFAULT_QUIZ_TOTAL_QUESTION_LIMIT;
}

async function assertQuizQuestionCapacity(
  transaction: Prisma.TransactionClient,
  additionalQuestions: number,
) {
  await transaction.quizCapacityCounter.upsert({
    where: { singletonId: 1 },
    create: { singletonId: 1 },
    update: {},
  });
  await transaction.$queryRaw(
    Prisma.sql`SELECT singletonId FROM QuizCapacityCounter WHERE singletonId = 1 FOR UPDATE`,
  );
  const [counter, activeQuestions] = await Promise.all([
    transaction.quizCapacityCounter.findUniqueOrThrow({
      where: { singletonId: 1 },
    }),
    transaction.quizQuestion.count(),
  ]);
  const limit = quizTotalQuestionLimit();
  if (
    activeQuestions + counter.reservedQuestions + additionalQuestions >
    limit
  ) {
    quizConflict(
      'QUIZ_CAPACITY_EXCEEDED',
      `题库总容量不足，当前及已预留 ${activeQuestions + counter.reservedQuestions} 题，上限 ${limit} 题`,
    );
  }
  await transaction.quizCapacityCounter.update({
    where: { singletonId: 1 },
    data: { activeQuestions },
  });
  return activeQuestions;
}

async function recordCreatedQuestions(
  transaction: Prisma.TransactionClient,
  activeQuestions: number,
  createdQuestions: number,
) {
  await transaction.quizCapacityCounter.update({
    where: { singletonId: 1 },
    data: { activeQuestions: activeQuestions + createdQuestions },
  });
}

function quizConflict(code: string, message: string): never {
  throw new ConflictException({ statusCode: 409, code, message });
}

function safeQuizError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function isUniqueConstraintError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function serializeHistoricalQuestion(value: Prisma.JsonValue) {
  const { knowledgeStateSources: _knowledgeStateSources, ...question } =
    value as unknown as Record<string, unknown>;
  if (
    question.subject &&
    typeof question.subject === 'object' &&
    !Array.isArray(question.subject)
  ) {
    const subject = question.subject as Record<string, unknown>;
    const chapters = Array.isArray(question.chapters)
      ? (question.chapters as Array<Record<string, unknown>>)
      : [];
    return {
      ...question,
      subjectId: subject.id,
      subject: subject.name,
      chapterIds: chapters.map((chapter) => chapter.id),
      chapter: chapters[0]?.name ?? '',
      chapters,
      pastPaper:
        question.pastPaper && typeof question.pastPaper === 'object'
          ? {
              ...(question.pastPaper as Record<string, unknown>),
              subject:
                typeof (question.pastPaper as Record<string, unknown>)
                  .subject === 'object'
                  ? (
                      (question.pastPaper as Record<string, unknown>)
                        .subject as Record<string, unknown>
                    ).name
                  : (question.pastPaper as Record<string, unknown>).subject,
            }
          : null,
    };
  }
  return question;
}

@Injectable()
export class QuizService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shortAnswerGrader: ShortAnswerGraderService,
  ) {}

  private async validateFilterTaxonomy(
    subjectId?: string,
    chapterIds?: string[],
  ) {
    if (chapterIds?.length && !subjectId) {
      throw new BadRequestException('筛选章节前必须先选择学科');
    }
    if (!subjectId) return;
    const subject = await this.prisma.subject.findFirst({
      where: { id: subjectId, active: true },
      select: { id: true },
    });
    if (!subject) throw new BadRequestException('请选择有效的学科');
    if (!chapterIds?.length) return;
    if (new Set(chapterIds).size !== chapterIds.length) {
      throw new BadRequestException('chapterIds 不能包含重复章节');
    }
    const count = await this.prisma.subjectChapter.count({
      where: { id: { in: chapterIds }, subjectId, active: true },
    });
    if (count !== chapterIds.length) {
      throw new BadRequestException('章节必须全部启用且属于所选学科');
    }
  }

  private async applyComprehensiveInclusion(
    where: Prisma.QuizQuestionWhereInput,
    includeCrossChapter?: boolean,
  ) {
    if (includeCrossChapter) return;
    const rows = await this.prisma.$queryRaw<Array<{ questionId: string }>>(
      Prisma.sql`
        SELECT questionId
        FROM QuizQuestionChapter
        GROUP BY questionId
        HAVING COUNT(*) > 1
      `,
    );
    const crossChapterIds = rows.map(({ questionId }) => questionId);
    if (crossChapterIds.length) where.id = { notIn: crossChapterIds };
  }

  async start(
    userId: string,
    count: number | undefined,
    filters: StartQuizFilters = {},
  ) {
    if (filters.questionIds?.length) {
      return this.startSelected(userId, filters.questionIds);
    }
    if (!count) throw new BadRequestException('随机抽题必须指定 count');

    await this.validateFilterTaxonomy(filters.subjectId, filters.chapterIds);
    const where = questionWhere(filters);
    if (!filters.includePastPapers) where.pastPaperId = null;
    await this.applyComprehensiveInclusion(where, filters.includeCrossChapter);

    const candidates = await this.prisma.quizQuestion.findMany({
      where,
      select: { id: true },
    });
    const selectedIds = shuffle(candidates.map(({ id }) => id)).slice(
      0,
      Math.min(count, candidates.length),
    );
    if (!selectedIds.length)
      throw new BadRequestException('当前筛选条件下没有可用题目');
    const selected = await this.prisma.quizQuestion.findMany({
      where: { ...questionWhere(filters), id: { in: selectedIds } },
      include: QUESTION_INCLUDE,
    });
    if (selected.length !== selectedIds.length) {
      throw new BadRequestException('部分题目已停用，请重新开始练习');
    }
    const byId = new Map(selected.map((question) => [question.id, question]));
    return this.createAttempt(
      userId,
      selectedIds.map((id) => toSnapshot(byId.get(id)!)),
    );
  }

  async startDailyPractice(userId: string, revisionId: string) {
    const existing = await this.prisma.quizAttempt.findUnique({
      where: { dailyPracticePlanRevisionId: revisionId },
      select: { id: true, userId: true, snapshot: true },
    });
    if (existing) {
      if (existing.userId !== userId) {
        dailyPracticeNotFound(
          DAILY_PRACTICE_ERROR_CODES.planStale,
          '每日练习计划不存在或不属于当前用户',
        );
      }
      return serializeAttemptStart(existing);
    }

    try {
      return await this.prisma.$transaction(async (transaction) => {
        const concurrentAttempt = await transaction.quizAttempt.findUnique({
          where: { dailyPracticePlanRevisionId: revisionId },
          select: { id: true, userId: true, snapshot: true },
        });
        if (concurrentAttempt) {
          if (concurrentAttempt.userId !== userId) {
            dailyPracticeNotFound(
              DAILY_PRACTICE_ERROR_CODES.planStale,
              '每日练习计划不存在或不属于当前用户',
            );
          }
          return serializeAttemptStart(concurrentAttempt);
        }

        await lockDailyPracticeSettings(transaction);
        const now = new Date();
        await assertQuizDraftCapacity(transaction, userId, now);
        const [settings, pause, activeUser, revision] = await Promise.all([
          transaction.dailyPracticeSettings.findUnique({
            where: { singletonId: 1 },
            select: { enabled: true, internalTestUserIds: true },
          }),
          transaction.dailyPracticeServicePause.findFirst({
            where: {
              cancelledAt: null,
              startsAt: { lte: now },
              endsAt: { gt: now },
            },
            select: { reason: true },
          }),
          transaction.user.findFirst({
            where: { id: userId, status: AccountStatus.ACTIVE },
            select: { id: true },
          }),
          transaction.dailyPracticePlanRevision.findFirst({
            where: { id: revisionId, day: { userId } },
            include: {
              day: {
                select: {
                  id: true,
                  practiceDate: true,
                  activeRevisionId: true,
                  status: true,
                },
              },
              items: {
                orderBy: { ordinal: 'asc' },
                include: { question: { include: QUESTION_INCLUDE } },
              },
            },
          }),
        ]);

        if (!hasDailyPracticeAccess(settings, userId) || pause) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.paused,
            pause?.reason ?? '每日一练服务当前已暂停',
          );
        }
        if (!activeUser) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.planStale,
            '当前账号状态不能开始每日练习',
          );
        }
        if (!revision) {
          dailyPracticeNotFound(
            DAILY_PRACTICE_ERROR_CODES.planStale,
            '每日练习计划不存在或不属于当前用户',
          );
        }
        if (
          revision.day.activeRevisionId !== revision.id ||
          !revision.publishedAt ||
          revision.trigger === DailyPracticePlanTrigger.ADMIN_PREVIEW ||
          practiceDateFromDbDate(revision.day.practiceDate) !==
            practiceDateForInstant(now)
        ) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.planStale,
            '每日练习计划已更新，请刷新后重试',
          );
        }
        const fixedOnlyNoContent =
          revision.day.status === DailyPracticeDayStatus.NO_CONTENT &&
          revision.items.length > 0 &&
          revision.items.every(
            (item) => item.source === DailyPracticePlanItemSource.ADMIN_FIXED,
          );
        if (
          revision.day.status !== DailyPracticeDayStatus.READY &&
          revision.day.status !== DailyPracticeDayStatus.DEGRADED_READY &&
          revision.day.status !== DailyPracticeDayStatus.LIMITED_CONTENT &&
          !fixedOnlyNoContent
        ) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.planStale,
            '每日练习计划当前不可开始',
          );
        }
        if (!revision.items.length || revision.items.length > 30) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.planStale,
            '每日练习计划题目数量无效',
          );
        }

        const eligible = await assertDailyQuestionEligibility(
          transaction,
          practiceDateFromDbDate(revision.day.practiceDate),
          revision.items,
        );
        if (!eligible) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.planStale,
            '计划中的题目或教学范围已变化，请等待计划重新生成',
          );
        }

        let shortAnswers = 0;
        for (const item of revision.items) {
          const question = item.question;
          if (
            question.reviewRevision !== item.questionReviewRevision ||
            question.contentRevision !== item.questionContentRevision ||
            !question.enabled ||
            question.reviewStatus !== QuizQuestionReviewStatus.APPROVED ||
            (question.origin !== QuizQuestionOrigin.MANUAL &&
              question.origin !== QuizQuestionOrigin.CSV)
          ) {
            dailyPracticeConflict(
              DAILY_PRACTICE_ERROR_CODES.planStale,
              '计划中的题目已更新，请等待计划重新生成',
            );
          }
          if (question.type === QuestionType.SHORT_ANSWER) {
            shortAnswers += 1;
          }
        }
        if (shortAnswers > 1) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.planStale,
            '每日练习中的简答题数量超过安全上限',
          );
        }

        const snapshot = revision.items.map((item) =>
          toSnapshot(item.question),
        );
        const document: AttemptSnapshotV2 = {
          snapshotVersion: 2,
          questions: snapshot,
        };
        const attempt = await transaction.quizAttempt.create({
          data: {
            userId,
            dailyPracticePlanRevisionId: revision.id,
            snapshot: document as unknown as Prisma.InputJsonValue,
            lifecycleStatus: QuizAttemptStatus.DRAFT,
            savedAt: now,
            expiresAt: new Date(now.getTime() + QUIZ_DRAFT_TTL_MS),
            total: snapshot.reduce(
              (sum, question) => sum + question.maxScore,
              0,
            ),
          },
          select: { id: true, userId: true, snapshot: true },
        });
        const markedStarted = await transaction.dailyPracticeDay.updateMany({
          where: {
            id: revision.day.id,
            activeRevisionId: revision.id,
            status: {
              in: [
                DailyPracticeDayStatus.READY,
                DailyPracticeDayStatus.DEGRADED_READY,
                DailyPracticeDayStatus.LIMITED_CONTENT,
                DailyPracticeDayStatus.NO_CONTENT,
              ],
            },
          },
          data: { status: DailyPracticeDayStatus.STARTED, startedAt: now },
        });
        if (markedStarted.count !== 1) {
          dailyPracticeConflict(
            DAILY_PRACTICE_ERROR_CODES.planStale,
            '每日练习计划状态已变化，请刷新后重试',
          );
        }
        return serializeAttemptStart(attempt);
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const racedAttempt = await this.prisma.quizAttempt.findUnique({
        where: { dailyPracticePlanRevisionId: revisionId },
        select: { id: true, userId: true, snapshot: true },
      });
      if (!racedAttempt || racedAttempt.userId !== userId) throw error;
      return serializeAttemptStart(racedAttempt);
    }
  }

  async startSelected(userId: string, questionIds: string[]) {
    const uniqueIds = [...new Set(questionIds)];
    if (uniqueIds.length !== questionIds.length) {
      throw new BadRequestException('questionIds 不能包含重复题目');
    }
    if (!uniqueIds.length || uniqueIds.length > 100) {
      throw new BadRequestException('每次必须选择 1-100 道题目');
    }
    const questions = await this.prisma.quizQuestion.findMany({
      where: {
        ...questionWhere({}),
        id: { in: uniqueIds },
      },
      include: QUESTION_INCLUDE,
    });
    if (questions.length !== uniqueIds.length) {
      throw new BadRequestException('部分所选题目不存在或已停用');
    }
    const byId = new Map(questions.map((question) => [question.id, question]));
    return this.createAttempt(
      userId,
      uniqueIds.map((id) => toSnapshot(byId.get(id)!)),
    );
  }

  async startPaper(userId: string, paperId: string) {
    const paper = await this.prisma.quizPaper.findFirstOrThrow({
      where: { id: paperId, subject: { active: true } },
      select: {
        id: true,
        questions: {
          where: questionWhere({}),
          include: QUESTION_INCLUDE,
          orderBy: [{ paperOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!paper.questions.length) {
      throw new BadRequestException('该往年真题试卷中没有可用题目');
    }
    if (paper.questions.length > 500) {
      throw new BadRequestException('单套往年真题最多支持 500 道题目');
    }
    return this.createAttempt(userId, paper.questions.map(toSnapshot));
  }

  private async createAttempt(userId: string, snapshot: QuestionSnapshot[]) {
    const total = snapshot.reduce(
      (sum, question) => sum + question.maxScore,
      0,
    );
    const document: AttemptSnapshotV2 = {
      snapshotVersion: 2,
      questions: snapshot,
    };
    const now = new Date();
    const attempt = await this.prisma.$transaction(
      async (transaction) => {
        await assertQuizDraftCapacity(transaction, userId, now);
        return transaction.quizAttempt.create({
          data: {
            userId,
            snapshot: document as unknown as Prisma.InputJsonValue,
            total,
            lifecycleStatus: QuizAttemptStatus.DRAFT,
            savedAt: now,
            expiresAt: new Date(now.getTime() + QUIZ_DRAFT_TTL_MS),
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return {
      attemptId: attempt.id,
      questions: snapshot.map(toPublicSnapshot),
    };
  }

  async activeAttempts(userId: string) {
    const now = new Date();
    const attempts = await this.prisma.quizAttempt.findMany({
      where: {
        userId,
        savedAt: { not: null },
        expiresAt: { gt: now },
        lifecycleStatus: {
          in: [
            QuizAttemptStatus.DRAFT,
            QuizAttemptStatus.SCORING,
            QuizAttemptStatus.SCORING_FAILED,
          ],
        },
      },
      orderBy: [{ savedAt: 'desc' }, { id: 'desc' }],
      take: MAX_ACTIVE_QUIZ_DRAFTS,
    });
    return { items: attempts.map(serializeAttemptLifecycle) };
  }

  async getAttempt(userId: string, attemptId: string) {
    const attempt = await this.prisma.quizAttempt.findFirst({
      where: { id: attemptId, userId },
    });
    if (!attempt) throw new NotFoundException('答题记录不存在');
    if (!attempt.submittedAt && !attempt.savedAt) {
      quizConflict(
        'QUIZ_DRAFT_NOT_RESUMABLE',
        '该旧版未提交答题不支持恢复，请重新开始',
      );
    }
    if (
      !attempt.submittedAt &&
      attempt.expiresAt &&
      attempt.expiresAt <= new Date()
    ) {
      quizConflict('QUIZ_DRAFT_EXPIRED', '该答题草稿已过期，请重新开始');
    }
    return serializeAttemptLifecycle(attempt);
  }

  async saveDraft(
    userId: string,
    attemptId: string,
    revision: number,
    position: number,
    rawAnswers: unknown,
  ) {
    const attempt = await this.prisma.quizAttempt.findFirst({
      where: { id: attemptId, userId },
    });
    if (!attempt) throw new NotFoundException('答题记录不存在');
    const snapshot = readAttemptSnapshot(attempt.snapshot);
    if (position >= snapshot.length) {
      throw new BadRequestException('答题位置超出题目范围');
    }
    const answers = validateAnswers(snapshot, rawAnswers);
    const now = new Date();
    const updated = await this.prisma.quizAttempt.updateMany({
      where: {
        id: attemptId,
        userId,
        lifecycleStatus: QuizAttemptStatus.DRAFT,
        submittedAt: null,
        abandonedAt: null,
        draftRevision: revision,
        expiresAt: { gt: now },
      },
      data: {
        answers: answers as Prisma.InputJsonValue,
        position,
        savedAt: now,
        expiresAt: new Date(now.getTime() + QUIZ_DRAFT_TTL_MS),
        draftRevision: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      quizConflict(
        'QUIZ_DRAFT_CONFLICT',
        '草稿版本或状态已变化，请重新载入后继续',
      );
    }
    return {
      attemptId,
      revision: revision + 1,
      position,
      savedAt: now,
      expiresAt: new Date(now.getTime() + QUIZ_DRAFT_TTL_MS),
    };
  }

  async abandonAttempt(userId: string, attemptId: string) {
    const attempt = await this.prisma.quizAttempt.findFirst({
      where: { id: attemptId, userId },
      select: {
        id: true,
        lifecycleStatus: true,
        submittedAt: true,
        abandonedAt: true,
      },
    });
    if (!attempt) throw new NotFoundException('答题记录不存在');
    if (attempt.abandonedAt) {
      return { attemptId, abandoned: true as const };
    }
    if (
      attempt.submittedAt ||
      attempt.lifecycleStatus === QuizAttemptStatus.SUBMITTED
    ) {
      quizConflict('QUIZ_ATTEMPT_SUBMITTED', '已提交答题不能放弃');
    }
    if (attempt.lifecycleStatus === QuizAttemptStatus.SCORING) {
      quizConflict('QUIZ_ATTEMPT_SCORING', '评分进行中，不能放弃答题');
    }
    const now = new Date();
    const updated = await this.prisma.quizAttempt.updateMany({
      where: {
        id: attemptId,
        userId,
        submittedAt: null,
        abandonedAt: null,
        lifecycleStatus: {
          in: [QuizAttemptStatus.DRAFT, QuizAttemptStatus.SCORING_FAILED],
        },
      },
      data: {
        lifecycleStatus: QuizAttemptStatus.ABANDONED,
        abandonedAt: now,
        gradingOwnerToken: null,
        gradingLeasedUntil: null,
      },
    });
    if (updated.count !== 1) {
      quizConflict('QUIZ_ATTEMPT_STATUS_CHANGED', '答题状态已变化，请刷新');
    }
    return { attemptId, abandoned: true as const, abandonedAt: now };
  }

  async submit(userId: string, attemptId: string, rawAnswers: unknown) {
    const attempt = await this.prisma.quizAttempt.findFirstOrThrow({
      where: { id: attemptId, userId },
    });
    const snapshot = readAttemptSnapshot(attempt.snapshot);
    const answers = validateAnswers(snapshot, rawAnswers);
    const submissionHash = attemptSubmissionHash(snapshot, answers);
    if (attempt.submittedAt) {
      const storedHash =
        attempt.submissionHash ??
        attemptSubmissionHash(
          snapshot,
          validateAnswers(snapshot, attempt.answers ?? {}),
        );
      if (storedHash !== submissionHash) {
        quizConflict(
          'QUIZ_SUBMISSION_CONFLICT',
          '该次答题已经使用不同答案提交',
        );
      }
      return serializeSubmittedAttempt(attempt);
    }
    if (attempt.abandonedAt) {
      quizConflict('QUIZ_ATTEMPT_ABANDONED', '该答题已放弃');
    }
    if (attempt.submissionHash && attempt.submissionHash !== submissionHash) {
      quizConflict(
        'QUIZ_SUBMISSION_CONFLICT',
        '评分开始后不能使用不同答案重新提交',
      );
    }
    const now = new Date();
    if (
      attempt.savedAt &&
      attempt.expiresAt &&
      attempt.expiresAt <= now &&
      attempt.lifecycleStatus !== QuizAttemptStatus.SCORING
    ) {
      quizConflict('QUIZ_DRAFT_EXPIRED', '该答题草稿已过期，请重新开始');
    }
    if (
      attempt.lifecycleStatus === QuizAttemptStatus.SCORING &&
      attempt.gradingLeasedUntil &&
      attempt.gradingLeasedUntil > now
    ) {
      return {
        attemptId,
        status: QuizAttemptStatus.SCORING,
        pending: true as const,
      };
    }
    const ownerToken = randomUUID();
    const claimed = await this.prisma.quizAttempt.updateMany({
      where: {
        id: attemptId,
        userId,
        submittedAt: null,
        abandonedAt: null,
        OR: [
          { lifecycleStatus: QuizAttemptStatus.DRAFT },
          { lifecycleStatus: QuizAttemptStatus.SCORING_FAILED },
          { lifecycleStatus: null },
          {
            lifecycleStatus: QuizAttemptStatus.SCORING,
            OR: [
              { gradingLeasedUntil: null },
              { gradingLeasedUntil: { lte: now } },
            ],
          },
        ],
        AND: [
          {
            OR: [{ submissionHash: null }, { submissionHash }],
          },
        ],
      },
      data: {
        lifecycleStatus: QuizAttemptStatus.SCORING,
        answers: answers as Prisma.InputJsonValue,
        submissionHash,
        gradingOwnerToken: ownerToken,
        gradingLeasedUntil: new Date(now.getTime() + QUIZ_GRADING_LEASE_MS),
        gradingError: null,
      },
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.quizAttempt.findFirstOrThrow({
        where: { id: attemptId, userId },
      });
      if (current.submittedAt) {
        const currentHash =
          current.submissionHash ??
          attemptSubmissionHash(
            snapshot,
            validateAnswers(snapshot, current.answers ?? {}),
          );
        if (currentHash !== submissionHash) {
          quizConflict(
            'QUIZ_SUBMISSION_CONFLICT',
            '该次答题已经使用不同答案提交',
          );
        }
        return serializeSubmittedAttempt(current);
      }
      if (
        current.lifecycleStatus === QuizAttemptStatus.SCORING &&
        current.submissionHash === submissionHash
      ) {
        return {
          attemptId,
          status: QuizAttemptStatus.SCORING,
          pending: true as const,
        };
      }
      quizConflict(
        'QUIZ_ATTEMPT_STATUS_CHANGED',
        '答题状态已变化，请刷新后重试',
      );
    }
    const concurrency = Number(process.env.QUIZ_GRADING_CONCURRENCY ?? 3);
    let gradingLeaseLost = false;
    const heartbeat = setInterval(() => {
      void this.prisma.quizAttempt
        .updateMany({
          where: {
            id: attemptId,
            lifecycleStatus: QuizAttemptStatus.SCORING,
            gradingOwnerToken: ownerToken,
          },
          data: {
            gradingLeasedUntil: new Date(Date.now() + QUIZ_GRADING_LEASE_MS),
          },
        })
        .then((result) => {
          if (result.count !== 1) gradingLeaseLost = true;
        })
        .catch(() => {
          gradingLeaseLost = true;
        });
    }, Math.max(1_000, Math.floor(QUIZ_GRADING_LEASE_MS / 3)));
    heartbeat.unref();
    let result: Awaited<ReturnType<typeof scoreSnapshot>>;
    try {
      result = await scoreSnapshot(
        snapshot,
        answers,
        this.shortAnswerGrader,
        concurrency,
      );
    } catch (error) {
      await this.prisma.quizAttempt.updateMany({
        where: {
          id: attemptId,
          lifecycleStatus: QuizAttemptStatus.SCORING,
          gradingOwnerToken: ownerToken,
        },
        data: {
          lifecycleStatus: QuizAttemptStatus.SCORING_FAILED,
          gradingOwnerToken: null,
          gradingLeasedUntil: null,
          gradingError: safeQuizError(error),
        },
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
    if (gradingLeaseLost) {
      quizConflict(
        'QUIZ_GRADING_LEASE_LOST',
        '评分任务已由其他请求接管，请刷新结果',
      );
    }
    const questionsById = new Map(
      snapshot.map((question) => [question.id, question]),
    );
    await this.prisma.$transaction(async (transaction) => {
      await lockUserPracticeProfile(transaction, userId);
      const submittedAt = new Date();
      const updated = await transaction.quizAttempt.updateMany({
        where: {
          id: attemptId,
          userId,
          submittedAt: null,
          lifecycleStatus: QuizAttemptStatus.SCORING,
          gradingOwnerToken: ownerToken,
          submissionHash,
        },
        data: {
          answers: answers as Prisma.InputJsonValue,
          results: result.results as unknown as Prisma.InputJsonValue,
          score: result.score,
          total: result.total,
          submittedAt,
          lifecycleStatus: QuizAttemptStatus.SUBMITTED,
          gradingOwnerToken: null,
          gradingLeasedUntil: null,
          gradingError: null,
        },
      });
      if (!updated.count) {
        quizConflict(
          'QUIZ_GRADING_LEASE_LOST',
          '评分任务已由其他请求接管，请刷新结果',
        );
      }

      for (const questionResult of result.results) {
        if (questionResult.correct) continue;
        const question = questionsById.get(questionResult.questionId);
        if (!question) continue;
        const criterionScores = questionResult.criterionScores
          ? (questionResult.criterionScores as unknown as Prisma.InputJsonValue)
          : undefined;
        const lastWrongAnswer =
          question.type === QuestionType.SHORT_ANSWER
            ? (answers[question.id]?.[0] ?? '')
            : null;
        const wrongQuestion = await transaction.quizWrongQuestion.upsert({
          where: {
            userId_questionId: { userId, questionId: question.id },
          },
          create: {
            userId,
            questionId: question.id,
            type: question.type,
            typeLabel: question.typeLabel ?? question.type,
            subjectId: question.subject.id,
            category: question.category ?? QuizQuestionCategory.STANDARD,
            origin: question.origin ?? QuizQuestionOrigin.MANUAL,
            prompt: question.prompt,
            crossChapter: question.chapters.length > 1,
            isPastPaper: Boolean(question.pastPaper),
            snapshot: question as unknown as Prisma.InputJsonValue,
            wrongCount: 1,
            lastScore: questionResult.score,
            lastWrongAnswer,
            lastFeedback: questionResult.feedback ?? null,
            ...(criterionScores
              ? { lastCriterionScores: criterionScores }
              : {}),
            lastWrongAt: submittedAt,
          },
          update: {
            type: question.type,
            typeLabel: question.typeLabel ?? question.type,
            subjectId: question.subject.id,
            category: question.category ?? QuizQuestionCategory.STANDARD,
            origin: question.origin ?? QuizQuestionOrigin.MANUAL,
            prompt: question.prompt,
            crossChapter: question.chapters.length > 1,
            isPastPaper: Boolean(question.pastPaper),
            snapshot: question as unknown as Prisma.InputJsonValue,
            wrongCount: { increment: 1 },
            lastScore: questionResult.score,
            lastWrongAnswer,
            lastFeedback: questionResult.feedback ?? null,
            lastCriterionScores: criterionScores ?? Prisma.DbNull,
            lastWrongAt: submittedAt,
          },
          select: { id: true },
        });
        await transaction.quizWrongQuestionChapter.deleteMany({
          where: { wrongQuestionId: wrongQuestion.id },
        });
        if (question.chapters.length) {
          await transaction.quizWrongQuestionChapter.createMany({
            data: question.chapters.map((chapter) => ({
              wrongQuestionId: wrongQuestion.id,
              chapterId: chapter.id,
            })),
            skipDuplicates: true,
          });
        }
      }

      await applySubmittedAttemptState(
        transaction,
        {
          id: attemptId,
          userId,
          snapshot: attempt.snapshot,
          results: result.results as unknown as Prisma.JsonValue,
          submittedAt,
          dailyPracticePlanRevisionId:
            attempt.dailyPracticePlanRevisionId ?? null,
        },
        submittedAt,
      );

      if (attempt.dailyPracticePlanRevisionId) {
        const revision = await transaction.dailyPracticePlanRevision.findUnique(
          {
            where: { id: attempt.dailyPracticePlanRevisionId },
            select: { dayId: true },
          },
        );
        if (revision) {
          await transaction.dailyPracticeDay.updateMany({
            where: {
              id: revision.dayId,
              activeRevisionId: attempt.dailyPracticePlanRevisionId,
            },
            data: {
              status: DailyPracticeDayStatus.COMPLETED,
              completedAt: submittedAt,
            },
          });
        }
      }
    });
    return {
      ...result,
      attemptId,
      status: QuizAttemptStatus.SUBMITTED,
      pending: false as const,
    };
  }

  async filters() {
    const availableWhere = questionWhere({});
    const [questionAggregates, chapterAggregates, subjects, papers] =
      await Promise.all([
        this.prisma.quizQuestion.groupBy({
          by: ['subjectId', 'type', 'typeLabel', 'pastPaperId'],
          where: availableWhere,
          _count: { _all: true },
        }),
        this.prisma.$queryRaw<
          Array<{
            chapterId: string;
            type: QuestionType;
            typeLabel: string;
            isPastPaper: number | bigint;
            total: number | bigint;
          }>
        >(Prisma.sql`
        SELECT
          link.chapterId,
          question.type,
          question.typeLabel,
          (question.pastPaperId IS NOT NULL) AS isPastPaper,
          COUNT(DISTINCT question.id) AS total
        FROM QuizQuestionChapter AS link
        INNER JOIN QuizQuestion AS question ON question.id = link.questionId
        INNER JOIN KnowledgeSubject AS subject ON subject.id = question.subjectId
        INNER JOIN SubjectChapter AS chapter ON chapter.id = link.chapterId
        WHERE question.enabled = true
          AND question.reviewStatus = 'APPROVED'
          AND question.origin IN ('MANUAL', 'CSV')
          AND subject.active = true
          AND chapter.active = true
          AND NOT EXISTS (
            SELECT 1
            FROM QuizQuestionChapter AS inactiveLink
            INNER JOIN SubjectChapter AS inactiveChapter
              ON inactiveChapter.id = inactiveLink.chapterId
            WHERE inactiveLink.questionId = question.id
              AND inactiveChapter.active = false
          )
        GROUP BY
          link.chapterId,
          question.type,
          question.typeLabel,
          (question.pastPaperId IS NOT NULL)
      `),
        this.prisma.subject.findMany({
          where: { active: true, quizQuestions: { some: availableWhere } },
          select: {
            ...SUBJECT_SELECT,
            chapters: {
              where: { active: true },
              select: CHAPTER_SELECT,
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            },
          },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        }),
        this.prisma.quizPaper.findMany({
          where: {
            subject: { active: true },
            questions: { some: availableWhere },
          },
          select: {
            id: true,
            title: true,
            subjectId: true,
            subject: { select: SUBJECT_SELECT },
            year: true,
            _count: { select: { questions: { where: availableWhere } } },
          },
          orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
        }),
      ]);

    type TypeTotals = {
      gradingTypes: Set<QuestionType>;
      total: number;
      randomEligibleCount: number;
      pastPaperCount: number;
    };
    const groups = new Map<string, Map<string, TypeTotals>>();
    const chapterGroups = new Map<
      string,
      Map<string, Map<string, TypeTotals>>
    >();

    const addType = (
      types: Map<string, TypeTotals>,
      question: {
        type: QuestionType;
        typeLabel: string;
        count: number;
        isPastPaper: boolean;
      },
    ) => {
      const type = types.get(question.typeLabel) ?? {
        gradingTypes: new Set<QuestionType>(),
        total: 0,
        randomEligibleCount: 0,
        pastPaperCount: 0,
      };
      type.gradingTypes.add(question.type);
      type.total += question.count;
      if (question.isPastPaper) type.pastPaperCount += question.count;
      else type.randomEligibleCount += question.count;
      types.set(question.typeLabel, type);
    };

    const serializeTypes = (types: Map<string, TypeTotals>) =>
      [...types.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
        .map(([label, value]) => ({
          label,
          gradingTypes: [...value.gradingTypes],
          total: value.total,
          randomEligibleCount: value.randomEligibleCount,
          pastPaperCount: value.pastPaperCount,
        }));

    for (const aggregate of questionAggregates) {
      const types = groups.get(aggregate.subjectId) ?? new Map();
      addType(types, {
        type: aggregate.type,
        typeLabel: aggregate.typeLabel,
        count: aggregate._count._all,
        isPastPaper: Boolean(aggregate.pastPaperId),
      });
      groups.set(aggregate.subjectId, types);
    }

    const chapterById = new Map(
      subjects.flatMap((subject) =>
        subject.chapters.map((chapter) => [chapter.id, chapter] as const),
      ),
    );
    for (const aggregate of chapterAggregates) {
      const chapter = chapterById.get(aggregate.chapterId);
      if (!chapter) continue;
      const chapters = chapterGroups.get(chapter.subjectId) ?? new Map();
      const chapterTypes = chapters.get(chapter.id) ?? new Map();
      addType(chapterTypes, {
        type: aggregate.type,
        typeLabel: aggregate.typeLabel,
        count: Number(aggregate.total),
        isPastPaper: Boolean(Number(aggregate.isPastPaper)),
      });
      chapters.set(chapter.id, chapterTypes);
      chapterGroups.set(chapter.subjectId, chapters);
    }

    const availableTypes = new Set(
      questionAggregates.map((question) => question.type),
    );
    return {
      subjects: subjects.map((subject) => subject.name),
      types: Object.values(QuestionType).filter((type) =>
        availableTypes.has(type),
      ),
      subjectGroups: subjects.map((subject) => ({
        subjectId: subject.id,
        subject: subject.name,
        pastPaperCount: [...(groups.get(subject.id)?.values() ?? [])].reduce(
          (sum, value) => sum + value.pastPaperCount,
          0,
        ),
        types: serializeTypes(groups.get(subject.id) ?? new Map()),
        chapters: subject.chapters
          .filter((chapter) => chapterGroups.get(subject.id)?.has(chapter.id))
          .map((chapter) => {
            const types = chapterGroups.get(subject.id)!.get(chapter.id)!;
            const totals = [...types.values()];
            return {
              chapterId: chapter.id,
              chapter: chapter.name,
              total: totals.reduce((sum, value) => sum + value.total, 0),
              randomEligibleCount: totals.reduce(
                (sum, value) => sum + value.randomEligibleCount,
                0,
              ),
              pastPaperCount: totals.reduce(
                (sum, value) => sum + value.pastPaperCount,
                0,
              ),
              types: serializeTypes(types),
            };
          }),
        pastPapers: papers
          .filter((paper) => paper.subjectId === subject.id)
          .map(({ _count, ...paper }) => ({
            ...paper,
            subject: paper.subject.name,
            questionCount: _count.questions,
          })),
      })),
    };
  }

  async listQuestions(filters: LibraryFilters) {
    await this.validateFilterTaxonomy(filters.subjectId, filters.chapterIds);
    const where = questionWhere(filters);
    if (filters.typeLabel) where.typeLabel = filters.typeLabel;
    if (filters.paperId) where.pastPaperId = filters.paperId;
    else if (filters.pastPaper === 'ONLY') where.pastPaperId = { not: null };
    else if (filters.pastPaper === 'EXCLUDE') where.pastPaperId = null;
    if (filters.search) where.prompt = { contains: filters.search };
    await this.applyComprehensiveInclusion(where, filters.includeCrossChapter);

    const [items, total] = await Promise.all([
      this.prisma.quizQuestion.findMany({
        where,
        select: LIBRARY_QUESTION_SELECT,
        orderBy: [
          { subjectId: 'asc' },
          { typeLabel: 'asc' },
          { paperOrder: 'asc' },
          { createdAt: 'desc' },
        ],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.quizQuestion.count({ where }),
    ]);
    return {
      items: items.map(toLibraryQuestion),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async wrongQuestions(userId: string, filters: WrongQuestionFilters) {
    await this.validateFilterTaxonomy(filters.subjectId, filters.chapterIds);
    const where: Prisma.QuizWrongQuestionWhereInput = { userId };
    if (filters.subjectId) where.subjectId = filters.subjectId;
    if (filters.chapterIds?.length) {
      if (filters.chapterMatch === 'ALL') {
        where.AND = filters.chapterIds.map((chapterId) => ({
          chapters: { some: { chapterId } },
        }));
      } else {
        where.chapters = {
          some: { chapterId: { in: filters.chapterIds } },
        };
      }
    }
    if (!filters.includeCrossChapter) where.crossChapter = false;
    if (filters.typeLabel) where.typeLabel = filters.typeLabel;
    if (filters.source === 'AI') {
      where.origin = QuizQuestionOrigin.AI_GENERATED;
    } else if (filters.source === 'NON_AI') {
      where.origin = {
        in: [QuizQuestionOrigin.MANUAL, QuizQuestionOrigin.CSV],
      };
    }
    if (filters.search) where.prompt = { contains: filters.search };

    const [rows, total] = await Promise.all([
      this.prisma.quizWrongQuestion.findMany({
        where,
        include: { chapters: { select: { chapterId: true } } },
        orderBy: [{ lastWrongAt: 'desc' }, { id: 'asc' }],
        skip: (filters.page - 1) * filters.pageSize,
        take: filters.pageSize,
      }),
      this.prisma.quizWrongQuestion.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        ...serializeHistoricalQuestion(row.snapshot),
        id: row.questionId,
        type: row.type,
        typeLabel: row.typeLabel,
        subjectId: row.subjectId,
        chapterIds: row.chapters.map(({ chapterId }) => chapterId),
        category: row.category,
        origin: row.origin,
        retired: row.origin === QuizQuestionOrigin.AI_GENERATED,
        prompt: row.prompt,
        isPastPaper: row.isPastPaper,
        wrongCount: row.wrongCount,
        lastScore: row.lastScore ?? undefined,
        lastWrongAnswer: row.lastWrongAnswer ?? undefined,
        lastFeedback: row.lastFeedback ?? undefined,
        criterionScores:
          (row.lastCriterionScores as unknown as
            QuizResult['criterionScores'] | null) ?? undefined,
        lastWrongAt: row.lastWrongAt,
      })),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  async listPapers(subjectId?: string) {
    const papers = await this.prisma.quizPaper.findMany({
      where: {
        ...(subjectId ? { subjectId } : {}),
        subject: { active: true },
        questions: { some: questionWhere({}) },
      },
      select: {
        id: true,
        title: true,
        subjectId: true,
        subject: { select: SUBJECT_SELECT },
        year: true,
        createdAt: true,
        questions: {
          where: questionWhere({}),
          select: { typeLabel: true },
        },
        _count: { select: { questions: { where: questionWhere({}) } } },
      },
      orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
    });
    const retiredCounts = papers.length
      ? await this.prisma.quizQuestion.groupBy({
          by: ['pastPaperId'],
          where: {
            pastPaperId: { in: papers.map((paper) => paper.id) },
            origin: QuizQuestionOrigin.AI_GENERATED,
          },
          _count: { _all: true },
        })
      : [];
    const retiredByPaper = new Map(
      retiredCounts.map((row) => [row.pastPaperId, row._count._all]),
    );
    return {
      items: papers.map(({ questions, _count, ...paper }) => ({
        ...paper,
        subject: paper.subject.name,
        typeLabels: [...new Set(questions.map((item) => item.typeLabel))].sort(
          (left, right) => left.localeCompare(right, 'zh-CN'),
        ),
        questionCount: _count.questions,
        retiredQuestionCount: retiredByPaper.get(paper.id) ?? 0,
      })),
      total: papers.length,
    };
  }

  async disableQuestion(id: string, afterMutation?: QuizQuestionMutationHook) {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.quizQuestion.updateMany({
        where: { id, enabled: true },
        data: { enabled: false },
      });
      if (updated.count) {
        await afterMutation?.(transaction, { id });
        return { id, deleted: true as const, changed: true };
      }

      const question = await transaction.quizQuestion.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!question) throw new NotFoundException('题目不存在');
      return { id, deleted: true as const, changed: false };
    });
  }

  private async validateQuestionTaxonomy(
    transaction: Prisma.TransactionClient,
    question: Pick<PreparedQuestion, 'subjectId' | 'chapterIds'>,
    context = '题目',
  ) {
    const subject = await transaction.subject.findFirst({
      where: { id: question.subjectId, active: true },
      select: { id: true },
    });
    if (!subject)
      throw new BadRequestException(`${context}的学科不存在或已停用`);
    const chapters = await transaction.subjectChapter.findMany({
      where: {
        id: { in: question.chapterIds },
        subjectId: question.subjectId,
        active: true,
      },
      select: { id: true },
    });
    if (chapters.length !== question.chapterIds.length) {
      throw new BadRequestException(
        `${context}的章节必须全部启用且属于所选学科`,
      );
    }
  }

  private async resolveImportQuestions(
    transaction: Prisma.TransactionClient,
    inputs: QuestionImportInput[],
    createMissingChapters = false,
  ) {
    const labels = inputs.map((input, index) => {
      const context = `第 ${index + 2} 行`;
      if (typeof input.subject !== 'string') {
        throw new BadRequestException(`${context}的 subject 必须是字符串`);
      }
      const subject = input.subject.trim();
      if (!subject || subject.length > 100) {
        throw new BadRequestException(
          `${context}的 subject 长度必须在 1-100 个字符之间`,
        );
      }
      if (input.chapter !== undefined && input.chapters !== undefined) {
        throw new BadRequestException(
          `${context}不能同时提供 chapter 和 chapters`,
        );
      }
      const rawChapters =
        input.chapters !== undefined ? input.chapters : [input.chapter];
      if (!Array.isArray(rawChapters)) {
        throw new BadRequestException(`${context}的 chapters 必须是字符串数组`);
      }
      const chapters = rawChapters.map((value, chapterIndex) => {
        if (typeof value !== 'string') {
          throw new BadRequestException(
            `${context}的 chapters[${chapterIndex}] 必须是字符串`,
          );
        }
        const name = value.trim();
        if (!name || name.length > 100) {
          throw new BadRequestException(
            `${context}的章节名称长度必须在 1-100 个字符之间`,
          );
        }
        return name;
      });
      if (chapters.length < 1 || chapters.length > 20) {
        throw new BadRequestException(`${context}必须包含 1-20 个章节`);
      }
      if (new Set(chapters).size !== chapters.length) {
        throw new BadRequestException(`${context}的 chapters 不能重复`);
      }
      return { subject, chapters, context };
    });

    const subjectNames = [...new Set(labels.map(({ subject }) => subject))];
    const subjects = await transaction.subject.findMany({
      where: { name: { in: subjectNames }, active: true },
      select: { id: true, name: true },
    });
    const subjectByName = new Map(
      subjects.map((subject) => [subject.name, subject]),
    );
    const resolvedLabels = labels.map((label) => {
      const subject = subjectByName.get(label.subject);
      if (!subject) {
        throw new BadRequestException(
          `${label.context}的学科“${label.subject}”不存在或已停用`,
        );
      }
      return { ...label, subject };
    });
    const chapterNames = [
      ...new Set(labels.flatMap(({ chapters }) => chapters)),
    ];
    const chapters = await transaction.subjectChapter.findMany({
      where: {
        subjectId: { in: subjects.map(({ id }) => id) },
        name: { in: chapterNames },
      },
      select: {
        id: true,
        subjectId: true,
        name: true,
        slug: true,
        active: true,
      },
    });
    const chapterBySubjectAndName = new Map(
      chapters.map((chapter) => [
        `${chapter.subjectId}\u0000${chapter.name}`,
        chapter,
      ]),
    );
    const missingChapters = new Map<
      string,
      AutoCreatedChapter & { active: true; sortOrder: number }
    >();

    for (const label of resolvedLabels) {
      for (const name of label.chapters) {
        const key = `${label.subject.id}\u0000${name}`;
        const existing = chapterBySubjectAndName.get(key);
        if (existing?.active === false) {
          throw new BadRequestException(
            `${label.context}的章节“${name}”已停用，请先在学科管理中重新启用`,
          );
        }
        if (existing || missingChapters.has(key)) continue;
        if (!createMissingChapters) {
          throw new BadRequestException(
            `${label.context}的章节“${name}”不存在、已停用或不属于“${label.subject.name}”`,
          );
        }
        missingChapters.set(key, {
          id: randomUUID(),
          subjectId: label.subject.id,
          name,
          slug: importedChapterSlug(label.subject.id, name),
          sortOrder: 0,
          active: true,
        });
      }
    }

    const createdChapters = [...missingChapters.values()];
    if (createdChapters.length) {
      await transaction.subjectChapter.createMany({
        data: createdChapters,
      });
      for (const chapter of createdChapters) {
        chapterBySubjectAndName.set(
          `${chapter.subjectId}\u0000${chapter.name}`,
          chapter,
        );
      }
    }

    const prepared = inputs.map((input, index) => {
      const label = resolvedLabels[index]!;
      const resolvedChapters = label.chapters.map((name) => {
        const chapter = chapterBySubjectAndName.get(
          `${label.subject.id}\u0000${name}`,
        );
        if (!chapter) {
          throw new BadRequestException(
            `${label.context}的章节“${name}”不存在、已停用或不属于“${label.subject.name}”`,
          );
        }
        return chapter;
      });
      return {
        question: prepareQuestion(
          {
            ...input,
            subjectId: label.subject.id,
            chapterIds: resolvedChapters.map(({ id }) => id),
          },
          label.context,
        ),
        order:
          input.paperOrder === undefined ||
          input.paperOrder === null ||
          input.paperOrder === ''
            ? undefined
            : parsePaperOrder(input.paperOrder, index + 1, label.context),
      };
    });
    return {
      prepared,
      createdChapters: createdChapters.map(({ id, subjectId, name, slug }) => ({
        id,
        subjectId,
        name,
        slug,
      })),
    };
  }

  async createQuestion(
    userId: string,
    input: QuestionInput,
    assignment?: { pastPaperId?: string; paperOrder?: number },
    afterMutation?: QuizQuestionMutationHook,
  ) {
    const question = prepareQuestion(input);
    return this.prisma.$transaction(async (transaction) => {
      await this.validateQuestionTaxonomy(transaction, question);
      let paper: { id: string; order: number } | undefined;
      if (assignment?.pastPaperId) {
        const [pastPaper, lastQuestion] = await Promise.all([
          transaction.quizPaper.findUniqueOrThrow({
            where: { id: assignment.pastPaperId },
            select: { id: true, subjectId: true },
          }),
          transaction.quizQuestion.findFirst({
            where: { pastPaperId: assignment.pastPaperId },
            select: { paperOrder: true },
            orderBy: { paperOrder: 'desc' },
          }),
        ]);
        if (pastPaper.subjectId !== question.subjectId) {
          throw new BadRequestException('题目学科必须与往年真题试卷学科一致');
        }
        paper = {
          id: pastPaper.id,
          order: parsePaperOrder(
            assignment.paperOrder,
            (lastQuestion?.paperOrder ?? 0) + 1,
            '题目',
          ),
        };
      } else if (assignment?.paperOrder !== undefined) {
        throw new BadRequestException('paperOrder 只能用于往年真题');
      }
      const activeQuestions = await assertQuizQuestionCapacity(transaction, 1);
      const created = await transaction.quizQuestion.create({
        data: {
          ...prismaQuestionData(
            question,
            userId,
            QuizQuestionOrigin.MANUAL,
            undefined,
            paper,
          ),
          chapters: {
            createMany: {
              data: question.chapterIds.map((chapterId) => ({ chapterId })),
            },
          },
        },
        include: QUESTION_INCLUDE,
      });
      await recordCreatedQuestions(transaction, activeQuestions, 1);
      await afterMutation?.(transaction, created);
      return created;
    });
  }

  async updateQuestion(
    id: string,
    input: QuestionInput,
    afterMutation?: QuizQuestionMutationHook,
  ) {
    const question = prepareQuestion(input);
    return this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.quizQuestion.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          pastPaper: { select: { subjectId: true } },
        },
      });
      await this.validateQuestionTaxonomy(transaction, question);
      if (
        existing.pastPaper &&
        existing.pastPaper.subjectId !== question.subjectId
      ) {
        throw new BadRequestException('题目学科必须与往年真题试卷学科一致');
      }
      await transaction.quizQuestionChapter.deleteMany({
        where: { questionId: id },
      });
      const updated = await transaction.quizQuestion.update({
        where: { id },
        data: {
          ...prismaQuestionUpdateData(question),
          contentRevision: { increment: 1 },
          chapters: {
            createMany: {
              data: question.chapterIds.map((chapterId) => ({ chapterId })),
            },
          },
        },
        include: QUESTION_INCLUDE,
      });
      await afterMutation?.(transaction, updated);
      return updated;
    });
  }

  async getQuestionForEdit(id: string) {
    const question = await this.prisma.quizQuestion.findFirst({
      where: { id, enabled: true },
      include: QUESTION_INCLUDE,
    });
    if (!question) throw new NotFoundException('题目不存在');
    return question;
  }

  async importQuestions(
    userId: string,
    inputs: QuestionImportInput[],
    options: ImportQuestionsOptions = {},
  ) {
    if (options.pastPaperId && options.pastPaper) {
      throw new BadRequestException('不能同时指定 pastPaperId 和新试卷信息');
    }

    const persist = async (
      transaction: Prisma.TransactionClient,
      prepared: Array<{ question: PreparedQuestion; order?: number }>,
      paper?: { id: string; startOrder: number },
    ) => {
      const activeQuestions = await assertQuizQuestionCapacity(
        transaction,
        prepared.length,
      );
      const records = prepared.map(({ question, order }, index) => ({
        id: randomUUID(),
        question,
        order: paper ? (order ?? paper.startOrder + index) : undefined,
      }));
      const result = await transaction.quizQuestion.createMany({
        data: records.map(({ id, question, order }) =>
          prismaQuestionData(
            question,
            userId,
            QuizQuestionOrigin.CSV,
            id,
            paper ? { id: paper.id, order: order! } : undefined,
          ),
        ),
      });
      await transaction.quizQuestionChapter.createMany({
        data: records.flatMap(({ id, question }) =>
          question.chapterIds.map((chapterId) => ({
            questionId: id,
            chapterId,
          })),
        ),
      });
      await recordCreatedQuestions(
        transaction,
        activeQuestions,
        result.count,
      );
      return result;
    };

    if (!options.pastPaperId && !options.pastPaper) {
      if (inputs.some((input) => input.paperOrder !== undefined)) {
        throw new BadRequestException('paperOrder 只能用于往年真题导入');
      }
      return this.prisma.$transaction(async (transaction) => {
        const { prepared, createdChapters } = await this.resolveImportQuestions(
          transaction,
          inputs,
          options.createMissingChapters,
        );
        const result = await persist(transaction, prepared);
        return { imported: result.count, pastPaper: null, createdChapters };
      });
    }

    if (options.pastPaperId) {
      return this.prisma.$transaction(async (transaction) => {
        const paper = await transaction.quizPaper.findUniqueOrThrow({
          where: { id: options.pastPaperId },
          select: {
            id: true,
            title: true,
            subjectId: true,
            subject: { select: SUBJECT_SELECT },
            year: true,
          },
        });
        const { prepared, createdChapters } = await this.resolveImportQuestions(
          transaction,
          inputs,
          options.createMissingChapters,
        );
        if (
          prepared.some(
            ({ question }) => question.subjectId !== paper.subjectId,
          )
        ) {
          throw new BadRequestException(
            '所有导入题目的学科必须与往年真题试卷一致',
          );
        }
        const lastQuestion = await transaction.quizQuestion.findFirst({
          where: { pastPaperId: paper.id },
          select: { paperOrder: true },
          orderBy: { paperOrder: 'desc' },
        });
        const result = await persist(transaction, prepared, {
          id: paper.id,
          startOrder: (lastQuestion?.paperOrder ?? 0) + 1,
        });
        return {
          imported: result.count,
          pastPaper: { ...paper, subject: paper.subject.name },
          createdChapters,
        };
      });
    }

    const definition = options.pastPaper!;
    const title = definition.title.trim();
    if (!title || title.length > 160) {
      throw new BadRequestException(
        '往年真题试卷标题长度必须在 1-160 个字符之间',
      );
    }
    if (
      definition.year !== undefined &&
      (!Number.isInteger(definition.year) ||
        definition.year < 1900 ||
        definition.year > 2200)
    ) {
      throw new BadRequestException('往年真题年份必须是 1900-2200 的整数');
    }
    return this.prisma.$transaction(async (transaction) => {
      const subject = await transaction.subject.findFirst({
        where: { id: definition.subjectId, active: true },
        select: SUBJECT_SELECT,
      });
      if (!subject) throw new BadRequestException('往年真题学科不存在或已停用');
      const { prepared, createdChapters } = await this.resolveImportQuestions(
        transaction,
        inputs,
        options.createMissingChapters,
      );
      if (prepared.some(({ question }) => question.subjectId !== subject.id)) {
        throw new BadRequestException(
          '所有导入题目的学科必须与往年真题试卷一致',
        );
      }
      const paper = await transaction.quizPaper.create({
        data: {
          title,
          subjectId: subject.id,
          year: definition.year,
          authorId: userId,
        },
        select: {
          id: true,
          title: true,
          subjectId: true,
          subject: { select: SUBJECT_SELECT },
          year: true,
        },
      });
      const result = await persist(transaction, prepared, {
        id: paper.id,
        startOrder: 1,
      });
      return {
        imported: result.count,
        pastPaper: { ...paper, subject: paper.subject.name },
        createdChapters,
      };
    });
  }
}
