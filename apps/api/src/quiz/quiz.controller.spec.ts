import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AccountStatus, QuestionType, Role, User } from "@prisma/client";
import { REQUIRED_ROLES } from "../common/auth";
import { RoleGuard } from "../common/guards";
import { QuizController } from "./quiz.controller";

const user = {
  id: "editor-1",
  displayName: "测试编辑",
  studentNumberHash: "hash",
  studentNumberEncrypted: "encrypted",
  passwordHash: "password-hash",
  role: Role.EDITOR,
  status: AccountStatus.ACTIVE,
  createdAt: new Date(),
  updatedAt: new Date(),
  approvedAt: new Date(),
} satisfies User;

function file(buffer: Buffer, mimetype: string, originalname: string) {
  return {
    buffer,
    mimetype,
    originalname,
    fieldname: "file",
    encoding: "7bit",
    size: buffer.length,
    stream: undefined,
    destination: "",
    filename: "",
    path: "",
  } as unknown as Express.Multer.File;
}

describe('QuizController question editor', () => {
  it('returns the grading type and short-answer scoring data for the editor', async () => {
    const question = {
      id: 'question-short-answer',
      type: QuestionType.SHORT_ANSWER,
      subjectId: 'subject-1',
      subject: { name: '医学分子细胞遗传' },
      chapters: [{ chapter: { id: 'chapter-1', name: '蛋白质' } }],
      pastPaper: null,
      correctAnswer: ['水化膜和同种电荷'],
      gradingRubric: { maxScore: 2, criteria: [{ description: '水化膜', points: 1 }, { description: '同种电荷', points: 1 }] },
    };
    const quizzes = { getQuestionForEdit: jest.fn().mockResolvedValue(question) };
    const controller = new QuizController(quizzes as never, {} as never, {} as never, {} as never);

    await expect(controller.questionForEdit(question.id)).resolves.toMatchObject({
      type: QuestionType.SHORT_ANSWER,
      gradingType: QuestionType.SHORT_ANSWER,
      correctAnswer: question.correctAnswer,
      gradingRubric: question.gradingRubric,
      subject: '医学分子细胞遗传',
      chapterIds: ['chapter-1'],
    });
    expect(quizzes.getQuestionForEdit).toHaveBeenCalledWith(question.id);
  });
});

describe("QuizController question images", () => {
  it("compresses and associates an uploaded image with a question", async () => {
    const quizzes = {};
    const prisma = {
      quizQuestion: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "question-1" }),
      },
      quizQuestionPhoto: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const transaction = {
      quizQuestion: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "question-1" }),
        update: jest.fn().mockResolvedValue({ id: "question-1", contentRevision: 2 }),
      },
      quizQuestionPhoto: prisma.quizQuestionPhoto,
    };
    const media = {
      createImage: jest.fn(
        async (
          _file: Express.Multer.File,
          _userId: string,
          _options: unknown,
          hook: (client: typeof transaction, photo: { id: string }) => Promise<void>,
        ) => {
          await hook(transaction, { id: "photo-1" });
          return {
            id: "photo-1",
            caption: "题目示意图",
            url: "/api/v1/media/images/photo-1/content",
          };
        },
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new QuizController(
      quizzes as never,
      prisma as never,
      media as never,
      audit as never,
    );
    const upload = file(Buffer.from("image"), "image/png", "question.png");

    const result = await controller.uploadQuestionImage(
      "question-1",
      upload,
      { caption: "题目示意图", sortOrder: 2 },
      user,
    );

    expect(media.createImage).toHaveBeenCalledWith(
      upload,
      user.id,
      { caption: "题目示意图" },
      expect.any(Function),
    );
    expect(prisma.quizQuestionPhoto.create).toHaveBeenCalledWith({
      data: {
        questionId: "question-1",
        photoId: "photo-1",
        sortOrder: 2,
      },
    });
    expect(result).toMatchObject({ id: "photo-1" });
    expect(transaction.quizQuestion.update).toHaveBeenCalledWith({
      where: { id: 'question-1' },
      data: { contentRevision: { increment: 1 } },
    });
  });
});

