import {
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { compressImage, MAX_INPUT_PIXELS } from "./image-processing";
import { MediaService } from "./media.service";
import { ImageProcessingService } from "./image-processing.service";

jest.mock("./image-processing", () => ({
  compressImage: jest.fn(),
  MAX_INPUT_PIXELS: 32_000_000,
}));

const mockedCompressImage = jest.mocked(compressImage);
const recovery = {
  planDeletion: jest.fn().mockResolvedValue('cleanup-1'),
  recover: jest.fn().mockResolvedValue(true),
  protectedKeys: jest.fn().mockResolvedValue([]),
  originalReport: jest.fn().mockResolvedValue({ pendingObjects: [] }),
};
const compressed = {
  data: Buffer.from([1, 2, 3]),
  mimeType: "image/webp" as const,
  size: 3,
  width: 10,
  height: 8,
};

function uploadFile(buffer = Buffer.from("image")) {
  return {
    buffer,
    mimetype: "image/png",
    size: buffer.length,
    originalname: "private-name.png",
  } as Express.Multer.File;
}

function storedPhoto() {
  return {
    id: "photo-1",
    albumId: null,
    caption: "",
    mimeType: "image/webp",
    size: 3,
    width: 10,
    height: 8,
    createdAt: new Date("2026-07-21T00:00:00Z"),
  };
}

describe("MediaService.createImage", () => {
  beforeEach(() => {
    mockedCompressImage.mockReset().mockResolvedValue(compressed);
    delete process.env.MEDIA_MAX_PROCESSING_CONCURRENCY;
  });

  it("stores compressed bytes in the database only in database mode", async () => {
    const prisma = {
      photo: { create: jest.fn().mockResolvedValue(storedPhoto()) },
    };
    const storage = {
      usesCos: jest.fn().mockReturnValue(false),
      upload: jest.fn(),
    };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await service.createImage(uploadFile(), "user-1");

    expect(storage.upload).not.toHaveBeenCalled();
    expect(prisma.photo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          objectKey: null,
          data: Uint8Array.from(compressed.data),
        }),
      }),
    );
  });

  it("uploads to COS and stores metadata without a database BLOB", async () => {
    const prisma = {
      photo: { create: jest.fn().mockResolvedValue(storedPhoto()) },
    };
    const storage = {
      usesCos: jest.fn().mockReturnValue(true),
      upload: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn(),
    };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await service.createImage(uploadFile(), "user-1");

    const createData = prisma.photo.create.mock.calls[0]![0].data;
    expect(createData.objectKey).toMatch(
      /^media\/\d{4}\/\d{2}\/[0-9a-f-]+\.webp$/,
    );
    expect(createData.data).toBeNull();
    expect(storage.upload).toHaveBeenCalledWith(
      compressed.data,
      createData.objectKey,
      "image/webp",
    );
  });

  it("rolls back image metadata and compensates COS when the create hook fails", async () => {
    const hookError = new Error("audit unavailable");
    const transaction = {
      photo: { create: jest.fn().mockResolvedValue(storedPhoto()) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback) => callback(transaction)),
    };
    const storage = {
      usesCos: jest.fn().mockReturnValue(true),
      upload: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);
    const afterCreate = jest.fn().mockRejectedValue(hookError);

    await expect(
      service.createImage(uploadFile(), "user-1", {}, afterCreate),
    ).rejects.toBe(hookError);
    expect(afterCreate).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ id: "photo-1" }),
    );
    expect(storage.delete).toHaveBeenCalledWith(
      storage.upload.mock.calls[0]![1],
    );
  });

  it("does not create a Photo when the COS upload fails", async () => {
    const prisma = { photo: { create: jest.fn() } };
    const storage = {
      usesCos: jest.fn().mockReturnValue(true),
      upload: jest.fn().mockRejectedValue(new ServiceUnavailableException()),
    };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await expect(
      service.createImage(uploadFile(), "user-1"),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.photo.create).not.toHaveBeenCalled();
  });

  it("enforces the upload size and MIME limits before processing", async () => {
    const prisma = { photo: { create: jest.fn() } };
    const storage = { usesCos: jest.fn().mockReturnValue(false) };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);
    const oversized = uploadFile(Buffer.alloc(10 * 1024 * 1024 + 1));
    const unsupported = { ...uploadFile(), mimetype: "image/gif" };

    await expect(service.createImage(oversized, "user-1")).rejects.toThrow(
      "仅支持 10MB 以内",
    );
    await expect(service.createImage(unsupported, "user-1")).rejects.toThrow(
      "仅支持 10MB 以内",
    );
    expect(mockedCompressImage).not.toHaveBeenCalled();
  });

  it("reports the pixel limit separately from invalid image data", async () => {
    mockedCompressImage.mockRejectedValueOnce(
      new Error("Input image exceeds pixel limit"),
    );
    const logger = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const prisma = { photo: { create: jest.fn() } };
    const storage = { usesCos: jest.fn().mockReturnValue(false) };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await expect(service.createImage(uploadFile(), "user-1")).rejects.toThrow(
      `图片像素超过 ${MAX_INPUT_PIXELS / 10_000} 万限制，请缩小后重试`,
    );
    expect(prisma.photo.create).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(
      JSON.stringify({
        event: "media.image-processing-failed",
        category: "pixel-limit",
        message: "Input image exceeds the configured pixel limit",
      }),
    );
    logger.mockRestore();
  });

  it("logs processing failures without exposing the upload name or input", async () => {
    mockedCompressImage.mockRejectedValueOnce(
      new Error("private-name.png contains secret image bytes"),
    );
    const logger = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    const prisma = { photo: { create: jest.fn() } };
    const storage = { usesCos: jest.fn().mockReturnValue(false) };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await expect(service.createImage(uploadFile(), "user-1")).rejects.toThrow(
      "图片无法读取或压缩，请更换图片后重试",
    );
    const logEntry = String(logger.mock.calls[0]?.[0]);
    expect(logEntry).toContain("media.image-processing-failed");
    expect(logEntry).toContain("processing-error");
    expect(logEntry).not.toContain("private-name.png");
    expect(logEntry).not.toContain("secret image bytes");
    expect(prisma.photo.create).not.toHaveBeenCalled();
    logger.mockRestore();
  });

  it("deletes the uploaded COS object when the database create fails", async () => {
    const databaseError = new Error("database unavailable");
    const prisma = {
      photo: { create: jest.fn().mockRejectedValue(databaseError) },
    };
    const storage = {
      usesCos: jest.fn().mockReturnValue(true),
      upload: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await expect(service.createImage(uploadFile(), "user-1")).rejects.toBe(
      databaseError,
    );
    const objectKey = storage.upload.mock.calls[0]![1];
    expect(storage.delete).toHaveBeenCalledWith(objectKey);
  });

  it("logs a structured orphan event when compensation also fails", async () => {
    const logger = jest.spyOn(Logger.prototype, "error").mockImplementation();
    const prisma = {
      photo: { create: jest.fn().mockRejectedValue(new Error("database")) },
    };
    const storage = {
      usesCos: jest.fn().mockReturnValue(true),
      upload: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockRejectedValue(new Error("cos")),
    };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await expect(service.createImage(uploadFile(), "user-1")).rejects.toThrow(
      "database",
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("media.orphan-object"),
      expect.anything(),
    );
    logger.mockRestore();
  });

  it("rejects excess concurrent image processing with a retryable error", async () => {
    process.env.MEDIA_MAX_PROCESSING_CONCURRENCY = "1";
    let finishFirst!: (value: typeof compressed) => void;
    mockedCompressImage.mockImplementationOnce(
      () => new Promise((resolve) => (finishFirst = resolve)),
    );
    const prisma = {
      photo: { create: jest.fn().mockResolvedValue(storedPhoto()) },
    };
    const storage = { usesCos: jest.fn().mockReturnValue(false) };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    const first = service.createImage(uploadFile(), "user-1");
    await Promise.resolve();
    await expect(service.createImage(uploadFile(), "user-1")).rejects.toThrow(
      "图片处理繁忙，请稍后重试",
    );
    finishFirst(compressed);
    await expect(first).resolves.toEqual(
      expect.objectContaining({ id: "photo-1" }),
    );
  });
});

