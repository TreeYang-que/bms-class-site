import {
  KNOWLEDGE_CHUNKER_VERSION,
  KNOWLEDGE_PARSER_VERSION,
  KNOWLEDGE_RENDER_BLOCK_VERSION,
  KNOWLEDGE_VECTOR_SCHEMA_VERSION,
  KnowledgeArchiveError,
  createKnowledgeEmbeddingProvider,
  deterministicKnowledgeEmbedding,
  decodeMarkdown,
  deterministicUuid,
  forEachKnowledgeZipImage,
  inspectKnowledgeZip,
  parseKnowledgeMarkdown,
  readKnowledgeZipEntry,
  sha256,
  type KnowledgeIssue,
  type KnowledgeParseResult,
} from "@bmc3/knowledge-core";
import {
  CosMediaStore,
  compressImage,
  createMediaObjectKey,
  inspectImage,
  readMediaCosConfig,
} from "@bmc3/media-core";
import {
  IndexStatus,
  KnowledgeImportAssetStatus,
  KnowledgeImportFileType,
  KnowledgeImportIssueSeverity,
  KnowledgeImportStatus,
  ImportSourceCleanupStatus,
  KnowledgeLibraryScope,
  Prisma,
  PrismaClient,
  type KnowledgeImportJob,
  type IndexJob,
} from "@prisma/client";
import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { extname } from "node:path";
import { localObjectPath, removeLocalObject } from "./local-storage";
import { persistKnowledgeRenderBlocks } from "./knowledge-render";

const COLLECTION_SCHEMA_VERSION = KNOWLEDGE_VECTOR_SCHEMA_VERSION;
const DEFAULT_COLLECTION = "bmc3_knowledge_embedding3_1024_v1";
const DEFAULT_ALIAS = "bmc3_knowledge_active";
const MAX_ISSUES = 1_000;
const LEASE_MS = readPositiveInteger("WORKER_KNOWLEDGE_IMPORT_LEASE_MS", 60 * 60_000, 60_000);
const HEARTBEAT_MS = Math.max(10_000, Math.min(60_000, Math.floor(LEASE_MS / 3)));

type ImportPhase = "preflight" | "index" | "compensation";
type IssueInput = Omit<Prisma.KnowledgeImportIssueCreateManyInput, "importId">;

interface ImportAnalysis {
  parse: KnowledgeParseResult;
  issues: IssueInput[];
  sourcePath: string;
  imageMetadata: Map<
    string,
    {
      contentHash: string;
      sourceSize: number;
      mimeType: string;
      width: number;
      height: number;
      processedSize: number;
    }
  >;
}

interface ReplacementPreview {
  mode: "CREATE" | "REPLACE";
  targetDocumentId: string | null;
  targetDocumentTitle: string | null;
  targetDocumentCreatedAt: string | null;
  activeVersionId: string | null;
  matchedH2Titles: string[];
}

async function resolveH2Replacement(
  prisma: PrismaClient,
  job: Pick<KnowledgeImportJob, "libraryId" | "targetDocumentId">,
  parse: KnowledgeParseResult,
): Promise<{ preview: ReplacementPreview; issue?: IssueInput }> {
  const incomingH2 = [
    ...new Set(
      parse.nodes
        .filter((node) => node.level === 2)
        .map((node) => node.title),
    ),
  ];
  const documents = await prisma.knowledgeDocument.findMany({
    where: {
      libraryId: job.libraryId,
      deletedAt: null,
      kind: "MARKDOWN",
    },
    select: {
      id: true,
      title: true,
      createdAt: true,
      activeVersionId: true,
      activeVersion: {
        select: {
          nodes: {
            where: { level: 2 },
            select: { title: true },
          },
        },
      },
    },
  });
  const incoming = new Set(incomingH2);
  const explicitTargetId = job.targetDocumentId ?? null;
  const matches = documents
    .map((document) => ({
      document,
      titles: (document.activeVersion?.nodes ?? [])
        .map((node) => node.title)
        .filter((title) => incoming.has(title)),
    }))
    .filter((match) => match.titles.length > 0);
  const matchedDocumentIds = new Set(matches.map((match) => match.document.id));
  const targetDocumentId = explicitTargetId ?? matches[0]?.document.id ?? null;
  const target = documents.find((document) => document.id === targetDocumentId) ?? null;
  const conflicts = [...matchedDocumentIds].filter(
    (documentId) => documentId !== targetDocumentId,
  );
  if (
    matchedDocumentIds.size > 1 ||
    (explicitTargetId !== null && conflicts.length > 0)
  ) {
    return {
      preview: {
        mode: explicitTargetId ? "REPLACE" : "CREATE",
        targetDocumentId: explicitTargetId,
        targetDocumentTitle:
          documents.find((document) => document.id === explicitTargetId)
            ?.title ?? null,
        targetDocumentCreatedAt:
          documents
            .find((document) => document.id === explicitTargetId)
            ?.createdAt.toISOString() ?? null,
        activeVersionId:
          documents.find((document) => document.id === explicitTargetId)
            ?.activeVersionId ?? null,
        matchedH2Titles: [...new Set(matches.flatMap((match) => match.titles))],
      },
      issue: issue(
        KnowledgeImportIssueSeverity.ERROR,
        "H2_REPLACEMENT_AMBIGUOUS",
        "提交文件中的 H2 同时属于多个逻辑文档，无法确定整份替换目标",
      ),
    };
  }
  const targetMatches = matches.find(
    (match) => match.document.id === targetDocumentId,
  );
  return {
    preview: {
      mode: target ? "REPLACE" : "CREATE",
      targetDocumentId: target?.id ?? null,
      targetDocumentTitle: target?.title ?? null,
      targetDocumentCreatedAt: target?.createdAt.toISOString() ?? null,
      activeVersionId: target?.activeVersionId ?? null,
      matchedH2Titles: targetMatches?.titles ?? [],
    },
  };
}

let activeKnowledgeImport: {
  id: string;
  phase: ImportPhase;
  ownerToken: string;
} | null = null;
let qdrantPromise: Promise<QdrantRuntime> | null = null;

interface QdrantRuntime {
  client: QdrantClient;
  collection: string;
}

function leaseUntil() {
  return new Date(Date.now() + LEASE_MS);
}

function requiredKnowledgeImportOwner(
  job: { leaseOwnerToken?: string | null },
) {
  if (!job.leaseOwnerToken) {
    throw new Error("KNOWLEDGE_IMPORT_OWNER_TOKEN_MISSING");
  }
  return job.leaseOwnerToken;
}

function issueFromKnowledge(item: KnowledgeIssue): IssueInput {
  return {
    severity:
      item.severity === "ERROR"
        ? KnowledgeImportIssueSeverity.ERROR
        : KnowledgeImportIssueSeverity.WARNING,
    code: item.code.slice(0, 80),
    message: item.message.slice(0, 500),
    entryPath: item.entryPath?.slice(0, 500),
    nodePath: item.nodePath?.slice(0, 500),
    line: item.line,
    column: item.column,
  };
}

function issue(
  severity: KnowledgeImportIssueSeverity,
  code: string,
  message: string,
  entryPath?: string,
): IssueInput {
  return {
    severity,
    code,
    message: message.slice(0, 500),
    entryPath: entryPath?.slice(0, 500),
  };
}

async function analyzeImport(job: KnowledgeImportJob): Promise<ImportAnalysis> {
  const sourcePath = localObjectPath(job.sourceObjectKey);
  const limits = knowledgeImportLimits();
  const sourceSize = (await fs.stat(sourcePath)).size;
  const sourceMaximum =
    job.fileType === KnowledgeImportFileType.ZIP
      ? limits.maxZipBytes
      : limits.maxMarkdownBytes;
  if (sourceSize !== job.sourceSize || sourceSize > sourceMaximum) {
    throw new Error("KNOWLEDGE_SOURCE_SIZE_CHANGED");
  }
  if ((await hashLocalFile(sourcePath)) !== job.sourceSha256) {
    throw new Error("KNOWLEDGE_SOURCE_HASH_CHANGED");
  }
  let markdownBuffer: Buffer;
  let zipImagePaths: string[] = [];
  if (job.fileType === KnowledgeImportFileType.ZIP) {
    const inspected = await inspectKnowledgeZip(sourcePath, {
      maxExpandedBytes: limits.maxExpandedBytes,
      maxImageFiles: limits.maxImages,
      maxMarkdownBytes: limits.maxMarkdownBytes,
      maxImageBytes: limits.maxImageBytes,
      maxZipRatio: limits.maxZipRatio,
    });
    markdownBuffer = await readKnowledgeZipEntry(
      sourcePath,
      inspected.markdownPath,
      limits.maxMarkdownBytes,
    );
    zipImagePaths = inspected.imagePaths;
  } else {
    markdownBuffer = await fs.readFile(sourcePath);
  }

  const parse = parseKnowledgeMarkdown(decodeMarkdown(markdownBuffer), {
    allowImages: job.fileType === KnowledgeImportFileType.ZIP,
  });
  const issues = parse.issues.map(issueFromKnowledge);
  const referenced = new Map(
    parse.images.map((image) => [image.entryPath.toLocaleLowerCase("en-US"), image.entryPath]),
  );
  const archived = new Map(
    zipImagePaths.map((path) => [path.toLocaleLowerCase("en-US"), path]),
  );

  for (const [key, path] of referenced) {
    if (!archived.has(key)) {
      issues.push(
        issue(
          KnowledgeImportIssueSeverity.ERROR,
          "IMAGE_NOT_FOUND",
          "Markdown 引用的图片不存在",
          path,
        ),
      );
    } else if (archived.get(key) !== path) {
      issues.push(
        issue(
          KnowledgeImportIssueSeverity.ERROR,
          "IMAGE_PATH_CASE_MISMATCH",
          "Markdown 图片路径大小写必须与 ZIP entry 完全一致",
          path,
        ),
      );
    }
  }
  for (const [key, path] of archived) {
    if (!referenced.has(key)) {
      issues.push(
        issue(
          KnowledgeImportIssueSeverity.ERROR,
          "IMAGE_UNUSED",
          "ZIP 中的图片必须被 Markdown 引用",
          path,
        ),
      );
    }
  }

  const imageMetadata: ImportAnalysis["imageMetadata"] = new Map();
  if (job.fileType === KnowledgeImportFileType.ZIP) {
    await forEachKnowledgeZipImage(sourcePath, async (entryPath, data) => {
      if (!referenced.has(entryPath.toLocaleLowerCase("en-US"))) return;
      try {
        const inspected = await inspectImage(data);
        if (inspected.width * inspected.height > limits.maxImagePixels) {
          throw new Error("IMAGE_PIXEL_LIMIT");
        }
        const processed = await compressImage(data);
        if (processed.size > limits.maxProcessedImageBytes) {
          throw new Error("IMAGE_PROCESSED_SIZE_LIMIT");
        }
        imageMetadata.set(entryPath, {
          contentHash: sha256(data),
          sourceSize: data.length,
          mimeType: `image/${inspected.format}`,
          width: inspected.width,
          height: inspected.height,
          processedSize: processed.size,
        });
      } catch {
        issues.push(
          issue(
            KnowledgeImportIssueSeverity.ERROR,
            "IMAGE_DECODE_FAILED",
            "图片无法完整解码或压缩到 300 KiB",
            entryPath,
          ),
        );
      }
    }, limits.maxImageBytes);
  }
  return { parse, issues: issues.slice(0, MAX_ISSUES), sourcePath, imageMetadata };
}

