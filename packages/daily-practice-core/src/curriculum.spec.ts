import {
  courseStatus,
  courseTopicHash,
  defaultPracticeCurriculum,
  learnedCourseTopics,
  topicIdsAreEligible,
  type PracticeCourseSnapshot,
} from './curriculum';
import { curriculumSource } from './curriculum-source';

function courses(): PracticeCourseSnapshot[] {
  return defaultPracticeCurriculum().map((course) => ({
    ...course,
    id: course.subjectSlug,
    subjectId: course.subjectSlug,
    subjectName: course.subjectSlug,
    revision: 1,
    enabled: true,
  }));
}

describe('course calendar and learning boundaries', () => {
  it('loads synthetic sessions and keeps topics assigned to their own course', () => {
    expect(curriculumSource.lessons).toHaveLength(5);
    const [mcg, morph] = courses();
    expect(mcg!.topics.some((topic) => topic.title === '肿瘤的分子遗传基础')).toBe(false);
    expect(morph!.topics.some((topic) => topic.title === '肿瘤的分子遗传基础')).toBe(true);
  });

  it('unlocks the previous day only, and waits for the final lecture of an unsplit series', () => {
    const [mcg, morph] = courses();
    const titles = (course: PracticeCourseSnapshot, date: string) =>
      learnedCourseTopics(course, date).map((topic) => topic.title);
    expect(titles(morph!, '2030-09-03')).not.toContain('基本组织(神经组织)');
    expect(titles(morph!, '2030-09-04')).toContain('基本组织(神经组织)');
    expect(titles(mcg!, '2030-09-11')).not.toContain('糖代谢');
    expect(titles(mcg!, '2030-09-12')).toContain('糖代谢');
  });

  it('requires every topic and honors postponement and pause', () => {
    const mcg = courses()[0]!;
    const early = mcg.topics.find((topic) => topic.title === '蛋白质的结构与功能')!;
    const late = mcg.topics.find((topic) => topic.title === '糖代谢')!;
    expect(topicIdsAreEligible(mcg, [early.id, late.id], '2030-09-04')).toBe(false);
    expect(topicIdsAreEligible(mcg, [early.id, late.id], '2030-09-12')).toBe(true);
    late.taughtOnOverride = '2030-10-10';
    expect(topicIdsAreEligible(mcg, [late.id], '2030-09-12')).toBe(false);
    late.paused = true;
    expect(topicIdsAreEligible(mcg, [late.id], '2030-10-11')).toBe(false);
  });

  it('ends each course the day after its own exam across the year boundary', () => {
    const [mcg, morph] = courses();
    expect(courseStatus(morph!, '2030-12-15')).toBe('ACTIVE');
    expect(courseStatus(morph!, '2030-12-16')).toBe('COMPLETED');
    expect(courseStatus(mcg!, '2031-01-15')).toBe('ACTIVE');
    expect(courseStatus(mcg!, '2031-01-16')).toBe('COMPLETED');
  });

  it('keeps semantic mappings reusable for calendar-only edits', () => {
    const topics = courses()[0]!.topics;
    const before = courseTopicHash(topics);
    topics[0]!.taughtOnOverride = '2030-09-10';
    expect(courseTopicHash(topics)).toBe(before);
    topics[0]!.title = '教学范围改变';
    expect(courseTopicHash(topics)).not.toBe(before);
  });
});