describe("QuizController question soft deletion", () => {
  it("allows editor/admin and rejects members at the authorization boundary", () => {
    expect(
      Reflect.getMetadata(
        REQUIRED_ROLES,
        QuizController.prototype.disableQuestion,
      ),
    ).toEqual([Role.EDITOR, Role.ADMIN]);

    const guard = new RoleGuard(new Reflector());
    const context = (role: Role) =>
      ({
        getHandler: () => QuizController.prototype.disableQuestion,
        getClass: () => QuizController,
        switchToHttp: () => ({
          getRequest: () => ({ user: { ...user, role } }),
        }),
      }) as unknown as ExecutionContext;
    expect(guard.canActivate(context(Role.EDITOR))).toBe(true);
    expect(guard.canActivate(context(Role.ADMIN))).toBe(true);
    expect(() => guard.canActivate(context(Role.MEMBER))).toThrow(
      ForbiddenException,
    );
  });

  it("records one precise audit event when an enabled question is disabled", async () => {
    const quizzes = {
      disableQuestion: jest.fn(
        async (
          id: string,
          hook: (transaction: unknown) => Promise<void>,
        ) => {
          await hook({ auditLog: {} });
          return { id, deleted: true, changed: true };
        },
      ),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new QuizController(
      quizzes as never,
      {} as never,
      {} as never,
      audit as never,
    );

    await expect(
      controller.disableQuestion("question-1", user),
    ).resolves.toEqual({ id: "question-1", deleted: true });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      user.id,
      "quiz.question.disable",
      "QuizQuestion",
      "question-1",
      undefined,
      expect.any(Object),
    );
  });

  it("does not write another audit event for an already disabled question", async () => {
    const quizzes = {
      disableQuestion: jest.fn().mockResolvedValue({
        id: "question-1",
        deleted: true,
        changed: false,
      }),
    };
    const audit = { record: jest.fn() };
    const controller = new QuizController(
      quizzes as never,
      {} as never,
      {} as never,
      audit as never,
    );

    await controller.disableQuestion("question-1", user);
    expect(quizzes.disableQuestion).toHaveBeenCalledWith(
      "question-1",
      expect.any(Function),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("QuizController history and wrong-question queries", () => {
  it("paginates history at the database level", async () => {
    const prisma = {
      quizAttempt: {
        findMany: jest.fn().mockResolvedValue([{ id: "attempt-11" }]),
        count: jest.fn().mockResolvedValue(25),
      },
    };
    const controller = new QuizController(
      {} as never,
      prisma as never,
      {} as never,
      {} as never,
    );

    const result = await controller.history(user, { page: 2, pageSize: 10 });

    expect(prisma.quizAttempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
    expect(result).toMatchObject({ total: 25, page: 2, pageSize: 10 });
    expect(result.items).toHaveLength(1);
  });

  it("delegates filtered wrong-question pagination to the materialized index", async () => {
    const quizzes = {
      wrongQuestions: jest.fn().mockResolvedValue({
        items: [{ id: "q1", wrongCount: 3 }],
        total: 1,
        page: 2,
        pageSize: 10,
      }),
    };
    const controller = new QuizController(
      quizzes as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const query = {
      page: 2,
      pageSize: 10,
      subjectId: "subject-1",
      chapterIds: ["chapter-1", "chapter-2"],
      chapterMatch: "ALL" as const,
      source: "NON_AI" as const,
    };
    const result = await controller.wrongQuestions(user, query);

    expect(quizzes.wrongQuestions).toHaveBeenCalledWith(user.id, query);
    expect(result).toMatchObject({ total: 1, page: 2, pageSize: 10 });
  });
});
