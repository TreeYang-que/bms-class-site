import {
  courseStatus,
  learnedCourseTopics,
  parseCourseTopics,
  practiceDateFromDbDate,
  PRACTICE_SUBJECT_SLUGS,
  topicIdsAreEligible,
  type PracticeCourseSnapshot,
} from '@bmc3/daily-practice-core';
import { Prisma, type PrismaClient } from '@prisma/client';

export type CurriculumClient = Pick<
  PrismaClient,
  'practiceCourse' | 'quizQuestion' | 'practiceQuestionMapping'
>;

export function practiceQuestionWhere(): Prisma.QuizQuestionWhereInput {
  return {
    enabled: true,
    reviewStatus: 'APPROVED',
    origin: { in: ['MANUAL', 'CSV'] },
    subject: { active: true, slug: { in: [...PRACTICE_SUBJECT_SLUGS] } },
    chapters: { some: {}, none: { chapter: { active: false } } },
  };
}

export async function loadPracticeCourses(
  client: Pick<CurriculumClient, 'practiceCourse'>,
): Promise<PracticeCourseSnapshot[]> {
  const courses = await client.practiceCourse.findMany({
    where: { subject: { active: true, slug: { in: [...PRACTICE_SUBJECT_SLUGS] } } },
    include: { subject: { select: { name: true } } },
    orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
  });
  return courses.map((course) => ({
    id: course.id,
    subjectId: course.subjectId,
    subjectName: course.subject.name,
    termKey: course.termKey,
    startDate: practiceDateFromDbDate(course.startDate),
    examDate: practiceDateFromDbDate(course.examDate),
    enabled: course.enabled,
    revision: course.revision,
    topicHash: course.topicHash,
    topics: parseCourseTopics(course.topics),
  }));
}

export const curriculumCandidateInclude = {
  subject: true,
  chapters: { include: { chapter: true } },
  curriculumMapping: true,
} satisfies Prisma.QuizQuestionInclude;

export type CurriculumCandidate = Prisma.QuizQuestionGetPayload<{
  include: typeof curriculumCandidateInclude;
}>;

export function isCurriculumQuestionEligible(
  question: Pick<CurriculumCandidate, 'subjectId' | 'contentRevision' | 'curriculumMapping'>,
  courses: readonly PracticeCourseSnapshot[],
  practiceDate: string,
): boolean {
  const mapping = question.curriculumMapping;
  if (
    !mapping ||
    mapping.status !== 'READY' ||
    mapping.contentRevision !== question.contentRevision
  )
    return false;
  const course = courses.find(
    (item) => item.id === mapping.courseId && item.subjectId === question.subjectId,
  );
  return Boolean(
    course &&
    mapping.topicHash === course.topicHash &&
    topicIdsAreEligible(course, mapping.topicIds, practiceDate),
  );
}

export async function loadEligiblePracticeQuestions(
  client: CurriculumClient,
  practiceDate: string,
  options: { courses?: PracticeCourseSnapshot[]; questionIds?: string[]; cutoffAt?: Date } = {},
): Promise<CurriculumCandidate[]> {
  const courses = options.courses ?? (await loadPracticeCourses(client));
  const activeIds = courses
    .filter((course) => courseStatus(course, practiceDate) === 'ACTIVE')
    .map((course) => course.id);
  if (!activeIds.length || options.questionIds?.length === 0) return [];
  const result: CurriculumCandidate[] = [];
  let cursor: string | undefined;
  for (;;) {
    const questions = await client.quizQuestion.findMany({
      where: {
        ...practiceQuestionWhere(),
        ...(options.questionIds ? { id: { in: options.questionIds } } : {}),
        ...(options.cutoffAt
          ? { createdAt: { lte: options.cutoffAt }, updatedAt: { lte: options.cutoffAt } }
          : {}),
        curriculumMapping: {
          is: {
            status: 'READY',
            courseId: { in: activeIds },
            ...(options.cutoffAt ? { updatedAt: { lte: options.cutoffAt } } : {}),
          },
        },
      },
      include: curriculumCandidateInclude,
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    result.push(
      ...questions.filter((question) =>
        isCurriculumQuestionEligible(question, courses, practiceDate),
      ),
    );
    if (questions.length < 500) break;
    cursor = questions[questions.length - 1]!.id;
  }
  return result;
}

export async function assertDailyQuestionEligibility(
  client: CurriculumClient,
  practiceDate: string,
  items: readonly { questionId: string; questionContentRevision?: number | null }[],
): Promise<boolean> {
  if (!items.length || new Set(items.map((item) => item.questionId)).size !== items.length)
    return false;
  const questions = await loadEligiblePracticeQuestions(client, practiceDate, {
    questionIds: items.map((item) => item.questionId),
  });
  const byId = new Map(questions.map((question) => [question.id, question]));
  return items.every((item) => {
    const question = byId.get(item.questionId);
    return (
      question &&
      item.questionContentRevision != null &&
      question.contentRevision === item.questionContentRevision
    );
  });
}

/** SQL equivalent of the ALL-topics predicate, for bounded UI pagination. */
export function dailyCurriculumEligibilitySql(
  courses: readonly PracticeCourseSnapshot[],
  practiceDate: string,
): Prisma.Sql {
  const scopes = courses.flatMap((course) => {
    const ids = learnedCourseTopics(course, practiceDate).map((topic) => topic.id);
    return ids.length
      ? [
          Prisma.sql`(mapping.courseId = ${course.id}
      AND question.subjectId = ${course.subjectId} AND mapping.topicHash = ${course.topicHash}
      AND JSON_CONTAINS(${JSON.stringify(ids)}, mapping.topicIds))`,
        ]
      : [];
  });
  if (!scopes.length) return Prisma.sql`1 = 0`;
  return Prisma.sql`EXISTS (SELECT 1 FROM PracticeQuestionMapping AS mapping
    WHERE mapping.questionId = question.id AND mapping.status = 'READY'
      AND mapping.contentRevision = question.contentRevision
      AND JSON_TYPE(mapping.topicIds) = 'ARRAY' AND JSON_LENGTH(mapping.topicIds) > 0
      AND (${Prisma.join(scopes, ' OR ')}))`;
}
