import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  ContentStatus,
  KnowledgeLibraryScope,
  Prisma,
  QuizQuestionOrigin,
  QuizQuestionReviewStatus,
  Role,
  Visibility,
  type User,
} from "@prisma/client";
import { createMediaObjectKey, inspectImage } from "@bmc3/media-core";
import { createHash, randomUUID } from 'node:crypto';
import { Response } from "express";
import { PrismaService } from "../database/prisma.service";
import { ImageProcessingService } from "./image-processing.service";
import { MediaStorageService } from "./media-storage.service";
import { MediaObjectRecoveryService } from './media-object-recovery.service';

const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface CreateImageOptions {
  albumId?: string;
  caption?: string;
}

type ImageCreateHook = (
  transaction: Prisma.TransactionClient,
  photo: { id: string },
) => Promise<void>;

type ImageRemoveHook = (
  transaction: Prisma.TransactionClient,
  result: { photoDeleted: boolean; objectKey: string | null },
) => Promise<void>;

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorageService,
    private readonly imageProcessing: ImageProcessingService,
    private readonly recovery: MediaObjectRecoveryService,
  ) {}

  async createImage(
    file: Express.Multer.File,
    uploadedById: string,
    options: CreateImageOptions = {},
    afterCreate?: ImageCreateHook,
  ) {
    if (
      !file?.buffer ||
      file.buffer.length > MAX_UPLOAD_BYTES ||
      !SUPPORTED_IMAGE_TYPES.includes(file.mimetype)
    ) {
      throw new BadRequestException(
        "仅支持 10MB 以内的 JPEG、PNG 或 WebP 图片",
      );
    }
    if ((options.caption?.length ?? 0) > 300)
      throw new BadRequestException("图片说明不能超过 300 字");
    if (options.albumId) {
      await this.prisma.album.findFirstOrThrow({
        where: { id: options.albumId, deletedAt: null },
      });
    }

    const compressed = await this.imageProcessing.compress(file.buffer);
    const objectKey = this.storage.usesCos()
      ? createMediaObjectKey(new Date())
      : null;
    if (objectKey) {
      await this.storage.upload(
        compressed.data,
        objectKey,
        compressed.mimeType,
      );
    }

    const createPhoto = (client: Pick<Prisma.TransactionClient, "photo">) =>
      client.photo.create({
        data: {
          albumId: options.albumId,
          uploadedById,
          objectKey,
          data: objectKey ? null : Uint8Array.from(compressed.data),
          caption: options.caption?.trim() ?? "",
          mimeType: compressed.mimeType,
          size: compressed.size,
          width: compressed.width,
          height: compressed.height,
        },
        select: {
          id: true,
          albumId: true,
          caption: true,
          mimeType: true,
          size: true,
          width: true,
          height: true,
          sortOrder: true,
          createdAt: true,
        },
      });
    try {
      const photo = afterCreate || options.albumId
        ? await this.prisma.$transaction(async (transaction) => {
            if (options.albumId) {
              await transaction.album.findFirstOrThrow({
                where: { id: options.albumId, deletedAt: null },
                select: { id: true },
              });
            }
            const created = await createPhoto(transaction);
            await afterCreate?.(transaction, created);
            return created;
          })
        : await createPhoto(this.prisma);
      return this.serializePhoto(photo);
    } catch (error) {
      if (objectKey) await this.compensateFailedCreate(objectKey);
      throw error;
    }
  }

  async createAlbumImage(
    file: Express.Multer.File,
    uploadedById: string,
    options: CreateImageOptions,
    idempotencyKey: string,
    afterCreate?: ImageCreateHook,
  ) {
    if (!options.albumId || !idempotencyKey?.trim() || idempotencyKey.length > 191) throw new BadRequestException('相册和 Idempotency-Key 必须有效');
    if (!file?.buffer || file.buffer.length > MAX_UPLOAD_BYTES || !SUPPORTED_IMAGE_TYPES.includes(file.mimetype)) throw new BadRequestException('仅支持 10MB 以内的 JPEG、PNG 或 WebP 图片');
    if (typeof options.caption !== 'undefined' && typeof options.caption !== 'string') throw new BadRequestException('图片说明格式无效');
    const caption = options.caption?.trim() ?? '';
    if (caption.length > 300) throw new BadRequestException('图片说明不能超过 300 字');
    const originalSha256 = createHash('sha256').update(file.buffer).digest('hex');
    const requestHash = createHash('sha256').update(JSON.stringify({ albumId: options.albumId, caption, originalSha256 })).digest('hex');
    const existing = await this.recovery.existingUpload(uploadedById, options.albumId, idempotencyKey, requestHash);
    if (existing?.status === 'COMMITTED') {
      const photo = await this.prisma.photo.findFirst({ where: { id: existing.photoId!, albumId: options.albumId, album: { deletedAt: null } }, select: albumPhotoSelect });
      if (!photo) throw new GoneException('该上传对应的照片已移除');
      return this.serializePhoto(photo);
    }
    await this.prisma.album.findFirstOrThrow({ where: { id: options.albumId, deletedAt: null, archivedAt: null }, select: { id: true } });
    const display = await this.imageProcessing.compress(file.buffer);
    const metadata = await inspectImage(file.buffer);
    const photoId = randomUUID();
    const now = new Date();
    const displayKey = this.storage.usesCos() ? createMediaObjectKey(now) : null;
    const originalKey = this.storage.usesCos() ? `album-originals/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${metadata.format}` : null;
    const lease = await this.recovery.beginUpload({ actorId: uploadedById, albumId: options.albumId, idempotencyKey, requestHash, photoId, keys: [displayKey, originalKey].filter((key): key is string => key !== null) }, existing?.id);
    try {
      if (displayKey && originalKey) {
        await this.recovery.renew(lease);
        await this.storage.upload(file.buffer, originalKey, metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`);
        await this.recovery.renew(lease);
        await this.storage.upload(display.data, displayKey, display.mimeType);
        await this.recovery.renew(lease);
      }
      const photo = await this.prisma.$transaction(async (transaction) => {
        await this.recovery.commit(transaction, lease);
        await transaction.$queryRaw(Prisma.sql`SELECT id FROM Album WHERE id = ${options.albumId!} FOR UPDATE`);
        const album = await transaction.album.findFirst({ where: { id: options.albumId, deletedAt: null, archivedAt: null }, select: { id: true } });
        if (!album) throw new ConflictException('相册已归档或删除');
        const created = await transaction.photo.create({
          data: {
            id: photoId, albumId: options.albumId, uploadedById, caption,
            objectKey: displayKey, data: displayKey ? null : Uint8Array.from(display.data),
            mimeType: display.mimeType, size: display.size, width: display.width, height: display.height,
            original: { create: {
              objectKey: originalKey, data: originalKey ? null : Uint8Array.from(file.buffer),
              mimeType: metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`,
              size: file.buffer.length, width: metadata.width, height: metadata.height, sha256: originalSha256,
            } },
          },
          select: albumPhotoSelect,
        });
        await afterCreate?.(transaction, created);
        return created;
      });
      return this.serializePhoto(photo);
    } catch (error) {
      await this.recovery.compensate(lease);
      throw error;
    }
  }

  serializePhoto<T extends { id: string }>(photo: T) {
    const { original, ...item } = photo as T & { original?: unknown };
    return { ...item, originalAvailable: Boolean(original), url: `/api/v1/media/images/${photo.id}/content` };
  }

  async removeFromAlbum(
    albumId: string,
    photoId: string,
    afterMutation?: ImageRemoveHook,
  ) {
    const mutation = await this.prisma.$transaction(async (transaction) => {
      const photo = await transaction.photo.findFirst({
        where: { id: photoId, albumId },
        select: { id: true, objectKey: true, original: { select: { objectKey: true } } },
      });
      if (!photo) throw new NotFoundException("相册中的图片不存在");

      await transaction.$queryRaw(Prisma.sql`SELECT id FROM Photo WHERE id = ${photoId} FOR UPDATE`);
      const removable = await transaction.photo.count({ where: { id: photoId, albumId, news: { none: {} }, quizQuestions: { none: {} }, knowledgeImages: { none: {} }, knowledgeImportAssets: { none: {} } } });
      let cleanupOperationId: string | undefined;
      if (removable === 1) {
        cleanupOperationId = await this.recovery.planDeletion(transaction, photoId, [photo.objectKey, photo.original?.objectKey]);
        await transaction.photoOriginal.deleteMany({ where: { photoId } });
      }
      const deleted = removable === 1 ? await transaction.photo.deleteMany({
        where: {
          id: photoId,
          albumId,
          news: { none: {} },
          quizQuestions: { none: {} },
          knowledgeImages: { none: {} },
          knowledgeImportAssets: { none: {} },
        },
      }) : { count: 0 };
      if (removable === 1 && deleted.count !== 1) throw new ConflictException('图片引用已变化，请重试');
      if (!deleted.count) {
        const unlinked = await transaction.photo.updateMany({
          where: { id: photoId, albumId },
          data: { albumId: null },
        });
        if (!unlinked.count) {
          throw new NotFoundException("相册中的图片不存在");
        }
      }
      const result = {
        photoDeleted: deleted.count === 1,
        objectKey: photo.objectKey,
        cleanupOperationId,
      };
      if (afterMutation) await afterMutation(transaction, result);
      return result;
    });

    if (!mutation.photoDeleted) {
      return {
        id: photoId,
        removed: true as const,
        photoDeleted: false,
        objectDeleted: null,
      };
    }

    const objectDeleted = mutation.cleanupOperationId ? await this.recovery.recover(mutation.cleanupOperationId, true) : true;
    return {
      id: photoId,
      removed: true as const,
      photoDeleted: true,
      objectDeleted,
      cleanupOperationId: mutation.cleanupOperationId,
      cleanupPending: !objectDeleted,
    };
  }

  async sendContent(id: string, user: User | undefined, response: Response) {
    const photo = await this.prisma.photo.findUnique({
      where: { id },
      select: {
        data: true,
        objectKey: true,
        mimeType: true,
        size: true,
        uploadedById: true,
        album: { select: { archivedAt: true, deletedAt: true } },
        news: {
          select: {
            news: {
              select: {
                status: true,
                visibility: true,
                deletedAt: true,
              },
            },
          },
        },
        quizQuestions: {
          select: {
            question: {
              select: {
                enabled: true,
                origin: true,
                reviewStatus: true,
                sourceReviewStatus: true,
                subject: { select: { active: true } },
                chapters: {
                  select: { chapter: { select: { active: true } } },
                },
              },
            },
          },
        },
        knowledgeImages: {
          select: {
            documentVersionId: true,
            documentVersion: {
              select: {
                document: {
                  select: {
                    status: true,
                    activeVersionId: true,
                    deletedAt: true,
                    library: {
                      select: {
                        scope: true,
                        ownerId: true,
                        active: true,
                        deletedAt: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!photo)
      throw new NotFoundException("图片不存在");
    const publicNews = photo.news.some(
      ({ news }) =>
        !news.deletedAt &&
        news.status === ContentStatus.PUBLISHED &&
        news.visibility === Visibility.PUBLIC,
    );
    const memberNews = Boolean(
      user &&
        photo.news.some(
          ({ news }) =>
            !news.deletedAt && news.status === ContentStatus.PUBLISHED,
        ),
    );
    const albumManager =
      user?.role === Role.EDITOR || user?.role === Role.ADMIN;
    const albumAuthorized = Boolean(
      user &&
        photo.album &&
        !photo.album.deletedAt &&
        (!photo.album.archivedAt || albumManager),
    );
    const quizAuthorized = Boolean(
      user &&
        photo.quizQuestions.some(
          ({ question }) =>
            question.enabled &&
            question.subject.active &&
            question.chapters.every(({ chapter }) => chapter.active) &&
            question.reviewStatus === QuizQuestionReviewStatus.APPROVED &&
            (question.origin === QuizQuestionOrigin.MANUAL ||
              question.origin === QuizQuestionOrigin.CSV),
        ),
    );
    const knowledgeAuthorized = photo.knowledgeImages.some((link) => {
      if (!user) return false;
      const document = link.documentVersion.document;
      const library = document.library;
      if (!library.active || library.deletedAt || document.deletedAt) return false;
      if (library.scope === KnowledgeLibraryScope.PRIVATE) {
        return library.ownerId === user.id;
      }
      const sharedManager = user.role === Role.EDITOR || user.role === Role.ADMIN;
      return (
        sharedManager ||
        (document.status === ContentStatus.PUBLISHED &&
          document.activeVersionId === link.documentVersionId)
      );
    });
    const hasContentRelation = Boolean(
      photo.album ||
        photo.news.length ||
        photo.quizQuestions.length ||
        photo.knowledgeImages.length,
    );
    const managerPreview = Boolean(
      user &&
        (user.role === Role.ADMIN || user.role === Role.EDITOR) &&
        (photo.news.some(({ news }) => !news.deletedAt) ||
          photo.quizQuestions.length > 0),
    );
    const uploaderOrphan = Boolean(
      user && !hasContentRelation && photo.uploadedById === user.id,
    );
    const directlyAuthorized =
      publicNews || memberNews || albumAuthorized || quizAuthorized ||
      knowledgeAuthorized || managerPreview || uploaderOrphan;
    const historicalQuizAuthorized = Boolean(
      !directlyAuthorized && user &&
      await this.hasHistoricalQuizImage(user.id, id),
    );
    if (
      !directlyAuthorized && !historicalQuizAuthorized
    ) {
      throw new NotFoundException("图片不存在");
    }

    if (photo.data) {
      response.setHeader(
        "Cache-Control",
        publicNews ? "public, max-age=300" : "private, no-store",
      );
      const data = Buffer.from(photo.data);
      response.type(photo.mimeType);
      response.setHeader("Content-Length", data.length);
      response.send(data);
      return;
    }
    if (!photo.objectKey) throw new NotFoundException("图片内容不存在");
    const signedUrl = await this.storage.signedReadUrl(photo.objectKey);
    response.setHeader(
      "Cache-Control",
      publicNews ? "public, max-age=60" : "private, no-store",
    );
    response.redirect(302, signedUrl);
  }

  private async hasHistoricalQuizImage(userId: string, photoId: string) {
    // The frozen image reference belongs to the attempt/wrong-question owner.
    // Live question availability must not revoke access to their own history.
    const imageId = JSON.stringify(photoId);
    const rows = await this.prisma.$queryRaw<Array<{ allowed: number }>>(Prisma.sql`
      SELECT 1 AS allowed
      WHERE EXISTS (
        SELECT 1 FROM QuizAttempt
        WHERE userId = ${userId}
          AND (
            JSON_CONTAINS(JSON_EXTRACT(snapshot, '$.questions[*].images[*].id'), ${imageId}) = 1
            OR JSON_CONTAINS(JSON_EXTRACT(snapshot, '$[*].images[*].id'), ${imageId}) = 1
          )
      ) OR EXISTS (
        SELECT 1 FROM QuizWrongQuestion
        WHERE userId = ${userId}
          AND JSON_CONTAINS(JSON_EXTRACT(snapshot, '$.images[*].id'), ${imageId}) = 1
      )
      LIMIT 1
    `);
    return rows.length > 0;
  }

  async orphanReport() {
    const originals = await this.recovery.originalReport();
    const operationKeys = new Set(originals.pendingObjects.map((entry) => entry.key));
    const where = {
      albumId: null,
      news: { none: {} },
      quizQuestions: { none: {} },
      knowledgeImages: { none: {} },
    } as const;
    const [items, aggregate, storedPhotos, importAssets, knowledgeImportAssets] =
      await this.prisma.$transaction([
        this.prisma.photo.findMany({
          where,
          select: {
            id: true,
            objectKey: true,
            size: true,
            createdAt: true,
            uploadedById: true,
          },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.photo.aggregate({
          where,
          _count: { _all: true },
          _sum: { size: true },
        }),
        this.prisma.photo.findMany({
          where: { objectKey: { not: null } },
          select: { id: true, objectKey: true },
        }),
        this.prisma.quizImportAsset.findMany({
          where: { objectKey: { not: null } },
          select: {
            importId: true,
            objectKey: true,
            status: true,
            importJob: { select: { status: true } },
          },
        }),
        this.prisma.knowledgeImportAsset.findMany({
          where: { objectKey: { not: null } },
          select: {
            importId: true,
            objectKey: true,
            status: true,
            importJob: { select: { status: true } },
          },
        }),
      ]);
    let cosComparison: null | {
      objectCount: number;
      untrackedObjects: Array<{
        key: string;
        size: number;
        lastModified: string;
      }>;
      missingObjects: Array<{ id: string; objectKey: string }>;
      activeImportObjects: Array<{ importId: string; objectKey: string }>;
      failedImportObjects: Array<{ importId: string; objectKey: string }>;
    } = null;
    if (this.storage.usesCos()) {
      const objects = await this.storage.listObjects();
      const databaseKeys = new Set(
        storedPhotos.map((photo) => photo.objectKey).filter(Boolean),
      );
      const cosKeys = new Set(objects.map((object) => object.key));
      const activeImportObjects = importAssets
        .filter(
          (asset) =>
            asset.objectKey &&
            ["IMPORT_PENDING", "IMPORTING"].includes(asset.importJob.status),
        )
        .map((asset) => ({
          importId: asset.importId,
          objectKey: asset.objectKey!,
        }));
      const activeKnowledgeImportObjects = knowledgeImportAssets
        .filter(
          (asset) =>
            asset.objectKey &&
            ["INDEX_PENDING", "PROCESSING"].includes(asset.importJob.status),
        )
        .map((asset) => ({
          importId: asset.importId,
          objectKey: asset.objectKey!,
        }));
      activeImportObjects.push(...activeKnowledgeImportObjects);
      const activeImportKeys = new Set(
        activeImportObjects.map((asset) => asset.objectKey),
      );
      cosComparison = {
        objectCount: objects.length,
        untrackedObjects: objects.filter(
          (object) =>
            !databaseKeys.has(object.key) && !activeImportKeys.has(object.key) && !operationKeys.has(object.key),
        ),
        missingObjects: storedPhotos
          .filter(
            (photo): photo is { id: string; objectKey: string } =>
              Boolean(photo.objectKey) && !cosKeys.has(photo.objectKey!),
          )
          .map(({ id: photoId, objectKey }) => ({
            id: photoId,
            objectKey,
          })),
        activeImportObjects,
        failedImportObjects: importAssets
          .filter((asset) => asset.objectKey && asset.status === "ORPHANED")
          .map((asset) => ({
            importId: asset.importId,
            objectKey: asset.objectKey!,
          }))
          .concat(
            knowledgeImportAssets
              .filter(
                (asset) =>
                  asset.objectKey && asset.status === "ORPHANED",
              )
              .map((asset) => ({
                importId: asset.importId,
                objectKey: asset.objectKey!,
              })),
          ),
      };
    }
    return {
      generatedAt: new Date().toISOString(),
      total: aggregate._count._all,
      totalBytes: aggregate._sum.size ?? 0,
      items,
      cosComparison,
      originals,
    };
  }

  private async compensateFailedCreate(objectKey: string) {
    try {
      await this.storage.delete(objectKey);
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "media.orphan-object",
          objectKey,
          reason: "photo-database-create-failed-and-delete-failed",
        }),
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}

export { createMediaObjectKey };

const albumPhotoSelect = {
  id: true, albumId: true, caption: true, mimeType: true, size: true,
  width: true, height: true, sortOrder: true, createdAt: true,
  original: { select: { photoId: true } },
} satisfies Prisma.PhotoSelect;