describe("MediaService.sendContent", () => {
  function contentPhoto(overrides: Record<string, unknown> = {}) {
    return {
      data: Uint8Array.from([1, 2, 3]),
      objectKey: null,
      mimeType: "image/webp",
      size: 3,
      uploadedById: "uploader-1",
      album: null,
      news: [],
      quizQuestions: [],
      knowledgeImages: [],
      ...overrides,
    };
  }

  it('keeps a retired quiz image private to the owner of a frozen snapshot', async () => {
    const prisma = {
      photo: {
        findUnique: jest.fn().mockResolvedValue(contentPhoto({
          quizQuestions: [{ question: {
            enabled: false,
            origin: 'AI_GENERATED',
            reviewStatus: 'APPROVED',
            subject: { active: true },
            chapters: [{ chapter: { active: true } }],
          } }],
        })),
      },
      $queryRaw: jest.fn(async (query: { values: unknown[] }) =>
        query.values.includes('owner-1') ? [{ allowed: 1 }] : [],
      ),
    };
    const service = new MediaService(prisma as never, {} as never, new ImageProcessingService(), recovery as never);
    const response = { setHeader: jest.fn(), type: jest.fn(), send: jest.fn() };
    await service.sendContent('photo-1', { id: 'owner-1', role: 'MEMBER' } as never, response as never);
    expect(response.send).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(prisma.$queryRaw.mock.calls[0]![0].values).toEqual([
      'owner-1', JSON.stringify('photo-1'), JSON.stringify('photo-1'),
      'owner-1', JSON.stringify('photo-1'),
    ]);
    await expect(service.sendContent('photo-1', { id: 'other-1', role: 'MEMBER' } as never, response as never)).rejects.toThrow(NotFoundException);
  });

  it("does not expose a private image to an anonymous request", async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      photo: {
        findUnique: jest.fn().mockResolvedValue(contentPhoto()),
      },
    };
    const service = new MediaService(prisma as never, {} as never, new ImageProcessingService(), recovery as never);

    await expect(
      service.sendContent("photo-1", undefined, {} as never),
    ).rejects.toThrow(NotFoundException);
  });

  it("serves a legacy database image used by a public published article", async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      photo: {
        findUnique: jest.fn().mockResolvedValue(
          contentPhoto({
            news: [
              {
                news: {
                  status: "PUBLISHED",
                  visibility: "PUBLIC",
                  deletedAt: null,
                },
              },
            ],
          }),
        ),
      },
    };
    const response = {
      setHeader: jest.fn(),
      type: jest.fn(),
      send: jest.fn(),
    };
    const service = new MediaService(prisma as never, {} as never, new ImageProcessingService(), recovery as never);

    await service.sendContent("photo-1", undefined, response as never);

    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=300",
    );
    expect(response.type).toHaveBeenCalledWith("image/webp");
    expect(response.send).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
  });

  it("redirects an authenticated COS image without caching the signed URL", async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      photo: {
        findUnique: jest.fn().mockResolvedValue(contentPhoto({
          data: null,
          objectKey: "media/2026/07/photo.webp",
          uploadedById: "member-1",
        })),
      },
    };
    const storage = {
      signedReadUrl: jest
        .fn()
        .mockResolvedValue("https://media.example.test/signed"),
    };
    const response = {
      setHeader: jest.fn(),
      redirect: jest.fn(),
    };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await service.sendContent(
      "photo-1",
      { id: "member-1", role: "MEMBER" } as never,
      response as never,
    );

    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "private, no-store",
    );
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      "https://media.example.test/signed",
    );
  });

  it("uses only a short public cache for a published COS image redirect", async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      photo: {
        findUnique: jest.fn().mockResolvedValue(contentPhoto({
          data: null,
          objectKey: "media/2026/07/photo.webp",
          news: [
            {
              news: {
                status: "PUBLISHED",
                visibility: "PUBLIC",
                deletedAt: null,
              },
            },
          ],
        })),
      },
    };
    const storage = {
      signedReadUrl: jest.fn().mockResolvedValue("https://signed.test"),
    };
    const response = {
      setHeader: jest.fn(),
      redirect: jest.fn(),
    };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await service.sendContent("photo-1", undefined, response as never);

    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=60",
    );
  });

  it("does not let an administrator read a private knowledge image", async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      photo: {
        findUnique: jest.fn().mockResolvedValue(contentPhoto({
          knowledgeImages: [
            {
              documentVersionId: "version-1",
              documentVersion: {
                document: {
                  status: "PUBLISHED",
                  activeVersionId: "version-1",
                  deletedAt: null,
                  library: {
                    scope: "PRIVATE",
                    ownerId: "owner-1",
                    active: true,
                    deletedAt: null,
                  },
                },
              },
            },
          ],
        })),
      },
    };
    const service = new MediaService(prisma as never, {} as never, new ImageProcessingService(), recovery as never);

    await expect(
      service.sendContent(
        "photo-1",
        { id: "admin-1", role: "ADMIN" } as never,
        {} as never,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it.each([
    [
      "a published members-only news relation",
      {
        news: [
          {
            news: {
              status: "PUBLISHED",
              visibility: "MEMBERS",
              deletedAt: null,
            },
          },
        ],
      },
      { id: "member-1", role: "MEMBER" },
    ],
    [
      "an active album relation",
      { album: { deletedAt: null } },
      { id: "member-1", role: "MEMBER" },
    ],
    [
      "an editor preview of an archived album relation",
      { album: { archivedAt: new Date(), deletedAt: null } },
      { id: "editor-1", role: "EDITOR" },
    ],
    [
      "an approved answerable question relation",
      {
        quizQuestions: [
          {
            question: {
              enabled: true,
              origin: "MANUAL",
              reviewStatus: "APPROVED",
              sourceReviewStatus: "VALID",
              subject: { active: true },
              chapters: [{ chapter: { active: true } }],
            },
          },
        ],
      },
      { id: "member-1", role: "MEMBER" },
    ],
    [
      "the active version of a shared published knowledge document",
      {
        knowledgeImages: [
          {
            documentVersionId: "version-1",
            documentVersion: {
              document: {
                status: "PUBLISHED",
                activeVersionId: "version-1",
                deletedAt: null,
                library: {
                  scope: "SHARED",
                  ownerId: null,
                  active: true,
                  deletedAt: null,
                },
              },
            },
          },
        ],
      },
      { id: "member-1", role: "MEMBER" },
    ],
    [
      "a private knowledge relation owned by the requester",
      {
        knowledgeImages: [
          {
            documentVersionId: "version-1",
            documentVersion: {
              document: {
                status: "DRAFT",
                activeVersionId: null,
                deletedAt: null,
                library: {
                  scope: "PRIVATE",
                  ownerId: "member-1",
                  active: true,
                  deletedAt: null,
                },
              },
            },
          },
        ],
      },
      { id: "member-1", role: "MEMBER" },
    ],
    [
      "an editor preview of an unpublished news relation",
      {
        news: [
          {
            news: {
              status: "DRAFT",
              visibility: "MEMBERS",
              deletedAt: null,
            },
          },
        ],
      },
      { id: "editor-1", role: "EDITOR" },
    ],
  ])("allows %s", async (_name, overrides, user) => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      photo: {
        findUnique: jest.fn().mockResolvedValue(contentPhoto(overrides)),
      },
    };
    const response = {
      setHeader: jest.fn(),
      type: jest.fn(),
      send: jest.fn(),
    };
    const service = new MediaService(prisma as never, {} as never, new ImageProcessingService(), recovery as never);

    await expect(
      service.sendContent("photo-1", user as never, response as never),
    ).resolves.toBeUndefined();
    expect(response.send).toHaveBeenCalled();
  });

  it.each([
    [
      "an unpublished members-only news relation",
      {
        news: [
          {
            news: {
              status: "DRAFT",
              visibility: "MEMBERS",
              deletedAt: null,
            },
          },
        ],
      },
      { id: "member-1", role: "MEMBER" },
    ],
    [
      "a deleted album relation",
      { album: { deletedAt: new Date() } },
      { id: "member-1", role: "MEMBER" },
    ],
    [
      "an archived album relation for an ordinary member",
      { album: { archivedAt: new Date(), deletedAt: null } },
      { id: "member-1", role: "MEMBER" },
    ],
    [
      "an AI question whose source review is no longer valid",
      {
        quizQuestions: [
          {
            question: {
              enabled: true,
              origin: "AI_GENERATED",
              reviewStatus: "APPROVED",
              sourceReviewStatus: "REVIEW_REQUIRED",
              subject: { active: true },
              chapters: [{ chapter: { active: true } }],
            },
          },
        ],
      },
      { id: "member-1", role: "MEMBER" },
    ],
    [
      "a stale shared knowledge version",
      {
        knowledgeImages: [
          {
            documentVersionId: "version-old",
            documentVersion: {
              document: {
                status: "PUBLISHED",
                activeVersionId: "version-new",
                deletedAt: null,
                library: {
                  scope: "SHARED",
                  ownerId: null,
                  active: true,
                  deletedAt: null,
                },
              },
            },
          },
        ],
      },
      { id: "member-1", role: "MEMBER" },
    ],
    [
      "another member's private knowledge relation",
      {
        knowledgeImages: [
          {
            documentVersionId: "version-1",
            documentVersion: {
              document: {
                status: "PUBLISHED",
                activeVersionId: "version-1",
                deletedAt: null,
                library: {
                  scope: "PRIVATE",
                  ownerId: "owner-1",
                  active: true,
                  deletedAt: null,
                },
              },
            },
          },
        ],
      },
      { id: "member-1", role: "MEMBER" },
    ],
  ])("denies %s", async (_name, overrides, user) => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      photo: {
        findUnique: jest.fn().mockResolvedValue(contentPhoto(overrides)),
      },
    };
    const service = new MediaService(prisma as never, {} as never, new ImageProcessingService(), recovery as never);

    await expect(
      service.sendContent("photo-1", user as never, {} as never),
    ).rejects.toThrow(NotFoundException);
  });
});

