import { createHash } from 'node:crypto';
import { isPracticeDate, nextPracticeDate } from './time';
import { curriculumSource } from './curriculum-source';

export const PRACTICE_SUBJECT_SLUGS = [
  'medical-molecular-cell-genetics',
  'human-morphology-function',
] as const;

export function defaultPracticeCurriculum() {
  return curriculumSource.courses.map((course) => {
    const grouped = new Map<string, PracticeCourseTopic>();
    for (const lesson of curriculumSource.lessons.filter(
      (item) => item.courseCode === course.code,
    )) {
      const title = lesson.title
        .replace(/（/gu, '(')
        .replace(/）/gu, ')')
        .replace(/(?:[1-3]|\((?:上|下)\))$/u, '')
        .trim();
      let topic = grouped.get(title);
      if (!topic) {
        topic = {
          id: `${course.code.toLowerCase()}-${createHash('sha256').update(title).digest('hex').slice(0, 16)}`,
          title,
          sessionDates: [],
          sourceRefs: [],
          paused: false,
          taughtOnOverride: null,
        };
        grouped.set(title, topic);
      }
      topic.sessionDates.push(lesson.date);
      topic.sourceRefs.push(lesson.source);
    }
    const topics = parseCourseTopics([...grouped.values()]);
    return {
      subjectSlug: course.code === 'MCG' ? PRACTICE_SUBJECT_SLUGS[0] : PRACTICE_SUBJECT_SLUGS[1],
      termKey: curriculumSource.semester,
      startDate: curriculumSource.startsOn,
      examDate: course.examDate,
      topics,
      topicHash: courseTopicHash(topics),
    };
  });
}

export interface PracticeCourseTopic {
  id: string;
  title: string;
  sessionDates: string[];
  sourceRefs: string[];
  paused: boolean;
  taughtOnOverride: string | null;
}

export interface PracticeCourseSnapshot {
  id: string;
  subjectId: string;
  subjectName: string;
  termKey: string;
  startDate: string;
  examDate: string;
  enabled: boolean;
  revision: number;
  topicHash: string;
  topics: PracticeCourseTopic[];
}

export function parseCourseTopics(value: unknown): PracticeCourseTopic[] {
  if (!Array.isArray(value) || !value.length || value.length > 300) {
    throw new RangeError('课程须包含 1 至 300 个理论主题');
  }
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new RangeError('主题格式错误');
    const topic = entry as Record<string, unknown>;
    if (typeof topic.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(topic.id) || seen.has(topic.id)) {
      throw new RangeError('主题 ID 无效或重复');
    }
    seen.add(topic.id);
    if (typeof topic.title !== 'string' || !topic.title.trim() || topic.title.length > 200) {
      throw new RangeError('主题标题无效');
    }
    if (
      !Array.isArray(topic.sessionDates) ||
      !topic.sessionDates.length ||
      topic.sessionDates.some((date) => typeof date !== 'string' || !isPracticeDate(date))
    ) {
      throw new RangeError('授课日期须为有效的 YYYY-MM-DD');
    }
    if (
      typeof topic.paused !== 'boolean' ||
      (topic.taughtOnOverride !== null &&
        (typeof topic.taughtOnOverride !== 'string' || !isPracticeDate(topic.taughtOnOverride)))
    ) {
      throw new RangeError('主题暂停状态或调整日期无效');
    }
    if (
      !Array.isArray(topic.sourceRefs) ||
      topic.sourceRefs.some((ref) => typeof ref !== 'string' || ref.length > 200)
    ) {
      throw new RangeError('课表来源无效');
    }
    return {
      id: topic.id,
      title: topic.title.trim(),
      sessionDates: [...new Set(topic.sessionDates as string[])].sort(),
      sourceRefs: [...new Set(topic.sourceRefs as string[])],
      paused: topic.paused,
      taughtOnOverride: topic.taughtOnOverride as string | null,
    };
  });
}

// Calendar edits deliberately do not invalidate semantic classification.
export function courseTopicHash(topics: readonly PracticeCourseTopic[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [...topics]
          .map(({ id, title }) => ({ id, title }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
    )
    .digest('hex');
}

export function topicTaughtOn(topic: PracticeCourseTopic): string {
  return topic.taughtOnOverride ?? [...topic.sessionDates].sort().at(-1)!;
}

export function topicAvailableOn(topic: PracticeCourseTopic): string {
  return nextPracticeDate(topicTaughtOn(topic));
}

export function courseStatus(
  course: Pick<PracticeCourseSnapshot, 'enabled' | 'startDate' | 'examDate'>,
  practiceDate: string,
) {
  if (!isPracticeDate(practiceDate)) throw new RangeError('练习日无效');
  if (!course.enabled) return 'PAUSED' as const;
  if (practiceDate < course.startDate) return 'UPCOMING' as const;
  if (practiceDate > course.examDate) return 'COMPLETED' as const;
  return 'ACTIVE' as const;
}

export function learnedCourseTopics(
  course: PracticeCourseSnapshot,
  practiceDate: string,
): PracticeCourseTopic[] {
  if (courseStatus(course, practiceDate) !== 'ACTIVE') return [];
  return course.topics.filter((topic) => !topic.paused && topicAvailableOn(topic) <= practiceDate);
}

export function topicIdsAreEligible(
  course: PracticeCourseSnapshot,
  topicIds: unknown,
  practiceDate: string,
): boolean {
  if (!Array.isArray(topicIds) || !topicIds.length || new Set(topicIds).size !== topicIds.length)
    return false;
  const learned = new Set(learnedCourseTopics(course, practiceDate).map((topic) => topic.id));
  return topicIds.every((id) => typeof id === 'string' && learned.has(id));
}