async function replaceIssues(
  prisma: Pick<PrismaClient, "knowledgeImportIssue">,
  importId: string,
  issues: IssueInput[],
) {
  await prisma.knowledgeImportIssue.deleteMany({ where: { importId } });
  if (issues.length) {
    await prisma.knowledgeImportIssue.createMany({
      data: issues.map((item) => ({ ...item, importId })),
    });
  }
}

function previewSummary(
  parse: KnowledgeParseResult,
  replacement: ReplacementPreview,
): Prisma.InputJsonObject {
  return {
    titleMarkdown: parse.titleMarkdown,
    contentHash: parse.contentHash,
    imageManifestHash: parse.imageManifestHash,
    parserVersion: KNOWLEDGE_PARSER_VERSION,
    chunkerVersion: KNOWLEDGE_CHUNKER_VERSION,
    renderBlockVersion: KNOWLEDGE_RENDER_BLOCK_VERSION,
    renderBlockCount: parse.renderBlockCount,
    mathCount: parse.mathCount,
    nodes: parse.nodes.map((node) => ({
      level: node.level,
      title: node.title,
      titleMarkdown: node.titleMarkdown,
      path: node.path,
      chapterName: node.chapterName,
      chunkCount: node.chunks.length,
    })),
    images: parse.images.map((image) => ({
      entryPath: image.entryPath,
      altText: image.altText,
      nodePathHash: image.nodePathHash,
      occurrenceIndex: image.occurrenceIndex,
    })),
    replacement: { ...replacement },
  };
}

export async function runKnowledgeImportPreflight(
  prisma: PrismaClient,
  job: KnowledgeImportJob,
) {
  let analysis: ImportAnalysis;
  try {
    analysis = await withHeartbeat(
      prisma,
      job.id,
      requiredKnowledgeImportOwner(job),
      () => analyzeImport(job),
    );
  } catch (error) {
    if (!(error instanceof KnowledgeArchiveError)) throw error;
    await prisma.$transaction(async (transaction) => {
      await replaceIssues(transaction, job.id, [
        issue(
          KnowledgeImportIssueSeverity.ERROR,
          error.code,
          error.message,
          error.entryPath,
        ),
      ]);
      const invalidated = await transaction.knowledgeImportJob.updateMany({
        where: {
          id: job.id,
          status: KnowledgeImportStatus.PREFLIGHTING,
          leaseOwnerToken: requiredKnowledgeImportOwner(job),
          cancelRequestedAt: null,
        },
        data: {
          status: KnowledgeImportStatus.INVALID,
          stage: "INVALID",
          errorCount: 1,
          warningCount: 0,
          leaseOwnerToken: null,
          leasedUntil: null,
          completedAt: new Date(),
          sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
          sourceCleanupNextAttemptAt: new Date(),
          errorCode: error.code,
          errorMessage: "知识包不符合导入规则",
        },
      });
      if (invalidated.count !== 1) {
        throw new Error("KNOWLEDGE_IMPORT_LEASE_LOST");
      }
    });
    return;
  }
  const replacement = await resolveH2Replacement(prisma, job, analysis.parse);
  if (replacement.issue) analysis.issues.push(replacement.issue);
  const errorCount = analysis.issues.filter(
    (item) => item.severity === KnowledgeImportIssueSeverity.ERROR,
  ).length;
  const warningCount = analysis.issues.length - errorCount;
  const processedImageBytes = [...analysis.imageMetadata.values()].reduce(
    (total, metadata) => total + metadata.processedSize,
    0,
  );
  const status = errorCount
    ? KnowledgeImportStatus.INVALID
    : KnowledgeImportStatus.AWAITING_CONFIRMATION;
  await prisma.$transaction(async (transaction) => {
    await replaceIssues(transaction, job.id, analysis.issues);
    await transaction.knowledgeImportAsset.deleteMany({
      where: { importId: job.id },
    });
    if (!errorCount && analysis.imageMetadata.size) {
      await transaction.knowledgeImportAsset.createMany({
        data: [...analysis.imageMetadata].map(([entryPath, metadata]) => ({
          importId: job.id,
          entryPath,
          ...metadata,
          objectKey:
            (process.env.MEDIA_STORAGE_PROVIDER ?? "database") === "cos"
              ? createMediaObjectKey(new Date())
              : null,
        })),
      });
    }
    const completed = await transaction.knowledgeImportJob.updateMany({
      where: {
        id: job.id,
        status: KnowledgeImportStatus.PREFLIGHTING,
        leaseOwnerToken: requiredKnowledgeImportOwner(job),
        cancelRequestedAt: null,
      },
      data: {
        status,
        stage: errorCount ? "INVALID" : "READY_FOR_CONFIRMATION",
        progressCurrent: 0,
        progressTotal: 0,
        title: analysis.parse.title || null,
        targetDocumentId:
          errorCount === 0
            ? replacement.preview.targetDocumentId
            : job.targetDocumentId,
        nodeCount: analysis.parse.nodes.length,
        estimatedChunkCount: analysis.parse.chunkCount,
        imageCount: new Set(
          analysis.parse.images.map((image) => image.entryPath),
        ).size,
        processedImageBytes,
        errorCount,
        warningCount,
        summary: previewSummary(analysis.parse, replacement.preview),
        leaseOwnerToken: null,
        leasedUntil: null,
        attempts: 0,
        errorCode: replacement.issue?.code ?? null,
        errorMessage: replacement.issue?.message ?? null,
        completedAt: errorCount ? new Date() : null,
        ...(errorCount
          ? {
              sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
              sourceCleanupNextAttemptAt: new Date(),
            }
          : {}),
      },
    });
    if (completed.count !== 1) {
      throw new Error("KNOWLEDGE_IMPORT_LEASE_LOST");
    }
  });
}

async function verifyConfirmedImport(
  prisma: PrismaClient,
  job: KnowledgeImportJob,
) {
  const analysis = await analyzeImport(job);
  const version = job.confirmedVersionId
    ? await prisma.knowledgeDocumentVersion.findUnique({
        where: { id: job.confirmedVersionId },
      })
    : null;
  if (!version) throw new Error("CONFIRMED_VERSION_MISSING");
  const hasErrors = analysis.issues.some(
    (item) => item.severity === KnowledgeImportIssueSeverity.ERROR,
  );
  if (
    hasErrors ||
    analysis.parse.contentHash !== version.contentHash ||
    analysis.parse.imageManifestHash !== version.imageManifestHash ||
    analysis.parse.chunkCount !== version.chunkCount ||
    version.parserVersion !== KNOWLEDGE_PARSER_VERSION ||
    version.chunkerVersion !== KNOWLEDGE_CHUNKER_VERSION ||
    version.renderBlockVersion !== KNOWLEDGE_RENDER_BLOCK_VERSION
  ) {
    await replaceIssues(prisma, job.id, analysis.issues);
    throw new Error("PREFLIGHT_CHANGED");
  }
  return { analysis, version };
}

async function persistImages(
  prisma: PrismaClient,
  job: KnowledgeImportJob,
  analysis: ImportAnalysis,
  versionId: string,
) {
  const limits = knowledgeImportLimits();
  const assets = await prisma.knowledgeImportAsset.findMany({
    where: { importId: job.id },
  });
  const byPath = new Map(assets.map((asset) => [asset.entryPath, asset]));
  const store =
    (process.env.MEDIA_STORAGE_PROVIDER ?? "database") === "cos"
      ? new CosMediaStore(readMediaCosConfig(process.env))
      : null;
  const uniqueImages = [...new Map(analysis.parse.images.map((image) => [image.entryPath, image])).values()];
  if (!uniqueImages.length) return;
  const imageByPath = new Map(uniqueImages.map((image, index) => [image.entryPath, { image, index }]));
  const processedPaths = new Set<string>();
  await forEachKnowledgeZipImage(analysis.sourcePath, async (entryPath, input) => {
    const planned = imageByPath.get(entryPath);
    if (!planned) return;
    await assertImportContinuing(
      prisma,
      job.id,
      requiredKnowledgeImportOwner(job),
    );
    const { image, index } = planned;
    const asset = byPath.get(image.entryPath);
    if (!asset || sha256(input) !== asset.contentHash) {
      throw new Error("IMAGE_ASSET_CHANGED");
    }
    const processed = await compressImage(input);
    if (processed.size > limits.maxProcessedImageBytes) {
      throw new Error("IMAGE_PROCESSED_SIZE_LIMIT");
    }
    if (processed.size !== asset.processedSize) throw new Error("IMAGE_PROCESSING_CHANGED");
    const photoId = deterministicUuid("knowledge-photo", job.id, image.entryPath);
    if (store) {
      if (!asset.objectKey) throw new Error("IMAGE_OBJECT_KEY_MISSING");
      await store.upload(processed.data, asset.objectKey, processed.mimeType);
      await prisma.knowledgeImportAsset.update({
        where: { id: asset.id },
        data: { status: KnowledgeImportAssetStatus.UPLOADED },
      });
    }
    await prisma.photo.upsert({
      where: { id: photoId },
      create: {
        id: photoId,
        uploadedById: job.createdById,
        objectKey: store ? asset.objectKey : null,
        data: store ? null : new Uint8Array(processed.data),
        caption: image.altText,
        mimeType: processed.mimeType,
        size: processed.size,
        width: processed.width,
        height: processed.height,
        sortOrder: index,
      },
      update: {},
    });
    const versionImageId = deterministicUuid(
      "knowledge-version-image",
      versionId,
      image.entryPath,
    );
    await prisma.knowledgeVersionImage.upsert({
      where: { id: versionImageId },
      create: {
        id: versionImageId,
        documentVersionId: versionId,
        photoId,
        importAssetId: asset.id,
        entryPath: image.entryPath,
        contentHash: asset.contentHash,
        altText: image.altText,
        sortOrder: index,
      },
      update: {},
    });
    await prisma.knowledgeImportAsset.update({
      where: { id: asset.id },
      data: {
        photoId,
        status: KnowledgeImportAssetStatus.LINKED,
        cleanupError: null,
      },
    });
    processedPaths.add(entryPath);
  }, limits.maxImageBytes);
  if (processedPaths.size !== uniqueImages.length) {
    throw new Error("IMAGE_ASSET_CHANGED");
  }
}

