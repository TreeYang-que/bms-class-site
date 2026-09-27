import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import {
  courseStatus,
  courseTopicHash,
  defaultPracticeCurriculum,
  isPracticeDate,
  parseCourseTopics,
  practiceDateForInstant,
  practiceDateFromDbDate,
  practiceDateToDbDate,
  PRACTICE_SUBJECT_SLUGS,
  topicAvailableOn,
  topicTaughtOn,
  type PracticeCourseSnapshot,
} from '@bmc3/daily-practice-core';
import { dailyCurriculumEligibilitySql, practiceQuestionWhere } from '@bmc3/daily-practice-prisma';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from '../common/audit.service';
import {
  PracticeCourseUpdateDto,
  PracticeMappingQueryDto,
  PracticeMappingUpdateDto,
} from './curriculum.dto';

const courseInclude = {
  subject: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.PracticeCourseInclude;
type Course = Prisma.PracticeCourseGetPayload<{ include: typeof courseInclude }>;

function snapshot(course: Course): PracticeCourseSnapshot {
  return {
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
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

@Injectable()
export class CurriculumService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(practiceDate = practiceDateForInstant(new Date())) {
    const courses = await this.prisma.practiceCourse.findMany({
      where: { subject: { slug: { in: [...PRACTICE_SUBJECT_SLUGS] } } },
      include: courseInclude,
      orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
    });
    const counts = await Promise.all(
      courses.map(async (course) => {
        const value = snapshot(course);
        const [statuses, eligible] = await Promise.all([
          this.prisma.$queryRaw<Array<{ statusKey: string; total: bigint | number }>>(Prisma.sql`
          SELECT CASE WHEN mapping.contentRevision <> question.contentRevision OR mapping.topicHash <> ${course.topicHash}
            THEN 'STALE' ELSE mapping.status END AS statusKey, COUNT(*) AS total
          FROM PracticeQuestionMapping AS mapping INNER JOIN QuizQuestion AS question ON question.id = mapping.questionId
          WHERE mapping.courseId = ${course.id} GROUP BY statusKey`),
          this.prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
          SELECT COUNT(*) AS total FROM QuizQuestion AS question
          INNER JOIN KnowledgeSubject AS subject ON subject.id = question.subjectId
          WHERE question.enabled = TRUE AND question.reviewStatus = 'APPROVED' AND question.origin IN ('MANUAL', 'CSV')
            AND subject.active = TRUE
            AND EXISTS (SELECT 1 FROM QuizQuestionChapter AS qc WHERE qc.questionId = question.id)
            AND NOT EXISTS (SELECT 1 FROM QuizQuestionChapter AS qc INNER JOIN SubjectChapter AS chapter ON chapter.id = qc.chapterId
              WHERE qc.questionId = question.id AND chapter.active = FALSE)
            AND ${dailyCurriculumEligibilitySql([value], practiceDate)}`),
        ]);
        const mappingCounts = { PENDING: 0, PROCESSING: 0, READY: 0, NEEDS_REVIEW: 0, STALE: 0 };
        for (const row of statuses) {
          if (Object.hasOwn(mappingCounts, row.statusKey))
            mappingCounts[row.statusKey as keyof typeof mappingCounts] = Number(row.total);
        }
        return { mappingCounts, eligibleQuestionCount: Number(eligible[0]?.total ?? 0) };
      }),
    );
    return {
      practiceDate,
      initialized: PRACTICE_SUBJECT_SLUGS.every((slug) =>
        courses.some((course) => course.subject.slug === slug),
      ),
      courses: courses.map((course, index) => {
        const value = snapshot(course);
        return {
          id: value.id,
          subjectId: value.subjectId,
          subject: course.subject,
          termKey: value.termKey,
          startDate: value.startDate,
          examDate: value.examDate,
          enabled: value.enabled,
          revision: value.revision,
          topicHash: value.topicHash,
          topics: value.topics.map((topic) => ({
            ...topic,
            taughtOn: topicTaughtOn(topic),
            availableOn: topicAvailableOn(topic),
            learned: !topic.paused && topicAvailableOn(topic) <= practiceDate,
          })),
          status: courseStatus(value, practiceDate),
          ...counts[index]!,
        };
      }),
    };
  }

  async initialize(user: User) {
    const definitions = defaultPracticeCurriculum();
    await this.prisma.$transaction(
      async (tx) => {
        const subjects = await tx.subject.findMany({
          where: { active: true, slug: { in: definitions.map((item) => item.subjectSlug) } },
        });
        if (subjects.length !== definitions.length)
          throw new BadRequestException('请先在学科目录启用医学分子细胞遗传和人体形态与功能总论');
        for (const definition of definitions) {
          const subject = subjects.find((item) => item.slug === definition.subjectSlug)!;
          const existing = await tx.practiceCourse.findUnique({
            where: { subjectId_termKey: { subjectId: subject.id, termKey: definition.termKey } },
          });
          if (existing) continue;
          const course = await tx.practiceCourse.create({
            data: {
              subjectId: subject.id,
              termKey: definition.termKey,
              startDate: practiceDateToDbDate(definition.startDate),
              examDate: practiceDateToDbDate(definition.examDate),
              topicHash: definition.topicHash,
              topics: json(definition.topics),
            },
            include: courseInclude,
          });
          await tx.practiceCourseRevision.create({
            data: {
              courseId: course.id,
              revision: 1,
              snapshot: json(snapshot(course)),
              reason: '从部署者配置的课程模板初始化理论课',
              publishedById: user.id,
            },
          });
          await this.audit.record(
            user.id,
            'daily-practice.curriculum.initialize',
            'PracticeCourse',
            course.id,
            { termKey: course.termKey, topicCount: definition.topics.length },
            tx,
          );
        }
        await this.invalidateUnstartedDays(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 },
    );
    return this.list();
  }

  async update(user: User, id: string, dto: PracticeCourseUpdateDto) {
    await this.prisma.$transaction(
      async (tx) => {
        const course = await tx.practiceCourse.findUnique({
          where: { id },
          include: courseInclude,
        });
        if (!course) throw new NotFoundException('课程不存在');
        if (course.revision !== dto.expectedRevision)
          throw new ConflictException('课程已更新，请刷新后重试');
        let topics;
        try {
          topics = parseCourseTopics(dto.topics ?? course.topics);
        } catch (error) {
          throw new BadRequestException(error instanceof Error ? error.message : '主题格式错误');
        }
        const examDate = dto.examDate ?? practiceDateFromDbDate(course.examDate);
        const startDate = practiceDateFromDbDate(course.startDate);
        if (
          !isPracticeDate(examDate) ||
          examDate < startDate ||
          topics.some(
            (topic) =>
              topicTaughtOn(topic) > examDate ||
              topicTaughtOn(topic) < startDate ||
              topic.sessionDates.some((date) => date < startDate),
          )
        ) {
          throw new BadRequestException('考试日期须晚于开课日期及所有主题的完成日期');
        }
        const changed = await tx.practiceCourse.updateMany({
          where: { id, revision: dto.expectedRevision },
          data: {
            examDate: practiceDateToDbDate(examDate),
            enabled: dto.enabled ?? course.enabled,
            topics: json(topics),
            topicHash: courseTopicHash(topics),
            revision: { increment: 1 },
          },
        });
        if (changed.count !== 1) throw new ConflictException('课程已更新，请刷新后重试');
        const updated = await tx.practiceCourse.findUniqueOrThrow({
          where: { id },
          include: courseInclude,
        });
        await tx.practiceCourseRevision.create({
          data: {
            courseId: id,
            revision: updated.revision,
            snapshot: json(snapshot(updated)),
            reason: dto.reason.trim(),
            publishedById: user.id,
          },
        });
        await this.invalidateUnstartedDays(tx);
        await this.audit.record(
          user.id,
          'daily-practice.curriculum.update',
          'PracticeCourse',
          id,
          { revision: updated.revision, reason: dto.reason.trim() },
          tx,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 },
    );
    return (await this.list()).courses.find((course) => course.id === id)!;
  }

  async history(id: string) {
    await this.requireCourse(id);
    const items = await this.prisma.practiceCourseRevision.findMany({
      where: { courseId: id },
      orderBy: { revision: 'desc' },
      take: 100,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        revision: item.revision,
        snapshot: item.snapshot,
        reason: item.reason,
        publishedById: item.publishedById,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

  async mappings(query: PracticeMappingQueryDto) {
    const conditions = [Prisma.sql`subject.slug IN (${Prisma.join([...PRACTICE_SUBJECT_SLUGS])})`];
    if (query.courseId) conditions.push(Prisma.sql`mapping.courseId = ${query.courseId}`);
    const stale = Prisma.sql`(mapping.topicHash <> course.topicHash OR mapping.contentRevision <> question.contentRevision)`;
    if (query.status === 'STALE') conditions.push(stale);
    else if (query.status)
      conditions.push(Prisma.sql`NOT ${stale} AND mapping.status = ${query.status}`);
    const from = Prisma.sql`FROM PracticeQuestionMapping AS mapping
      INNER JOIN PracticeCourse AS course ON course.id = mapping.courseId
      INNER JOIN QuizQuestion AS question ON question.id = mapping.questionId
      INNER JOIN KnowledgeSubject AS subject ON subject.id = course.subjectId
      WHERE ${Prisma.join(conditions, ' AND ')}`;
    const [counts, ids] = await Promise.all([
      this.prisma.$queryRaw<Array<{ total: bigint | number }>>(
        Prisma.sql`SELECT COUNT(*) AS total ${from}`,
      ),
      this.prisma.$queryRaw<
        Array<{ questionId: string }>
      >(Prisma.sql`SELECT mapping.questionId ${from}
        ORDER BY mapping.updatedAt DESC, mapping.questionId ASC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`),
    ]);
    const rows = await this.prisma.practiceQuestionMapping.findMany({
      where: { questionId: { in: ids.map((row) => row.questionId) } },
      include: {
        course: { select: { topicHash: true } },
        question: { select: { id: true, prompt: true, typeLabel: true, contentRevision: true } },
      },
      orderBy: [{ updatedAt: 'desc' }, { questionId: 'asc' }],
    });
    const values = rows.map((row) => ({
      questionId: row.questionId,
      courseId: row.courseId,
      question: row.question,
      status: row.status,
      reason: row.reason,
      confidence: row.confidence,
      manual: row.manual,
      revision: row.revision,
      contentRevision: row.contentRevision,
      topicIds: Array.isArray(row.topicIds)
        ? row.topicIds.filter((id): id is string => typeof id === 'string')
        : [],
      stale:
        row.topicHash !== row.course.topicHash ||
        row.contentRevision !== row.question.contentRevision,
      updatedAt: row.updatedAt.toISOString(),
    }));
    const byId = new Map(values.map((row) => [row.questionId, row]));
    return {
      items: ids.flatMap(({ questionId }) => (byId.has(questionId) ? [byId.get(questionId)!] : [])),
      total: Number(counts[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async updateMapping(user: User, questionId: string, dto: PracticeMappingUpdateDto) {
    await this.prisma.$transaction(
      async (tx) => {
        const mapping = await tx.practiceQuestionMapping.findUnique({
          where: { questionId },
          include: { course: true, question: true },
        });
        if (!mapping) throw new NotFoundException('题目匹配不存在');
        if (dto.expectedContentRevision !== undefined && dto.expectedContentRevision !== mapping.question.contentRevision) {
          throw new ConflictException('题目内容已更新，请重新打开完整题目后校正');
        }
        const topics = parseCourseTopics(mapping.course.topics);
        if (
          !dto.topicIds.length ||
          dto.topicIds.some((id) => !topics.some((topic) => topic.id === id)) ||
          mapping.question.subjectId !== mapping.course.subjectId
        ) {
          throw new BadRequestException('请选择本课程中的有效主题');
        }
        const changed = await tx.practiceQuestionMapping.updateMany({
          where: { questionId, revision: dto.expectedRevision },
          data: {
            topicIds: dto.topicIds,
            contentRevision: mapping.question.contentRevision,
            topicHash: mapping.course.topicHash,
            status: 'READY',
            manual: true,
            reason: dto.reason.trim(),
            confidence: null,
            revision: { increment: 1 },
            leaseOwnerToken: null,
            leasedUntil: null,
            lastError: null,
          },
        });
        if (!changed.count) throw new ConflictException('题目匹配已更新，请刷新后重试');
        await this.invalidateUnstartedDays(tx);
        await this.audit.record(
          user.id,
          'daily-practice.mapping.update',
          'QuizQuestion',
          questionId,
          { topicIds: dto.topicIds, reason: dto.reason.trim() },
          tx,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { questionId, updated: true };
  }

  async retryMapping(user: User, questionId: string, expectedRevision: number) {
    await this.prisma.$transaction(
      async (tx) => {
        const mapping = await tx.practiceQuestionMapping.findUnique({
          where: { questionId },
          include: { course: true, question: true },
        });
        if (!mapping) throw new NotFoundException('题目匹配不存在');
        const changed = await tx.practiceQuestionMapping.updateMany({
          where: { questionId, revision: expectedRevision },
          data: {
            status: 'PENDING',
            manual: false,
            attempts: 0,
            contentRevision: mapping.question.contentRevision,
            topicHash: mapping.course.topicHash,
            revision: { increment: 1 },
            leaseOwnerToken: null,
            leasedUntil: null,
            lastError: null,
          },
        });
        if (!changed.count) throw new ConflictException('题目匹配已更新，请刷新后重试');
        await this.invalidateUnstartedDays(tx);
        await this.audit.record(
          user.id,
          'daily-practice.mapping.retry',
          'QuizQuestion',
          questionId,
          undefined,
          tx,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { questionId, queued: true };
  }

  async queueMappings(user: User, courseId: string) {
    const course = await this.requireCourse(courseId);
    let cursor: string | undefined;
    let queued = 0;
    for (;;) {
      const questions = await this.prisma.quizQuestion.findMany({
        where: { ...practiceQuestionWhere(), subjectId: course.subjectId },
        select: { id: true, contentRevision: true, curriculumMapping: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const question of questions) {
        const mapping = question.curriculumMapping;
        if (!mapping) {
          const created = await this.prisma.practiceQuestionMapping.createMany({
            data: [
              {
                questionId: question.id,
                courseId,
                contentRevision: question.contentRevision,
                topicHash: course.topicHash,
                topicIds: [],
              },
            ],
            skipDuplicates: true,
          });
          queued += created.count;
        } else if (
          mapping.contentRevision !== question.contentRevision ||
          mapping.topicHash !== course.topicHash ||
          mapping.courseId !== courseId
        ) {
          const updated = await this.prisma.practiceQuestionMapping.updateMany({
            where: { questionId: question.id, revision: mapping.revision },
            data: {
              courseId,
              contentRevision: question.contentRevision,
              topicHash: course.topicHash,
              status: mapping.manual ? 'NEEDS_REVIEW' : 'PENDING',
              attempts: 0,
              revision: { increment: 1 },
              leasedUntil: null,
              leaseOwnerToken: null,
              reason: mapping.manual ? '题目或教学主题已变化，请复核人工匹配' : null,
            },
          });
          queued += updated.count;
        }
      }
      if (questions.length < 500) break;
      cursor = questions[questions.length - 1]!.id;
    }
    await this.audit.record(user.id, 'daily-practice.mapping.queue', 'PracticeCourse', courseId, {
      queued,
    });
    return { queued };
  }

  private async requireCourse(id: string) {
    const course = await this.prisma.practiceCourse.findUnique({
      where: { id },
      include: courseInclude,
    });
    if (!course) throw new NotFoundException('课程不存在');
    return course;
  }

  private async invalidateUnstartedDays(tx: Prisma.TransactionClient) {
    const practiceDate = practiceDateToDbDate(practiceDateForInstant(new Date()));
    await tx.dailyPracticeDay.updateMany({
      where: {
        practiceDate: { gte: practiceDate },
        startedAt: null,
        status: { notIn: ['STARTED', 'COMPLETED'] },
      },
      data: {
        status: 'STALE',
        lastErrorCategory: 'CURRICULUM_CHANGED',
        lastErrorMessage: '课程进度或题目主题已调整，请重新生成计划',
      },
    });
    await tx.dailyPracticeCycle.updateMany({
      where: { practiceDate, refreezeRequestedAt: null },
      data: { refreezeRequestedAt: new Date() },
    });
  }
}