describe("MediaService.orphanReport", () => {
  it("returns a read-only aggregate without deleting records", async () => {
    const photo = {
      findMany: jest
        .fn()
        .mockReturnValueOnce("find-query")
        .mockReturnValueOnce("stored-query"),
      aggregate: jest.fn().mockReturnValue("aggregate-query"),
      deleteMany: jest.fn(),
    };
    const prisma = {
      photo,
      quizImportAsset: { findMany: jest.fn().mockReturnValue("asset-query") },
      knowledgeImportAsset: {
        findMany: jest.fn().mockReturnValue("knowledge-asset-query"),
      },
      $transaction: jest
        .fn()
        .mockResolvedValue([
          [{ id: "photo-1", size: 3 }],
          { _count: { _all: 1 }, _sum: { size: 3 } },
          [],
          [],
          [],
        ]),
    };
    const storage = { usesCos: jest.fn().mockReturnValue(false) };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await expect(service.orphanReport()).resolves.toEqual(
      expect.objectContaining({
        total: 1,
        totalBytes: 3,
        cosComparison: null,
      }),
    );
    expect(photo.deleteMany).not.toHaveBeenCalled();
  });
});

describe("MediaService.removeFromAlbum", () => {
  beforeEach(() => {
    recovery.planDeletion.mockClear();
    recovery.recover.mockReset().mockResolvedValue(true);
  });
  it("keeps a photo used by news or quiz and only clears its album", async () => {
    const transaction = {
      $queryRaw: jest.fn(),
      photo: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({
          id: "photo-1",
          objectKey: "media/2026/07/photo.webp",
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      ...transaction,
      $transaction: jest.fn(
        async (action: (client: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const storage = { delete: jest.fn() };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await expect(
      service.removeFromAlbum("album-1", "photo-1"),
    ).resolves.toEqual({
      id: "photo-1",
      removed: true,
      photoDeleted: false,
      objectDeleted: null,
    });
    expect(prisma.photo.updateMany).toHaveBeenCalledWith({
      where: { id: "photo-1", albumId: "album-1" },
      data: { albumId: null },
    });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it("deletes an unreferenced photo and its COS object", async () => {
    const transaction = {
      $queryRaw: jest.fn(),
      photoOriginal: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
      photo: {
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn().mockResolvedValue({
          id: "photo-1",
          objectKey: "media/2026/07/photo.webp",
          original: { objectKey: 'album-originals/2026/07/photo.png' },
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        updateMany: jest.fn(),
      },
    };
    const prisma = {
      ...transaction,
      $transaction: jest.fn(
        async (action: (client: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const storage = { delete: jest.fn().mockResolvedValue(undefined) };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await expect(
      service.removeFromAlbum("album-1", "photo-1"),
    ).resolves.toEqual({
      id: "photo-1",
      removed: true,
      photoDeleted: true,
      objectDeleted: true,
      cleanupOperationId: 'cleanup-1',
      cleanupPending: false,
    });
    expect(prisma.photo.deleteMany).toHaveBeenCalledWith({
      where: {
        id: "photo-1",
        albumId: "album-1",
        news: { none: {} },
        quizQuestions: { none: {} },
        knowledgeImages: { none: {} },
        knowledgeImportAssets: { none: {} },
      },
    });
    expect(recovery.planDeletion).toHaveBeenCalledWith(transaction, 'photo-1', [
      'media/2026/07/photo.webp', 'album-originals/2026/07/photo.png',
    ]);
    expect(transaction.photoOriginal.deleteMany).toHaveBeenCalledWith({ where: { photoId: 'photo-1' } });
    expect(recovery.recover).toHaveBeenCalledWith('cleanup-1', true);
  });

  it("returns a resumable partial cleanup when object recovery fails", async () => {
    recovery.recover.mockResolvedValue(false);
    const transaction = {
      $queryRaw: jest.fn(),
      photoOriginal: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      photo: {
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn().mockResolvedValue({
          id: "photo-1",
          objectKey: "media/2026/07/photo.webp",
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      ...transaction,
      $transaction: jest.fn(
        async (action: (client: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const storage = { delete: jest.fn().mockRejectedValue(new Error("COS")) };
    const service = new MediaService(prisma as never, storage as never, new ImageProcessingService(), recovery as never);

    await expect(
      service.removeFromAlbum("album-1", "photo-1"),
    ).resolves.toEqual(expect.objectContaining({ objectDeleted: false, cleanupPending: true, cleanupOperationId: 'cleanup-1' }));
  });

  it("rejects a photo that is not in the selected album", async () => {
    const transaction = {
      photo: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const prisma = {
      ...transaction,
      $transaction: jest.fn(
        async (action: (client: typeof transaction) => unknown) =>
          action(transaction),
      ),
    };
    const service = new MediaService(prisma as never, {} as never, new ImageProcessingService(), recovery as never);

    await expect(service.removeFromAlbum("album-1", "photo-1")).rejects.toThrow(
      "相册中的图片不存在",
    );
  });
});