async function persistTree(
  prisma: PrismaClient,
  job: Pick<KnowledgeImportJob, "libraryId"> &
    Partial<Pick<KnowledgeImportJob, "id" | "leaseOwnerToken">>,
  analysis: ImportAnalysis,
  version: {
    id: string;
    documentId: string;
    version: number;
    contentHash: string;
  },
) {
  const chapters = await prisma.knowledgeLibraryChapter.findMany({
    where: { libraryId: job.libraryId },
  });
  const chapterByName = new Map(chapters.map((chapter) => [chapter.normalizedName, chapter]));
  const nodeIdByHash = new Map(
    analysis.parse.nodes.map((node) => [
      node.pathHash,
      deterministicUuid("knowledge-node", version.id, node.pathHash),
    ]),
  );
  for (let nodeIndex = 0; nodeIndex < analysis.parse.nodes.length; nodeIndex += 1) {
    const node = analysis.parse.nodes[nodeIndex]!;
    if (job.id && nodeIndex % 100 === 0) {
      await assertImportContinuing(
        prisma,
        job.id,
        requiredKnowledgeImportOwner(job),
      );
    }
    const chapter = chapterByName.get(node.chapterName);
    if (!chapter || !chapter.active) throw new Error("LIBRARY_CHAPTER_UNAVAILABLE");
    await prisma.knowledgeNode.upsert({
      where: { id: nodeIdByHash.get(node.pathHash)! },
      create: {
        id: nodeIdByHash.get(node.pathHash)!,
        documentVersionId: version.id,
        libraryChapterId: chapter.id,
        parentId: node.parentPathHash ? nodeIdByHash.get(node.parentPathHash) : null,
        level: node.level,
        title: node.title,
        titleMarkdown: node.titleMarkdown,
        path: node.path,
        pathHash: node.pathHash,
        breadcrumb: node.breadcrumb,
        body: node.body,
        sortOrder: node.sortOrder,
      },
      update: {},
    });
  }

  const chunkIdByOccurrence = new Map<number, string>();
  let persistedChunkCount = 0;
  for (const node of analysis.parse.nodes) {
    const nodeId = nodeIdByHash.get(node.pathHash)!;
    for (const chunk of node.chunks) {
      if (job.id && persistedChunkCount % 100 === 0) {
        await assertImportContinuing(
          prisma,
          job.id,
          requiredKnowledgeImportOwner(job),
        );
      }
      const chunkId = deterministicUuid(
        "knowledge-chunk",
        version.id,
        String(chunk.chunkIndex),
        chunk.contentHash,
      );
      await prisma.knowledgeChunk.upsert({
        where: { id: chunkId },
        create: {
          id: chunkId,
          documentId: version.documentId,
          documentVersionId: version.id,
          nodeId,
          versionNumber: version.version,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          tokenCount: chunk.tokenCount,
          contentHash: chunk.contentHash,
          embeddingStatus: IndexStatus.PENDING,
        },
        update: {},
      });
      for (const occurrence of chunk.imageOccurrenceIndexes) {
        chunkIdByOccurrence.set(occurrence, chunkId);
      }
      persistedChunkCount += 1;
    }
  }

  const versionImages = await prisma.knowledgeVersionImage.findMany({
    where: { documentVersionId: version.id },
  });
  const versionImageByPath = new Map(versionImages.map((image) => [image.entryPath, image.id]));
  for (const image of analysis.parse.images) {
    const versionImageId = versionImageByPath.get(image.entryPath);
    const nodeId = nodeIdByHash.get(image.nodePathHash);
    if (!versionImageId || !nodeId) throw new Error("IMAGE_REFERENCE_TARGET_MISSING");
    const id = deterministicUuid(
      "knowledge-image-reference",
      versionImageId,
      String(image.occurrenceIndex),
    );
    await prisma.knowledgeImageReference.upsert({
      where: { id },
      create: {
        id,
        versionImageId,
        nodeId,
        chunkId: chunkIdByOccurrence.get(image.occurrenceIndex),
        occurrenceIndex: image.occurrenceIndex,
        altText: image.altText,
        sourceLine: image.line,
        sourceColumn: image.column,
      },
      update: {},
    });
  }
  await prisma.knowledgeDocumentVersion.update({
    where: { id: version.id },
    data: {
      markdown: analysis.parse.markdown,
      titleMarkdown: analysis.parse.titleMarkdown,
    },
  });
  await persistKnowledgeRenderBlocks(prisma, version, analysis.parse);
}

function embeddingInput(
  subjectName: string,
  libraryName: string,
  chapterName: string,
  breadcrumb: string,
  content: string,
) {
  return `${subjectName} > ${libraryName} > ${chapterName} > ${breadcrumb}\n\n${content}`;
}

async function indexVectors(
  prisma: PrismaClient,
  job: {
    libraryId: string;
    progressImportId?: string;
    progressImportOwnerToken?: string;
    progressIndexJobId?: string;
    progressIndexOwnerToken?: string;
  },
  versionId: string,
  dependencies: {
    runtime?: QdrantRuntime;
    provider?: ReturnType<typeof embeddingProvider>;
  } = {},
) {
  await assertVectorIndexOwnership(prisma, job);
  await assertLibraryAiAccess(prisma, job.libraryId);
  const runtime = dependencies.runtime ?? await qdrant();
  const provider = dependencies.provider ?? embeddingProvider();
  const batchSize = readPositiveInteger("EMBEDDING_BATCH_SIZE", 32, 1, 64);
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { documentVersionId: versionId },
    include: {
      node: { include: { libraryChapter: true } },
      document: {
        include: { subject: true, library: true },
      },
    },
    orderBy: { chunkIndex: "asc" },
  });
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    await assertVectorIndexOwnership(prisma, job);
    await assertLibraryAiAccess(prisma, job.libraryId);
    const batch = chunks.slice(offset, offset + batchSize);
    const ids = batch.map((chunk) =>
      deterministicUuid(
        COLLECTION_SCHEMA_VERSION,
        chunk.id,
        chunk.contentHash ?? "",
      ),
    );
    const existing = (await runtime.client.retrieve(runtime.collection, {
      ids,
      with_payload: true,
      with_vector: false,
    })) as Array<{ id: string | number; payload?: Record<string, unknown> | null }>;
    await assertVectorIndexOwnership(prisma, job);
    const existingById = new Map(existing.map((point) => [String(point.id), point]));
    const missing = batch.filter((chunk, index) => {
      const point = existingById.get(ids[index]!);
      if (!point) return true;
      if (
        point.payload?.chunkId !== chunk.id ||
        point.payload?.contentHash !== chunk.contentHash
      ) {
        throw new Error("QDRANT_POINT_CONFLICT");
      }
      return false;
    });
    if (missing.length) {
      const vectors = await provider.embed(
        missing.map((chunk) =>
          embeddingInput(
            chunk.document.subject.name,
            chunk.document.library.name,
            chunk.node!.libraryChapter.name,
            chunk.node!.breadcrumb,
            chunk.content,
          ),
        ),
      );
      await assertVectorIndexOwnership(prisma, job);
      await runtime.client.upsert(runtime.collection, {
        wait: true,
        points: missing.map((chunk, index) => ({
          id: deterministicUuid(
            COLLECTION_SCHEMA_VERSION,
            chunk.id,
            chunk.contentHash ?? "",
          ),
          vector: vectors[index]!,
          payload: {
            chunkId: chunk.id,
            nodeId: chunk.nodeId,
            documentId: chunk.documentId,
            documentVersionId: versionId,
            subjectId: chunk.document.subjectId,
            libraryId: chunk.document.libraryId,
            scope: chunk.document.library.scope,
            ownerId: chunk.document.library.ownerId,
            libraryChapterId: chunk.node!.libraryChapterId,
            active: false,
            contentHash: chunk.contentHash,
            schemaVersion: COLLECTION_SCHEMA_VERSION,
            embeddingModel: provider.model,
          },
        })),
      });
      await assertVectorIndexOwnership(prisma, job);
    }
    await prisma.$transaction(async (transaction) => {
      if (job.progressImportId) {
        const progressed = await transaction.knowledgeImportJob.updateMany({
          where: {
            id: job.progressImportId,
            status: KnowledgeImportStatus.PROCESSING,
            leaseOwnerToken: job.progressImportOwnerToken,
          },
          data: {
            stage: "EMBEDDING_AND_QDRANT",
            progressCurrent: Math.min(offset + batch.length, chunks.length),
            progressTotal: chunks.length,
            leasedUntil: leaseUntil(),
          },
        });
        if (progressed.count !== 1) {
          throw new Error("KNOWLEDGE_IMPORT_LEASE_LOST");
        }
      } else if (job.progressIndexJobId) {
        const progressed = await transaction.indexJob.updateMany({
          where: {
            id: job.progressIndexJobId,
            status: IndexStatus.PROCESSING,
            leaseOwnerToken: job.progressIndexOwnerToken,
          },
          data: {
            progressCurrent: Math.min(offset + batch.length, chunks.length),
            progressTotal: chunks.length,
            leasedUntil: leaseUntil(),
          },
        });
        if (progressed.count !== 1) {
          throw new Error("INDEX_JOB_LEASE_LOST");
        }
      } else {
        throw new Error("KNOWLEDGE_INDEX_OWNER_MISSING");
      }
      await transaction.knowledgeChunk.updateMany({
        where: { id: { in: batch.map((chunk) => chunk.id) } },
        data: {
          embeddingStatus: IndexStatus.READY,
          embeddedAt: new Date(),
        },
      });
    });
  }
  return chunks.length;
}

async function assertVectorIndexOwnership(
  prisma: PrismaClient,
  job: {
    progressImportId?: string;
    progressImportOwnerToken?: string;
    progressIndexJobId?: string;
    progressIndexOwnerToken?: string;
  },
) {
  if (job.progressImportId) {
    if (!job.progressImportOwnerToken) {
      throw new Error("KNOWLEDGE_IMPORT_OWNER_TOKEN_MISSING");
    }
    await assertImportContinuing(
      prisma,
      job.progressImportId,
      job.progressImportOwnerToken,
    );
  }
  if (job.progressIndexJobId) {
    if (!job.progressIndexOwnerToken) {
      throw new Error("INDEX_JOB_OWNER_TOKEN_MISSING");
    }
    await assertIndexJobOwner(
      prisma,
      job.progressIndexJobId,
      job.progressIndexOwnerToken,
    );
  }
}

async function assertLibraryAiAccess(
  prisma: PrismaClient,
  libraryId: string,
) {
  const access = await prisma.knowledgeLibrary.findUnique({
    where: { id: libraryId },
  });
  if (
    !access ||
    !access.active ||
    access.deletedAt ||
    (access.scope === KnowledgeLibraryScope.PRIVATE && !access.aiEnabled)
  ) {
    throw new Error("LIBRARY_AI_ACCESS_REVOKED");
  }
}

async function finishIndex(
  prisma: PrismaClient,
  job: KnowledgeImportJob,
  versionId: string,
  vectorCount: number,
) {
  const render = await prisma.knowledgeDocumentVersion.findUnique({
    where: { id: versionId },
    select: { renderStatus: true, renderBlockCount: true },
  });
  if (
    render?.renderStatus !== "READY" ||
    render.renderBlockCount < 1
  ) {
    throw new Error("RENDER_BLOCKS_INCOMPLETE");
  }
  const keys = ["GLOBAL"];
  const library = await prisma.knowledgeLibrary.findUniqueOrThrow({
    where: { id: job.libraryId },
  });
  if (library.scope === KnowledgeLibraryScope.PRIVATE) {
    keys.push("PRIVATE_GLOBAL", `USER:${library.ownerId}`);
  }
  await prisma.$transaction(async (transaction) => {
    const current = await transaction.knowledgeImportJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    if (
      current.status !== KnowledgeImportStatus.PROCESSING ||
      current.cancelRequestedAt
    ) {
      throw new Error("IMPORT_STATUS_CHANGED");
    }
    if (current.leaseOwnerToken !== requiredKnowledgeImportOwner(job)) {
      throw new Error("KNOWLEDGE_IMPORT_LEASE_LOST");
    }
    const completed = await transaction.knowledgeImportJob.updateMany({
      where: {
        id: job.id,
        status: KnowledgeImportStatus.PROCESSING,
        leaseOwnerToken: requiredKnowledgeImportOwner(job),
      },
      data: {
        status: KnowledgeImportStatus.READY,
        stage: "READY",
        progressCurrent: vectorCount,
        progressTotal: vectorCount,
        reservedChunks: 0,
        reservedPoints: 0,
        reservedImages: 0,
        reservedMediaBytes: 0,
        leaseOwnerToken: null,
        leasedUntil: null,
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
        sourceCleanupNextAttemptAt: new Date(),
      },
    });
    if (completed.count !== 1) {
      throw new Error("KNOWLEDGE_IMPORT_LEASE_LOST");
    }
    await transaction.knowledgeDocumentVersion.update({
      where: { id: versionId },
      data: {
        indexStatus: IndexStatus.READY,
        vectorCount,
        indexedAt: new Date(),
        error: null,
      },
    });
    for (const key of keys) {
      await transaction.knowledgeCapacityCounter.update({
        where: { key },
        data: {
          activeChunks: { increment: current.reservedChunks },
          livePoints: { increment: current.reservedPoints },
          imageCount: { increment: current.reservedImages },
          mediaBytes: { increment: current.reservedMediaBytes },
          reservedChunks: { decrement: current.reservedChunks },
          reservedPoints: { decrement: current.reservedPoints },
          reservedImages: { decrement: current.reservedImages },
          reservedMediaBytes: { decrement: current.reservedMediaBytes },
        },
      });
    }
  });
}

export async function runKnowledgeImportIndex(
  prisma: PrismaClient,
  job: KnowledgeImportJob,
) {
  await assertImportContinuing(
    prisma,
    job.id,
    requiredKnowledgeImportOwner(job),
  );
  const { analysis, version } = await withHeartbeat(
    prisma,
    job.id,
    requiredKnowledgeImportOwner(job),
    () => verifyConfirmedImport(prisma, job),
  );
  await persistImages(prisma, job, analysis, version.id);
  await assertImportContinuing(
    prisma,
    job.id,
    requiredKnowledgeImportOwner(job),
  );
  await persistTree(prisma, job, analysis, version);
  await assertImportContinuing(
    prisma,
    job.id,
    requiredKnowledgeImportOwner(job),
  );
  const vectorCount = await indexVectors(
    prisma,
    {
      libraryId: job.libraryId,
      progressImportId: job.id,
      progressImportOwnerToken: requiredKnowledgeImportOwner(job),
    },
    version.id,
  );
  await finishIndex(prisma, job, version.id, vectorCount);
}

async function releaseReservations(prisma: PrismaClient, job: KnowledgeImportJob) {
  if (
    !job.reservedChunks &&
    !job.reservedPoints &&
    !job.reservedImages &&
    job.reservedMediaBytes === 0n
  ) {
    return;
  }
  const library = await prisma.knowledgeLibrary.findUnique({
    where: { id: job.libraryId },
  });
  const keys = ["GLOBAL"];
  if (library?.scope === KnowledgeLibraryScope.PRIVATE) {
    keys.push("PRIVATE_GLOBAL", `USER:${library.ownerId}`);
  }
  await prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw(Prisma.sql`SELECT id FROM KnowledgeImportJob WHERE id = ${job.id} FOR UPDATE`);
    const current = await transaction.knowledgeImportJob.findUnique({ where: { id: job.id } });
    if (!current || current.status !== KnowledgeImportStatus.PROCESSING ||
        current.leaseOwnerToken !== requiredKnowledgeImportOwner(job)) {
      throw new Error('KNOWLEDGE_IMPORT_LEASE_LOST');
    }
    const released = await transaction.knowledgeImportJob.updateMany({
      where: {
        id: job.id,
        status: KnowledgeImportStatus.PROCESSING,
        leaseOwnerToken: requiredKnowledgeImportOwner(job),
      },
      data: {
        reservedChunks: 0,
        reservedPoints: 0,
        reservedImages: 0,
        reservedMediaBytes: 0,
      },
    });
    if (released.count !== 1) {
      throw new Error("KNOWLEDGE_IMPORT_LEASE_LOST");
    }
    for (const key of keys) {
      await transaction.knowledgeCapacityCounter.updateMany({
        where: { key },
        data: {
          reservedChunks: { decrement: current.reservedChunks },
          reservedPoints: { decrement: current.reservedPoints },
          reservedImages: { decrement: current.reservedImages },
          reservedMediaBytes: { decrement: current.reservedMediaBytes },
        },
      });
    }
  });
}

async function compensate(
  prisma: PrismaClient,
  job: KnowledgeImportJob,
  errorCode: string,
  dependencies: { deleteVersionVectors?: (versionId: string) => Promise<void> } = {},
) {
  let cleanupFailures = 0;
  const ownerToken = requiredKnowledgeImportOwner(job);
  const assertOwned = () => assertImportContinuing(prisma, job.id, ownerToken, true);
  await assertOwned();
  const started = await prisma.knowledgeImportJob.updateMany({
    where: { id: job.id, status: KnowledgeImportStatus.PROCESSING, leaseOwnerToken: ownerToken },
    data: { stage: 'COMPENSATING' },
  });
  if (started.count !== 1) throw new Error('KNOWLEDGE_IMPORT_LEASE_LOST');
  if (activeKnowledgeImport?.id === job.id && activeKnowledgeImport.ownerToken === ownerToken) {
    activeKnowledgeImport.phase = 'compensation';
  }
  if (job.confirmedVersionId) {
    try {
      await withHeartbeat(prisma, job.id, ownerToken, () =>
        (dependencies.deleteVersionVectors ?? deleteKnowledgeVersionVectors)(job.confirmedVersionId!),
      );
      await assertOwned();
    } catch {
      await prisma.knowledgeImportJob.updateMany({
        where: { id: job.id, status: KnowledgeImportStatus.PROCESSING, leaseOwnerToken: ownerToken },
        data: {
          status: KnowledgeImportStatus.COMPENSATION_FAILED,
          stage: 'COMPENSATION_FAILED', leaseOwnerToken: null, leasedUntil: null,
          completedAt: new Date(), errorCode: 'COMPENSATION_FAILED',
          errorMessage: '向量清理未确认，保留版本和容量预约，请重试补偿清理',
        },
      });
      return;
    }
  }
  const assets = await prisma.knowledgeImportAsset.findMany({
    where: { importId: job.id },
  });
  const store =
    (process.env.MEDIA_STORAGE_PROVIDER ?? "database") === "cos"
      ? new CosMediaStore(readMediaCosConfig(process.env))
      : null;
  const failedVersion = job.confirmedVersionId
    ? await prisma.knowledgeDocumentVersion.findUnique({
        where: { id: job.confirmedVersionId },
        include: { document: { include: { library: true } } },
      })
    : null;
  if (job.confirmedVersionId) {
    await assertOwned();
    await prisma.knowledgeDocumentVersion.deleteMany({
      where: { id: job.confirmedVersionId },
    });
  }
  for (const asset of assets) {
    await assertOwned();
    try {
      if (asset.photoId) {
        await prisma.$transaction((transaction) =>
          deleteUnusedKnowledgePhoto(transaction, asset.photoId!, [], job.id),
        );
      } else if (store && asset.objectKey) {
        await store.delete(asset.objectKey);
      }
      await prisma.knowledgeImportAsset.update({
        where: { id: asset.id },
        data: {
          status: KnowledgeImportAssetStatus.CLEANED,
          photoId: null,
          objectKey: null,
          cleanupError: null,
        },
      });
    } catch (error) {
      cleanupFailures += 1;
      await prisma.knowledgeImportAsset.update({
        where: { id: asset.id },
        data: {
          status: KnowledgeImportAssetStatus.ORPHANED,
          cleanupError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        },
      });
    }
  }
  if (failedVersion?.version === 1) {
    const keys = capacityKeys(failedVersion.document.library);
    await prisma.$transaction(async (transaction) => {
      for (const key of keys) {
        await transaction.knowledgeCapacityCounter.upsert({
          where: { key },
          create: { key },
          update: {},
        });
      }
      await transaction.$queryRaw(
        Prisma.sql`
          SELECT ${Prisma.raw('`key`')} FROM KnowledgeCapacityCounter
          WHERE ${Prisma.raw('`key`')} IN (${Prisma.join(keys)}) FOR UPDATE
        `,
      );
      const removed = await transaction.knowledgeDocument.updateMany({
        where: {
          id: failedVersion.documentId,
          activeVersionId: null,
          deletedAt: null,
          versions: { none: {} },
        },
        data: {
          status: 'ARCHIVED',
          indexStatus: IndexStatus.FAILED,
          deletedAt: new Date(),
        },
      });
      if (removed.count === 1) {
        for (const key of keys) {
          await transaction.$executeRaw(
            Prisma.sql`
              UPDATE KnowledgeCapacityCounter
              SET activeDocuments = GREATEST(activeDocuments - 1, 0)
              WHERE ${Prisma.raw('`key`')} = ${key}
            `,
          );
        }
      }
    });
  }
  await assertOwned();
  await releaseReservations(prisma, job);
  const compensated = await prisma.knowledgeImportJob.updateMany({
    where: {
      id: job.id,
      status: KnowledgeImportStatus.PROCESSING,
      leaseOwnerToken: requiredKnowledgeImportOwner(job),
    },
    data: {
      status: cleanupFailures
        ? KnowledgeImportStatus.COMPENSATION_FAILED
        : KnowledgeImportStatus.FAILED,
      stage: cleanupFailures ? "COMPENSATION_FAILED" : "FAILED",
      leaseOwnerToken: null,
      leasedUntil: null,
      completedAt: new Date(),
      errorCode: cleanupFailures ? "COMPENSATION_FAILED" : errorCode,
      errorMessage: cleanupFailures
        ? "知识导入失败且部分对象未清理，请管理员对账处理"
        : "知识导入失败，本任务创建的数据和对象已补偿清理",
      ...(cleanupFailures
        ? {}
        : {
            sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
            sourceCleanupNextAttemptAt: new Date(),
          }),
    },
  });
  if (compensated.count !== 1) {
    throw new Error("KNOWLEDGE_IMPORT_LEASE_LOST");
  }
}

async function withHeartbeat<T>(
  prisma: PrismaClient,
  jobId: string,
  ownerToken: string,
  action: () => Promise<T>,
) {
  let leaseLost = false;
  const timer = setInterval(() => {
    void prisma.knowledgeImportJob.updateMany({
      where: {
        id: jobId,
        leaseOwnerToken: ownerToken,
        status: {
          in: [KnowledgeImportStatus.PREFLIGHTING, KnowledgeImportStatus.PROCESSING],
        },
      },
      data: { leasedUntil: leaseUntil() },
    }).then((result) => {
      if (result.count !== 1) leaseLost = true;
    }).catch(() => {
      leaseLost = true;
    });
  }, HEARTBEAT_MS);
  timer.unref();
  try {
    const result = await action();
    if (leaseLost) throw new Error("KNOWLEDGE_IMPORT_LEASE_LOST");
    return result;
  } finally {
    clearInterval(timer);
  }
}

export async function acquireKnowledgeImportJob(prisma: PrismaClient) {
  const now = new Date();
  const candidate = await prisma.knowledgeImportJob.findFirst({
    where: {
      OR: [
        { status: KnowledgeImportStatus.PREFLIGHT_PENDING },
        { status: KnowledgeImportStatus.PREFLIGHTING, leasedUntil: { lt: now } },
        { status: KnowledgeImportStatus.PREFLIGHTING, leasedUntil: null },
        { status: KnowledgeImportStatus.INDEX_PENDING },
        { status: KnowledgeImportStatus.PROCESSING, leasedUntil: { lt: now } },
        { status: KnowledgeImportStatus.PROCESSING, leasedUntil: null },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;
  const ownerToken = randomUUID();
  const phase: ImportPhase =
    candidate.stage === "COMPENSATION_RETRY" ||
    candidate.stage === "COMPENSATING"
      ? "compensation"
      : candidate.status === KnowledgeImportStatus.PREFLIGHT_PENDING ||
          candidate.status === KnowledgeImportStatus.PREFLIGHTING
        ? "preflight"
        : "index";
  const pending =
    phase === "preflight"
      ? KnowledgeImportStatus.PREFLIGHT_PENDING
      : KnowledgeImportStatus.INDEX_PENDING;
  const processing =
    phase === "preflight"
      ? KnowledgeImportStatus.PREFLIGHTING
      : KnowledgeImportStatus.PROCESSING;
  const claimed = await prisma.knowledgeImportJob.updateMany({
    where: {
      id: candidate.id,
      OR: [
        { status: pending },
        { status: processing, leasedUntil: { lt: now } },
        { status: processing, leasedUntil: null },
      ],
    },
    data: {
      status: processing,
      stage:
        phase === "preflight"
          ? "VALIDATING_PACKAGE"
          : phase === "compensation"
            ? "COMPENSATING"
            : "VALIDATING_AGAIN",
      attempts: { increment: 1 },
      leaseOwnerToken: ownerToken,
      leasedUntil: leaseUntil(),
      errorCode: null,
      errorMessage: null,
    },
  });
  if (claimed.count !== 1) return null;
  const job = await prisma.knowledgeImportJob.findUnique({
    where: { id: candidate.id },
  });
  return job?.leaseOwnerToken === ownerToken && job.status === processing
    ? { job, phase }
    : null;
}

export async function expireKnowledgeImports(
  prisma: PrismaClient,
  now = new Date(),
) {
  const expired = await prisma.knowledgeImportJob.findMany({
    where: {
      status: KnowledgeImportStatus.AWAITING_CONFIRMATION,
      expiresAt: { lt: now },
    },
    take: 20,
  });
  for (const job of expired) {
    const changed = await prisma.knowledgeImportJob.updateMany({
      where: {
        id: job.id,
        status: KnowledgeImportStatus.AWAITING_CONFIRMATION,
        expiresAt: { lt: now },
      },
      data: {
        status: KnowledgeImportStatus.EXPIRED,
        stage: "EXPIRED",
        completedAt: now,
        sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
        sourceCleanupNextAttemptAt: now,
      },
    });
  }
}

export async function processKnowledgeImportSourceCleanup(
  prisma: PrismaClient,
  now = new Date(),
) {
  const [retained] = await prisma.knowledgeImportJob.findMany({
    where: {
      sourceCleanupStatus: ImportSourceCleanupStatus.RETAINED,
      status: {
        in: [
          KnowledgeImportStatus.INVALID,
          KnowledgeImportStatus.READY,
          KnowledgeImportStatus.FAILED,
          KnowledgeImportStatus.EXPIRED,
        ],
      },
    },
    select: { id: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 1,
  });
  if (retained) {
    await prisma.knowledgeImportJob.updateMany({
      where: {
        id: retained.id,
        sourceCleanupStatus: ImportSourceCleanupStatus.RETAINED,
        status: {
          in: [
            KnowledgeImportStatus.INVALID,
            KnowledgeImportStatus.READY,
            KnowledgeImportStatus.FAILED,
            KnowledgeImportStatus.EXPIRED,
          ],
        },
      },
      data: {
        sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
        sourceCleanupNextAttemptAt: now,
      },
    });
  }
  const candidate = await prisma.knowledgeImportJob.findFirst({
    where: {
      sourceCleanupAttempts: { lt: 5 },
      OR: [
        { sourceCleanupStatus: ImportSourceCleanupStatus.PENDING },
        {
          sourceCleanupStatus: ImportSourceCleanupStatus.FAILED,
          sourceCleanupNextAttemptAt: { lte: now },
        },
        {
          sourceCleanupStatus: ImportSourceCleanupStatus.IN_PROGRESS,
          sourceCleanupNextAttemptAt: { lte: now },
        },
      ],
    },
    orderBy: [{ sourceCleanupNextAttemptAt: "asc" }, { createdAt: "asc" }],
  });
  if (!candidate) return false;
  const claimed = await prisma.knowledgeImportJob.updateMany({
    where: {
      id: candidate.id,
      sourceCleanupAttempts: candidate.sourceCleanupAttempts,
      sourceCleanupStatus: candidate.sourceCleanupStatus,
    },
    data: {
      sourceCleanupStatus: ImportSourceCleanupStatus.IN_PROGRESS,
      sourceCleanupAttempts: { increment: 1 },
      sourceCleanupNextAttemptAt: new Date(now.getTime() + 5 * 60_000),
      sourceCleanupError: null,
    },
  });
  if (claimed.count !== 1) return false;
  const attempt = candidate.sourceCleanupAttempts + 1;
  try {
    await removeLocalObject(candidate.sourceObjectKey);
    await prisma.knowledgeImportJob.updateMany({
      where: {
        id: candidate.id,
        sourceCleanupStatus: ImportSourceCleanupStatus.IN_PROGRESS,
        sourceCleanupAttempts: attempt,
      },
      data: {
        sourceCleanupStatus: ImportSourceCleanupStatus.CLEANED,
        sourceCleanupNextAttemptAt: null,
        sourceCleanupError: null,
        sourceCleanedAt: new Date(),
      },
    });
  } catch (error) {
    const failed = await prisma.knowledgeImportJob.updateMany({
      where: {
        id: candidate.id,
        sourceCleanupStatus: ImportSourceCleanupStatus.IN_PROGRESS,
        sourceCleanupAttempts: attempt,
      },
      data: {
        sourceCleanupStatus: ImportSourceCleanupStatus.FAILED,
        sourceCleanupNextAttemptAt:
          attempt < 5
            ? new Date(now.getTime() + Math.min(60, 2 ** attempt) * 60_000)
            : null,
        sourceCleanupError: (error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 2_000),
      },
    });
    if (failed.count === 1) console.error(
      JSON.stringify({
        event:
          attempt >= 5
            ? "knowledge.orphan-object"
            : "knowledge.import.source-cleanup-failed",
        importId: candidate.id,
        attempt,
      }),
    );
  }
  return true;
}

export async function processNextKnowledgeImport(prisma: PrismaClient) {
  await processKnowledgeImportSourceCleanup(prisma);
  await expireKnowledgeImports(prisma);
  const acquired = await acquireKnowledgeImportJob(prisma);
  if (!acquired) return false;
  const { job, phase } = acquired;
  if (!job.leaseOwnerToken) {
    throw new Error("KNOWLEDGE_IMPORT_OWNER_TOKEN_MISSING");
  }
  const ownerToken = job.leaseOwnerToken;
  activeKnowledgeImport = { id: job.id, phase, ownerToken };
  try {
    if (phase === "preflight" && job.cancelRequestedAt) {
      await prisma.knowledgeImportJob.updateMany({
        where: {
          id: job.id,
          status: KnowledgeImportStatus.PREFLIGHTING,
          leaseOwnerToken: ownerToken,
        },
        data: {
          status: KnowledgeImportStatus.EXPIRED,
          stage: "CANCELLED",
          leaseOwnerToken: null,
          leasedUntil: null,
          completedAt: new Date(),
          sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
          sourceCleanupNextAttemptAt: new Date(),
        },
      });
    } else if (phase === "index" && job.cancelRequestedAt) {
      await compensate(prisma, job, "IMPORT_CANCELLED");
    } else if (phase === "preflight") await runKnowledgeImportPreflight(prisma, job);
    else if (phase === "compensation") {
      await compensate(prisma, job, "COMPENSATION_RETRY");
    } else await runKnowledgeImportIndex(prisma, job);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Knowledge import ${phase} ${job.id} failed: ${message}`);
    const current = await prisma.knowledgeImportJob.findUnique({ where: { id: job.id } });
    if (
      current &&
      phase === "preflight" &&
      current.cancelRequestedAt &&
      current.leaseOwnerToken === ownerToken
    ) {
      await prisma.knowledgeImportJob.updateMany({
        where: {
          id: job.id,
          status: KnowledgeImportStatus.PREFLIGHTING,
          leaseOwnerToken: ownerToken,
          cancelRequestedAt: { not: null },
        },
        data: {
          status: KnowledgeImportStatus.EXPIRED,
          stage: "CANCELLED",
          leaseOwnerToken: null,
          leasedUntil: null,
          completedAt: new Date(),
          sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
          sourceCleanupNextAttemptAt: new Date(),
        },
      });
    } else if (
      current &&
      phase === "index" &&
      current.cancelRequestedAt &&
      current.leaseOwnerToken === ownerToken
    ) {
      await compensate(
        prisma,
        { ...current, leaseOwnerToken: ownerToken },
        "IMPORT_CANCELLED",
      );
    } else if (
      current &&
      phase === "compensation" &&
      current.leaseOwnerToken === ownerToken
    ) {
      await prisma.knowledgeImportJob.updateMany({
        where: {
          id: job.id,
          status: KnowledgeImportStatus.PROCESSING,
          leaseOwnerToken: ownerToken,
        },
        data: {
          status: KnowledgeImportStatus.COMPENSATION_FAILED,
          stage: "COMPENSATION_FAILED",
          leaseOwnerToken: null,
          leasedUntil: null,
          completedAt: new Date(),
          errorCode: "COMPENSATION_FAILED",
          errorMessage: "补偿清理重试失败，请检查对象存储后再次重试",
        },
      });
    } else if (
      current &&
      current.leaseOwnerToken === ownerToken &&
      current.attempts < 3
    ) {
      await prisma.knowledgeImportJob.updateMany({
        where: {
          id: job.id,
          status:
            phase === "preflight"
              ? KnowledgeImportStatus.PREFLIGHTING
              : KnowledgeImportStatus.PROCESSING,
          leaseOwnerToken: ownerToken,
        },
        data: {
          status:
            phase === "preflight"
              ? KnowledgeImportStatus.PREFLIGHT_PENDING
              : KnowledgeImportStatus.INDEX_PENDING,
          stage: "RETRY_PENDING",
          leaseOwnerToken: null,
          leasedUntil: null,
          errorCode: "TRANSIENT_FAILURE",
          errorMessage: "任务处理暂时失败，正在自动重试",
        },
      });
    } else if (
      current?.leaseOwnerToken === ownerToken &&
      phase === "preflight"
    ) {
      await prisma.knowledgeImportJob.updateMany({
        where: {
          id: job.id,
          status: KnowledgeImportStatus.PREFLIGHTING,
          leaseOwnerToken: ownerToken,
        },
        data: {
          status: KnowledgeImportStatus.FAILED,
          stage: "FAILED",
          leaseOwnerToken: null,
          leasedUntil: null,
          completedAt: new Date(),
          errorCode: "PREFLIGHT_FAILED",
          errorMessage: "知识包预检失败，请重新上传",
          sourceCleanupStatus: ImportSourceCleanupStatus.PENDING,
          sourceCleanupNextAttemptAt: new Date(),
        },
      });
    } else if (current?.leaseOwnerToken === ownerToken) {
      await compensate(
        prisma,
        { ...current, leaseOwnerToken: ownerToken },
        message.slice(0, 80),
      );
    }
  } finally {
    activeKnowledgeImport = null;
  }
  return true;
}

async function assertImportContinuing(
  prisma: PrismaClient,
  importId: string,
  ownerToken?: string,
  allowCancellation = false,
) {
  const current = await prisma.knowledgeImportJob.findUnique({
    where: { id: importId },
    select: { status: true, cancelRequestedAt: true, leaseOwnerToken: true },
  });
  if (
    !current ||
    (!allowCancellation && current.cancelRequestedAt) ||
    (ownerToken !== undefined && current.leaseOwnerToken !== ownerToken) ||
    current.status !== KnowledgeImportStatus.PROCESSING
  ) {
    throw new Error("IMPORT_CANCELLED");
  }
}

export async function releaseActiveKnowledgeImport(prisma: PrismaClient) {
  const active = activeKnowledgeImport;
  if (!active) return;
  await prisma.knowledgeImportJob.updateMany({
    where: {
      id: active.id,
      leaseOwnerToken: active.ownerToken,
      status:
        active.phase === "preflight"
          ? KnowledgeImportStatus.PREFLIGHTING
          : KnowledgeImportStatus.PROCESSING,
    },
    data: {
      status:
        active.phase === "preflight"
          ? KnowledgeImportStatus.PREFLIGHT_PENDING
          : KnowledgeImportStatus.INDEX_PENDING,
      stage:
        active.phase === "compensation"
          ? "COMPENSATION_RETRY"
          : "RETRY_PENDING",
      leaseOwnerToken: null,
      leasedUntil: null,
    },
  });
}

export async function processKnowledgeIndexOperation(
  prisma: PrismaClient,
  job: IndexJob,
  dependencies: { deleteVersionVectors?: (versionId: string) => Promise<void> } = {},
) {
  if (!job.leaseOwnerToken) throw new Error("INDEX_JOB_OWNER_TOKEN_MISSING");
  const ownerToken = job.leaseOwnerToken;
  if (job.operation === "INDEX_VERSION") {
    if (!job.documentVersionId) throw new Error("INDEX_VERSION_ID_MISSING");
    if (job.stage === 'CAPACITY_CLEANUP_PENDING' || job.attempts > 3) {
      await compensateFailedKnowledgeIndex(prisma, job, job.error ?? 'INDEX_FAILED', dependencies);
      return;
    }
    if (job.stage !== 'CAPACITY_RESERVED') {
      throw new Error('INDEX_VERSION_CAPACITY_NOT_RESERVED');
    }
    const version = await prisma.knowledgeDocumentVersion.findUnique({
      where: { id: job.documentVersionId },
      include: {
        document: { include: { library: true } },
      },
    });
    if (!version || version.document.deletedAt) {
      await compensateFailedKnowledgeIndex(prisma, job, 'DOCUMENT_DELETED', dependencies);
      return;
    }
    const parse = parseKnowledgeMarkdown(version.markdown, {
      allowImages: version.imageCount > 0,
    });
    if (
      parse.issues.some((item) => item.severity === "ERROR") ||
      parse.contentHash !== version.contentHash ||
      parse.chunkCount !== version.chunkCount ||
      version.parserVersion !== KNOWLEDGE_PARSER_VERSION ||
      version.chunkerVersion !== KNOWLEDGE_CHUNKER_VERSION ||
      version.renderBlockVersion !== KNOWLEDGE_RENDER_BLOCK_VERSION
    ) {
      throw new Error("REINDEX_PARSE_MISMATCH");
    }
    const sourceImages = version.document.activeVersionId
      ? await prisma.knowledgeVersionImage.findMany({
          where: { documentVersionId: version.document.activeVersionId },
        })
      : [];
    const sourceByPath = new Map(sourceImages.map((image) => [image.entryPath, image]));
    for (const image of [
      ...new Map(parse.images.map((item) => [item.entryPath, item])).values(),
    ]) {
      const source = sourceByPath.get(image.entryPath);
      if (!source || source.altText !== image.altText) {
        throw new Error("REINDEX_IMAGE_SOURCE_MISSING");
      }
      const id = deterministicUuid(
        "knowledge-version-image",
        version.id,
        image.entryPath,
      );
      await prisma.knowledgeVersionImage.upsert({
        where: { id },
        create: {
          id,
          documentVersionId: version.id,
          photoId: source.photoId,
          entryPath: source.entryPath,
          contentHash: source.contentHash,
          altText: source.altText,
          sortOrder: source.sortOrder,
        },
        update: {},
      });
    }
    const analysis: ImportAnalysis = {
      parse,
      issues: [],
      sourcePath: "",
      imageMetadata: new Map(),
    };
    await persistTree(
      prisma,
      { libraryId: version.document.libraryId },
      analysis,
      version,
    );
    const vectorCount = await indexVectors(
      prisma,
      {
        libraryId: version.document.libraryId,
        progressIndexJobId: job.id,
        progressIndexOwnerToken: ownerToken,
      },
      version.id,
    );
    const counterKeys = capacityKeys(version.document.library);
    await prisma.$transaction(async (transaction) => {
      const completed = await transaction.indexJob.updateMany({
        where: {
          id: job.id,
          status: IndexStatus.PROCESSING,
          leaseOwnerToken: ownerToken,
        },
        data: {
          status: IndexStatus.READY,
          stage: "READY",
          progressCurrent: vectorCount,
          progressTotal: vectorCount,
          leaseOwnerToken: null,
          leasedUntil: null,
          error: null,
        },
      });
      if (completed.count !== 1) throw new Error("INDEX_JOB_LEASE_LOST");
      await transaction.knowledgeDocumentVersion.update({
        where: { id: version.id },
        data: {
          indexStatus: IndexStatus.READY,
          vectorCount,
          indexedAt: new Date(),
          error: null,
        },
      });
      for (const key of counterKeys) {
        await transaction.knowledgeCapacityCounter.update({
          where: { key },
          data: {
            activeChunks: { increment: version.chunkCount },
            livePoints: { increment: vectorCount },
            reservedChunks: { decrement: version.chunkCount },
            reservedPoints: { decrement: version.chunkCount },
          },
        });
      }
    });
    return;
  }

  if (job.operation === "SYNC_VERSION_ACTIVITY") {
    const runtime = await qdrant();
    const document = await prisma.knowledgeDocument.findUnique({
      where: { id: job.documentId },
      select: { activeVersionId: true, deletedAt: true },
    });
    await assertIndexJobOwner(prisma, job.id, ownerToken);
    await runtime.client.setPayload(runtime.collection, {
      wait: true,
      payload: { active: false },
      filter: {
        must: [{ key: "documentId", match: { value: job.documentId } }],
      },
    });
    await assertIndexJobOwner(prisma, job.id, ownerToken);
    if (document?.activeVersionId && !document.deletedAt) {
      await runtime.client.setPayload(runtime.collection, {
        wait: true,
        payload: { active: true },
        filter: {
          must: [
            {
              key: "documentVersionId",
              match: { value: document.activeVersionId },
            },
          ],
        },
      });
      await assertIndexJobOwner(prisma, job.id, ownerToken);
    }
    const completed = await prisma.indexJob.updateMany({
      where: {
        id: job.id,
        status: IndexStatus.PROCESSING,
        leaseOwnerToken: ownerToken,
      },
      data: {
        status: IndexStatus.READY,
        stage: "READY",
        leaseOwnerToken: null,
        leasedUntil: null,
        error: null,
      },
    });
    if (completed.count !== 1) throw new Error("INDEX_JOB_LEASE_LOST");
    return;
  }

  const runtime = await qdrant();
  if (job.operation === "DELETE_VERSION_VECTORS") {
    if (!job.documentVersionId) throw new Error("DELETE_VERSION_ID_MISSING");
    const active = await prisma.knowledgeDocument.count({
      where: { id: job.documentId, activeVersionId: job.documentVersionId },
    });
    if (active) throw new Error("ACTIVE_VERSION_DELETE_BLOCKED");
    await assertNoReservedVersionIndexes(prisma, { id: job.documentVersionId });
    await assertIndexJobOwner(prisma, job.id, ownerToken);
    await runtime.client.delete(runtime.collection, {
      wait: true,
      filter: {
        must: [
          { key: "documentVersionId", match: { value: job.documentVersionId } },
        ],
      },
    });
    await assertIndexJobOwner(prisma, job.id, ownerToken);
    const version = await prisma.knowledgeDocumentVersion.findUnique({
      where: { id: job.documentVersionId },
      include: { document: { include: { library: true } } },
    });
    if (version) {
      await cleanupKnowledgePhotos(
        prisma,
        [job.documentVersionId],
        version.document.library,
      );
      await finalizeVectorDeletion(
        prisma,
        job.id,
        ownerToken,
        version.document.library,
        { id: job.documentVersionId },
        version.indexStatus === IndexStatus.READY
          ? { chunkCount: version.chunkCount, pointCount: version.vectorCount }
          : { chunkCount: 0, pointCount: 0 },
      );
    } else {
      await prisma.indexJob.deleteMany({
        where: {
          id: job.id,
          status: IndexStatus.PROCESSING,
          leaseOwnerToken: ownerToken,
        },
      });
    }
    return;
  }

  if (job.operation === "DELETE_DOCUMENT_VECTORS") {
    await assertNoReservedVersionIndexes(prisma, { documentId: job.documentId });
    const document = await prisma.knowledgeDocument.findUnique({
      where: { id: job.documentId },
      include: { library: true },
    });
    const versions = await prisma.knowledgeDocumentVersion.findMany({
      where: { documentId: job.documentId },
      include: { document: { include: { library: true } } },
    });
    await assertIndexJobOwner(prisma, job.id, ownerToken);
    await runtime.client.delete(runtime.collection, {
      wait: true,
      filter: {
        must: [{ key: "documentId", match: { value: job.documentId } }],
      },
    });
    await assertIndexJobOwner(prisma, job.id, ownerToken);
    if (!document) {
      await prisma.indexJob.deleteMany({
        where: {
          id: job.id,
          status: IndexStatus.PROCESSING,
          leaseOwnerToken: ownerToken,
        },
      });
      return;
    }
    await cleanupKnowledgePhotos(
      prisma,
      versions.map((version) => version.id),
      document.library,
    );
    const ready = versions.filter(
      (version) => version.indexStatus === IndexStatus.READY,
    );
    await finalizeVectorDeletion(
      prisma,
      job.id,
      ownerToken,
      document.library,
      { documentId: job.documentId },
      {
        documentCount: 1,
        chunkCount: ready.reduce((total, version) => total + version.chunkCount, 0),
        pointCount: ready.reduce((total, version) => total + version.vectorCount, 0),
      },
    );
    return;
  }
  throw new Error("UNSUPPORTED_INDEX_OPERATION");
}

export class KnowledgeIndexDependencyPendingError extends Error {}

const INDEX_CAPACITY_STAGES = ['CAPACITY_RESERVED', 'CAPACITY_CLEANUP_PENDING'];
const INDEX_CLEANUP_RETRY_MS = 60_000;

export function knowledgeIndexJobEligibility(now: Date): Prisma.IndexJobWhereInput {
  return {
    status: { in: [IndexStatus.PENDING, IndexStatus.PROCESSING] },
    OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
  };
}

export async function handleKnowledgeIndexFailure(
  prisma: PrismaClient,
  job: IndexJob,
  error: unknown,
  dependencies: { deleteVersionVectors?: (versionId: string) => Promise<void> } = {},
) {
  const message = error instanceof Error ? error.message : String(error);
  if (job.operation === 'INDEX_VERSION' &&
      (job.attempts >= 3 || job.stage === 'CAPACITY_CLEANUP_PENDING')) {
    await compensateFailedKnowledgeIndex(prisma, job, message, dependencies);
    return;
  }
  const waiting = error instanceof KnowledgeIndexDependencyPendingError;
  const retry = waiting || job.attempts < 3;
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.indexJob.updateMany({
      where: { id: job.id, status: IndexStatus.PROCESSING, leaseOwnerToken: job.leaseOwnerToken },
      data: {
        status: retry ? IndexStatus.PENDING : IndexStatus.FAILED,
        leaseOwnerToken: null,
        leasedUntil: waiting ? new Date(Date.now() + INDEX_CLEANUP_RETRY_MS) : null,
        error: message,
      },
    });
    if (updated.count !== 1) return;
    if (job.operation === 'INDEX_VERSION' && job.documentVersionId) {
      await transaction.knowledgeDocumentVersion.updateMany({
        where: { id: job.documentVersionId },
        data: {
          indexStatus: retry ? IndexStatus.PENDING : IndexStatus.FAILED,
          error: retry ? null : message,
        },
      });
    }
  });
}

export async function compensateFailedKnowledgeIndex(
  prisma: PrismaClient,
  job: IndexJob,
  message: string,
  dependencies: { deleteVersionVectors?: (versionId: string) => Promise<void> } = {},
) {
  if (job.operation !== 'INDEX_VERSION' || !job.documentVersionId) return false;
  if (!job.leaseOwnerToken) throw new Error('INDEX_JOB_OWNER_TOKEN_MISSING');
  const ownerToken = job.leaseOwnerToken;
  const version = await prisma.$transaction(async (transaction) => {
    const claimed = await transaction.indexJob.updateMany({
      where: {
        id: job.id,
        status: IndexStatus.PROCESSING,
        stage: { in: INDEX_CAPACITY_STAGES },
        leaseOwnerToken: ownerToken,
      },
      data: { stage: 'CAPACITY_CLEANUP_PENDING', error: message },
    });
    if (claimed.count !== 1) return null;
    const current = await transaction.knowledgeDocumentVersion.findUnique({
      where: { id: job.documentVersionId! },
      include: { document: { include: { library: true } } },
    });
    if (!current) throw new Error('INDEX_COMPENSATION_VERSION_MISSING');
    if (current.document.activeVersionId === current.id || current.indexStatus === IndexStatus.READY) {
      throw new Error('ACTIVE_VERSION_COMPENSATION_BLOCKED');
    }
    await transaction.knowledgeDocumentVersion.updateMany({
      where: { id: current.id },
      data: { indexStatus: IndexStatus.FAILED, error: message },
    });
    return current;
  });
  if (!version) return false;
  try {
    await assertIndexJobOwner(prisma, job.id, ownerToken);
    if (dependencies.deleteVersionVectors) {
      await dependencies.deleteVersionVectors(version.id);
    } else {
      await deleteKnowledgeVersionVectors(version.id);
    }
    await prisma.$transaction(async (transaction) => {
      const released = await transaction.indexJob.updateMany({
        where: {
          id: job.id, status: IndexStatus.PROCESSING,
          stage: 'CAPACITY_CLEANUP_PENDING', leaseOwnerToken: ownerToken,
        },
        data: {
          status: IndexStatus.FAILED, stage: 'CAPACITY_RELEASED',
          leaseOwnerToken: null, leasedUntil: null,
        },
      });
      if (released.count !== 1) throw new Error('INDEX_JOB_LEASE_LOST');
      for (const key of capacityKeys(version.document.library)) {
        await transaction.$executeRaw(Prisma.sql`
          UPDATE KnowledgeCapacityCounter
          SET reservedChunks = GREATEST(reservedChunks - ${version.chunkCount}, 0),
              reservedPoints = GREATEST(reservedPoints - ${version.chunkCount}, 0)
          WHERE ${Prisma.raw('`key`')} = ${key}
        `);
      }
      await transaction.knowledgeDocumentVersion.updateMany({
        where: { id: version.id },
        data: { indexStatus: IndexStatus.FAILED, vectorCount: 0 },
      });
    });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await prisma.indexJob.updateMany({
      where: {
        id: job.id, status: IndexStatus.PROCESSING,
        stage: 'CAPACITY_CLEANUP_PENDING', leaseOwnerToken: ownerToken,
      },
      data: {
        status: IndexStatus.PENDING, leaseOwnerToken: null,
        leasedUntil: new Date(Date.now() + INDEX_CLEANUP_RETRY_MS),
        error: `${message.slice(0, 1000)}; vector cleanup pending: ${detail.slice(0, 500)}`,
      },
    });
    return false;
  }
}

async function deleteKnowledgeVersionVectors(versionId: string, suppliedRuntime?: QdrantRuntime) {
  const runtime = suppliedRuntime ?? await qdrant();
  const result = await runtime.client.delete(runtime.collection, {
    wait: true,
    filter: { must: [{ key: 'documentVersionId', match: { value: versionId } }] },
  });
  if (result.status !== 'completed') throw new Error('VECTOR_DELETION_NOT_CONFIRMED');
}

async function assertNoReservedVersionIndexes(
  prisma: PrismaClient,
  versionWhere: Prisma.KnowledgeDocumentVersionWhereInput,
) {
  const reservedWhere: Prisma.IndexJobWhereInput = {
    operation: 'INDEX_VERSION',
    stage: { in: INDEX_CAPACITY_STAGES },
    documentVersion: { is: versionWhere },
  };
  if (!await prisma.indexJob.count({ where: reservedWhere })) return;
  // Preserve the version and reservation record until its own cleanup is confirmed.
  await prisma.indexJob.updateMany({
    where: {
      ...reservedWhere,
      stage: 'CAPACITY_RESERVED',
      OR: [
        { status: { not: IndexStatus.PROCESSING } },
        { leasedUntil: null },
        { leasedUntil: { lt: new Date() } },
      ],
    },
    data: {
      status: IndexStatus.PENDING, stage: 'CAPACITY_CLEANUP_PENDING',
      leaseOwnerToken: null, leasedUntil: null,
    },
  });
  throw new KnowledgeIndexDependencyPendingError('INDEX_VERSION_COMPENSATION_PENDING');
}

function capacityKeys(library: {
  scope: KnowledgeLibraryScope;
  ownerId: string | null;
}) {
  const keys = ["GLOBAL"];
  if (library.scope === KnowledgeLibraryScope.PRIVATE) {
    keys.push("PRIVATE_GLOBAL", `USER:${library.ownerId}`);
  }
  return keys;
}

async function finalizeVectorDeletion(
  prisma: PrismaClient,
  jobId: string,
  ownerToken: string,
  library: { scope: KnowledgeLibraryScope; ownerId: string | null },
  versionWhere: Prisma.KnowledgeDocumentVersionWhereInput,
  delta: {
    documentCount?: number;
    chunkCount: number;
    pointCount: number;
  },
) {
  const keys = capacityKeys(library);
  await prisma.$transaction(async (transaction) => {
    const pending = await transaction.indexJob.count({
      where: {
        operation: 'INDEX_VERSION', stage: { in: INDEX_CAPACITY_STAGES },
        documentVersion: { is: versionWhere },
      },
    });
    if (pending) throw new KnowledgeIndexDependencyPendingError('INDEX_VERSION_COMPENSATION_PENDING');
    const removed = await transaction.indexJob.deleteMany({
      where: {
        id: jobId,
        status: IndexStatus.PROCESSING,
        leaseOwnerToken: ownerToken,
      },
    });
    if (removed.count !== 1) throw new Error("INDEX_JOB_LEASE_LOST");
    for (const key of keys) {
      await transaction.knowledgeCapacityCounter.upsert({
        where: { key },
        create: { key },
        update: {},
      });
    }
    await transaction.$queryRaw(
      Prisma.sql`
        SELECT ${Prisma.raw('`key`')} FROM KnowledgeCapacityCounter
        WHERE ${Prisma.raw('`key`')} IN (${Prisma.join(keys)}) FOR UPDATE
      `,
    );
    await transaction.knowledgeDocumentVersion.deleteMany({
      where: versionWhere,
    });
    for (const key of keys) {
      await transaction.$executeRaw(
        Prisma.sql`
          UPDATE KnowledgeCapacityCounter
          SET activeDocuments = GREATEST(activeDocuments - ${delta.documentCount ?? 0}, 0),
              activeChunks = GREATEST(activeChunks - ${delta.chunkCount}, 0),
              livePoints = GREATEST(livePoints - ${delta.pointCount}, 0)
          WHERE ${Prisma.raw('`key`')} = ${key}
        `,
      );
    }
  });
}

async function assertIndexJobOwner(
  prisma: PrismaClient,
  jobId: string,
  ownerToken: string,
) {
  const owned = await prisma.indexJob.count({
    where: {
      id: jobId,
      status: IndexStatus.PROCESSING,
      leaseOwnerToken: ownerToken,
    },
  });
  if (owned !== 1) throw new Error("INDEX_JOB_LEASE_LOST");
}

async function cleanupKnowledgePhotos(
  prisma: PrismaClient,
  documentVersionIds: string[],
  library: { scope: KnowledgeLibraryScope; ownerId: string | null },
) {
  if (!documentVersionIds.length) return;
  const links = await prisma.knowledgeVersionImage.findMany({
    where: { documentVersionId: { in: documentVersionIds } },
    select: { photoId: true },
  });
  const photoIds = [...new Set(links.map((link) => link.photoId))];
  for (const photoId of photoIds) {
    try {
      const keys = capacityKeys(library);
      await prisma.$transaction(async (transaction) => {
        const photo = await deleteUnusedKnowledgePhoto(transaction, photoId, documentVersionIds);
        if (!photo) return;
        for (const key of keys) {
          await transaction.knowledgeCapacityCounter.upsert({
            where: { key },
            create: { key },
            update: {},
          });
        }
        await transaction.$queryRaw(
          Prisma.sql`
            SELECT ${Prisma.raw('`key`')} FROM KnowledgeCapacityCounter
            WHERE ${Prisma.raw('`key`')} IN (${Prisma.join(keys)}) FOR UPDATE
          `,
        );
        for (const key of keys) {
          await transaction.$executeRaw(
            Prisma.sql`
              UPDATE KnowledgeCapacityCounter
              SET imageCount = GREATEST(imageCount - 1, 0),
                  mediaBytes = GREATEST(mediaBytes - ${BigInt(photo.size)}, 0)
              WHERE ${Prisma.raw('`key`')} = ${key}
            `,
          );
        }
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "knowledge.image-cleanup-failed",
          photoId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      throw error;
    }
  }
}

async function deleteUnusedKnowledgePhoto(
  transaction: Prisma.TransactionClient,
  photoId: string,
  documentVersionIds: string[],
  importId?: string,
) {
  await transaction.$queryRaw(Prisma.sql`SELECT id FROM Photo WHERE id = ${photoId} FOR UPDATE`);
  const photo = await transaction.photo.findUnique({
    where: { id: photoId },
    select: {
      objectKey: true, size: true, albumId: true,
      original: { select: { objectKey: true } },
      news: { select: { newsId: true }, take: 1 },
      quizQuestions: { select: { questionId: true }, take: 1 },
      knowledgeImages: { select: { documentVersionId: true } },
      knowledgeImportAssets: { select: { id: true, importId: true } },
    },
  });
  if (!photo || photo.albumId || photo.news.length || photo.quizQuestions.length ||
      photo.knowledgeImages.some((link) => !documentVersionIds.includes(link.documentVersionId)) ||
      (importId && photo.knowledgeImportAssets.some((asset) => asset.importId !== importId))) {
    return null;
  }
  const objectKeys = [...new Set([photo.objectKey, photo.original?.objectKey]
    .filter((key): key is string => Boolean(key)))];
  if (objectKeys.length) {
    await transaction.mediaObjectOperation.create({
      data: {
        kind: 'PHOTO_DELETE', status: 'CLEANUP_PENDING', photoId,
        manifest: objectKeys.map((key) => ({ key, status: 'PENDING' })),
        nextAttemptAt: new Date(),
      },
    });
  }
  await transaction.knowledgeVersionImage.deleteMany({
    where: { photoId, documentVersionId: { in: documentVersionIds } },
  });
  await transaction.knowledgeImportAsset.updateMany({
    where: { photoId, id: { in: photo.knowledgeImportAssets.map((asset) => asset.id) } },
    data: {
      photoId: null, objectKey: null,
      status: KnowledgeImportAssetStatus.CLEANED, cleanupError: null,
    },
  });
  await transaction.photoOriginal.deleteMany({ where: { photoId } });
  const deleted = await transaction.photo.deleteMany({
    where: {
      id: photoId, albumId: null,
      news: { none: {} }, quizQuestions: { none: {} },
      knowledgeImages: { none: {} }, knowledgeImportAssets: { none: {} },
    },
  });
  if (deleted.count !== 1) throw new Error('PHOTO_DELETE_CONFLICT');
  return photo;
}

function embeddingProvider() {
  const provider = (process.env.EMBEDDING_PROVIDER ?? "mock").trim();
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? "1024");
  const model = (process.env.EMBEDDING_MODEL ?? "embedding-3").trim();
  return createKnowledgeEmbeddingProvider({
    provider,
    dimensions,
    model,
    baseUrl: process.env.EMBEDDING_BASE_URL,
    apiKey: process.env.EMBEDDING_API_KEY,
  });
}

async function qdrant(): Promise<QdrantRuntime> {
  qdrantPromise ??= initializeQdrant();
  const pending = qdrantPromise;
  try {
    return await pending;
  } catch (error) {
    // A transient startup failure must not poison all later readiness probes.
    if (qdrantPromise === pending) qdrantPromise = null;
    throw error;
  }
}

export async function assertKnowledgeVectorReady() {
  await qdrant();
}

async function initializeQdrant(): Promise<QdrantRuntime> {
  const url = requiredEnvironment("QDRANT_URL");
  const apiKey = requiredEnvironment("QDRANT_API_KEY");
  const collection = process.env.QDRANT_COLLECTION?.trim() || DEFAULT_COLLECTION;
  const alias = process.env.QDRANT_COLLECTION_ALIAS?.trim() || DEFAULT_ALIAS;
  const timeout = readPositiveInteger("QDRANT_REQUEST_TIMEOUT_MS", 10_000, 1_000, 60_000);
  const client = new QdrantClient({ url, apiKey, timeout });
  try {
    const info = (await client.getCollection(collection)) as unknown as {
      config?: { params?: { vectors?: { size?: number; distance?: string } } };
    };
    const vectors = info.config?.params?.vectors;
    if (vectors?.size !== 1_024 || String(vectors.distance).toLowerCase() !== "cosine") {
      throw new Error("QDRANT_COLLECTION_SCHEMA_MISMATCH");
    }
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    await client.createCollection(collection, {
      vectors: { size: 1_024, distance: "Cosine" },
    });
  }
  for (const field of [
    "subjectId",
    "libraryId",
    "scope",
    "ownerId",
    "libraryChapterId",
    "documentId",
    "documentVersionId",
    "active",
    "schemaVersion",
    "embeddingModel",
  ]) {
    await client.createPayloadIndex(collection, {
      field_name: field,
      field_schema: field === "active" ? "bool" : "keyword",
      wait: true,
    });
  }
  const aliases = await client.getAliases();
  const currentAlias = (aliases.aliases ?? []).find(
    (item) => item.alias_name === alias,
  );
  if (currentAlias && currentAlias.collection_name !== collection) {
    throw new Error("QDRANT_ALIAS_TARGET_MISMATCH");
  }
  if (!currentAlias) {
    await client.updateCollectionAliases({
      actions: [{ create_alias: { collection_name: collection, alias_name: alias } }],
    });
  }
  const verifiedAliases = await client.getAliases();
  const verified = (verifiedAliases.aliases ?? []).some(
    (item) =>
      item.alias_name === alias && item.collection_name === collection,
  );
  if (!verified) throw new Error("QDRANT_ALIAS_TARGET_MISMATCH");
  return { client, collection };
}

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function readPositiveInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name}_INVALID`);
  }
  return value;
}

async function hashLocalFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function knowledgeImportLimits() {
  return {
    maxMarkdownBytes: readPositiveInteger(
      "KNOWLEDGE_IMPORT_MAX_MARKDOWN_BYTES",
      10 * 1024 * 1024,
      1,
      10 * 1024 * 1024,
    ),
    maxZipBytes: readPositiveInteger(
      "KNOWLEDGE_IMPORT_MAX_ZIP_BYTES",
      200 * 1024 * 1024,
      1,
      200 * 1024 * 1024,
    ),
    maxExpandedBytes: readPositiveInteger(
      "KNOWLEDGE_IMPORT_MAX_EXPANDED_BYTES",
      500 * 1024 * 1024,
      1,
      500 * 1024 * 1024,
    ),
    maxZipRatio: readPositiveInteger(
      "KNOWLEDGE_IMPORT_MAX_ZIP_RATIO",
      100,
      1,
      100,
    ),
    maxImages: readPositiveInteger(
      "KNOWLEDGE_IMPORT_MAX_IMAGES",
      1_000,
      0,
      1_000,
    ),
    maxImageBytes: readPositiveInteger(
      "KNOWLEDGE_IMPORT_MAX_IMAGE_BYTES",
      10 * 1024 * 1024,
      1,
      10 * 1024 * 1024,
    ),
    maxImagePixels: readPositiveInteger(
      "KNOWLEDGE_IMPORT_MAX_IMAGE_PIXELS",
      32_000_000,
      1,
      32_000_000,
    ),
    maxProcessedImageBytes: readPositiveInteger(
      "KNOWLEDGE_IMPORT_MAX_PROCESSED_IMAGE_BYTES",
      300 * 1024,
      1,
      300 * 1024,
    ),
  };
}

export const knowledgeImportInternals = {
  analyzeImport,
  assertLibraryAiAccess,
  assertImportContinuing,
  deterministicVector: deterministicKnowledgeEmbedding,
  embeddingInput,
  indexVectors,
  assertNoReservedVersionIndexes,
  deleteKnowledgeVersionVectors,
  deleteUnusedKnowledgePhoto,
  compensate,
  knowledgeImportLimits,
  resolveH2Replacement,
};
