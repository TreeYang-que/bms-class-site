import {
  IndexStatus,
  KnowledgeIndexOperation,
  KnowledgeKind,
  PrismaClient,
} from "@prisma/client";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import pdfParse from "pdf-parse";
import COS from "cos-nodejs-sdk-v5";
import { iterateChunks, plainText } from "./chunk";
import { extractDocxText } from "./docx";
import { validateWorkerRuntimeConfig } from "./runtime-config";
import { localObjectPath } from "./local-storage";
import { processNextQuizImport, releaseActiveQuizImport } from "./quiz-import";
import {
  processNextKnowledgeImport,
  processKnowledgeIndexOperation,
  assertKnowledgeVectorReady,
  handleKnowledgeIndexFailure,
  knowledgeIndexJobEligibility,
  releaseActiveKnowledgeImport,
} from "./knowledge-import";
import { processNextKnowledgeRenderBackfill } from "./knowledge-render";
import { createKnowledgeReadinessGate } from './knowledge-readiness';
import {
  processNextCurriculumQuestionMapping,
  releaseActiveCurriculumQuestionMappings,
} from './curriculum-matching';
import {
  processNextPracticeStateBackfill,
  releaseActivePracticeStateBackfills,
} from './daily-practice-state-backfill';
import {
  processDailyPracticeSchedulerTick,
  releaseActiveDailySchedulerLeases,
} from './daily-practice-scheduler';
import {
  processNextDailyPracticeGeneration,
  releaseActiveDailyPracticeGeneration,
} from './daily-practice-generation';
import { processLifecycleCleanupBatch } from './lifecycle-cleanup';
import {
  processNextCreditHourReview,
  releaseActiveCreditHourReview,
} from './credit-hour-review';

dotenv.config({ path: resolve(process.cwd(), "../../.env") });
validateWorkerRuntimeConfig(process.env);
const prisma = new PrismaClient();
const cos =
  process.env.STORAGE_PROVIDER === "cos"
    ? new COS({
        SecretId: process.env.COS_SECRET_ID,
        SecretKey: process.env.COS_SECRET_KEY,
      })
    : null;
const MAX_KNOWLEDGE_FILE_BYTES = 200 * 1024 * 1024;
const CHUNK_BATCH_SIZE = 1_000;
const configuredLeaseMs = Number(
  process.env.WORKER_INDEX_LEASE_MS ?? 60 * 60_000,
);
const LEASE_MS =
  Number.isFinite(configuredLeaseMs) && configuredLeaseMs >= 60_000
    ? configuredLeaseMs
    : 60 * 60_000;
const LEASE_HEARTBEAT_MS = Math.max(
  10_000,
  Math.min(60_000, Math.floor(LEASE_MS / 3)),
);
const IDLE_DELAY_MS = 5_000;
const withKnowledgeReady = createKnowledgeReadinessGate(assertKnowledgeVectorReady, {
  retryDelayMs: IDLE_DELAY_MS,
  onUnavailable: () => console.error('Knowledge vector service is not ready; knowledge queues will retry'),
});
const LIFECYCLE_CLEANUP_INTERVAL_MS = readBoundedInteger(
  'LIFECYCLE_CLEANUP_INTERVAL_MS',
  5 * 60_000,
  60_000,
  24 * 60 * 60_000,
);
const LIFECYCLE_CLEANUP_BATCH_SIZE = readBoundedInteger(
  'LIFECYCLE_CLEANUP_BATCH_SIZE',
  100,
  1,
  1_000,
);
const IMPORT_SOURCE_CLEANUP_BATCH_SIZE = readBoundedInteger(
  'IMPORT_SOURCE_CLEANUP_BATCH_SIZE',
  10,
  1,
  100,
);
let activeJob: { id: string; documentId: string; ownerToken: string } | null = null;
let shuttingDown = false;

async function readObject(key: string) {
  if (!cos) {
    return fs.readFile(localObjectPath(key));
  }
  if (!process.env.COS_BUCKET || !process.env.COS_REGION)
    throw new Error("COS 配置不完整");
  return new Promise<Buffer>((resolveObject, reject) => {
    cos.getObject(
      {
        Bucket: process.env.COS_BUCKET!,
        Region: process.env.COS_REGION!,
        Key: key,
      },
      (error, data) => {
        if (error) return reject(error);
        resolveObject(
          Buffer.isBuffer(data.Body)
            ? data.Body
            : Buffer.from(data.Body as string),
        );
      },
    );
  });
}

async function extract(document: {
  kind: KnowledgeKind;
  body: string | null;
  objectKey: string | null;
  fileSize: number;
}) {
  if (document.kind === KnowledgeKind.ARTICLE)
    return plainText(document.body ?? "");
  if (document.fileSize > MAX_KNOWLEDGE_FILE_BYTES)
    throw new Error("资料超过 Worker 支持的 200MB 上限");
  if (!document.objectKey) throw new Error("资料缺少存储对象");
  if (document.kind === KnowledgeKind.DOCX && !cos) {
    return extractDocxText(localObjectPath(document.objectKey));
  }
  const buffer = await readObject(document.objectKey);
  if (document.kind === KnowledgeKind.PDF)
    return (await pdfParse(buffer)).text.trim();
  return extractDocxText(buffer);
}

async function renewLease(jobId: string, ownerToken: string) {
  const renewed = await prisma.indexJob.updateMany({
    where: {
      id: jobId,
      status: IndexStatus.PROCESSING,
      leaseOwnerToken: ownerToken,
    },
    data: { leasedUntil: new Date(Date.now() + LEASE_MS) },
  });
  if (renewed.count !== 1) throw new Error("INDEX_JOB_LEASE_LOST");
}

async function writeLegacyIndexBatch(
  jobId: string,
  documentId: string,
  ownerToken: string,
  batch?: Array<{
    documentId: string;
    chunkIndex: number;
    content: string;
  }>,
) {
  await prisma.$transaction(async (transaction) => {
    const renewed = await transaction.indexJob.updateMany({
      where: {
        id: jobId,
        status: IndexStatus.PROCESSING,
        leaseOwnerToken: ownerToken,
      },
      data: { leasedUntil: new Date(Date.now() + LEASE_MS) },
    });
    if (renewed.count !== 1) throw new Error("INDEX_JOB_LEASE_LOST");
    const document = await transaction.knowledgeDocument.count({
      where: { id: documentId, deletedAt: null },
    });
    if (document !== 1) throw new Error("DOCUMENT_DELETED");
    if (batch) {
      await transaction.knowledgeChunk.createMany({ data: batch });
    } else {
      await transaction.knowledgeChunk.deleteMany({ where: { documentId } });
    }
  });
}

async function withLeaseHeartbeat<T>(
  jobId: string,
  ownerToken: string,
  action: () => Promise<T>,
) {
  const timer = setInterval(() => {
    void renewLease(jobId, ownerToken).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Index lease heartbeat failed for ${jobId}: ${message}`);
    });
  }, LEASE_HEARTBEAT_MS);
  timer.unref();
  try {
    return await action();
  } finally {
    clearInterval(timer);
  }
}

async function acquireJob() {
  const candidate = await prisma.indexJob.findFirst({
    where: knowledgeIndexJobEligibility(new Date()),
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;
  const ownerToken = randomUUID();
  const claimed = await prisma.indexJob.updateMany({
    where: {
      id: candidate.id,
      ...knowledgeIndexJobEligibility(new Date()),
    },
    data: {
      status: IndexStatus.PROCESSING,
      attempts: { increment: 1 },
      leaseOwnerToken: ownerToken,
      leasedUntil: new Date(Date.now() + LEASE_MS),
    },
  });
  if (claimed.count !== 1) return null;
  const job = await prisma.indexJob.findUnique({
    where: { id: candidate.id },
    include: { document: true },
  });
  return job?.status === IndexStatus.PROCESSING &&
    job.leaseOwnerToken === ownerToken
    ? job
    : null;
}

async function documentWasDeleted(documentId: string) {
  const document = await prisma.knowledgeDocument.findUnique({
    where: { id: documentId },
    select: { deletedAt: true },
  });
  return !document || Boolean(document.deletedAt);
}

async function discardDeletedJob(
  jobId: string,
  documentId: string,
  ownerToken: string,
) {
  await prisma.$transaction(async (transaction) => {
    const removed = await transaction.indexJob.deleteMany({
      where: {
        id: jobId,
        status: IndexStatus.PROCESSING,
        leaseOwnerToken: ownerToken,
      },
    });
    if (removed.count !== 1) throw new Error("INDEX_JOB_LEASE_LOST");
    await transaction.knowledgeChunk.deleteMany({ where: { documentId } });
  });
  console.log(`Skipped deleted document ${documentId}`);
}

async function processNextKnowledge() {
  const job = await acquireJob();
  if (!job) return false;
  if (!job.leaseOwnerToken) throw new Error("INDEX_JOB_OWNER_TOKEN_MISSING");
  const ownerToken = job.leaseOwnerToken;
  activeJob = { id: job.id, documentId: job.documentId, ownerToken };
  if (job.operation !== KnowledgeIndexOperation.LEGACY_INDEX) {
    try {
      await withLeaseHeartbeat(job.id, ownerToken, () =>
        processKnowledgeIndexOperation(prisma, job),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withLeaseHeartbeat(job.id, ownerToken, () =>
        handleKnowledgeIndexFailure(prisma, job, error),
      );
      console.error(`Knowledge operation ${job.operation} failed: ${message}`);
    } finally {
      activeJob = null;
    }
    return true;
  }
  try {
    const text = await withLeaseHeartbeat(job.id, ownerToken, () =>
      extract(job.document),
    );
    if (text.length < 50)
      throw new Error("未提取到足够文本；扫描型 PDF 首版不支持 OCR");
    if (await documentWasDeleted(job.documentId)) {
      await discardDeletedJob(job.id, job.documentId, ownerToken);
      return true;
    }
    await writeLegacyIndexBatch(
      job.id,
      job.documentId,
      ownerToken,
    );
    let chunkIndex = 0;
    let batch: Array<{
      documentId: string;
      chunkIndex: number;
      content: string;
    }> = [];
    for (const content of iterateChunks(text)) {
      batch.push({ documentId: job.documentId, chunkIndex, content });
      chunkIndex += 1;
      if (batch.length >= CHUNK_BATCH_SIZE) {
        if (await documentWasDeleted(job.documentId)) {
          await discardDeletedJob(job.id, job.documentId, ownerToken);
          return true;
        }
        await writeLegacyIndexBatch(
          job.id,
          job.documentId,
          ownerToken,
          batch,
        );
        batch = [];
      }
    }
    if (batch.length) {
      await writeLegacyIndexBatch(
        job.id,
        job.documentId,
        ownerToken,
        batch,
      );
    }
    if (await documentWasDeleted(job.documentId)) {
      await discardDeletedJob(job.id, job.documentId, ownerToken);
      return true;
    }
    await prisma.$transaction(async (transaction) => {
      const jobUpdate = await transaction.indexJob.updateMany({
        where: {
          id: job.id,
          status: IndexStatus.PROCESSING,
          leaseOwnerToken: ownerToken,
        },
        data: {
          status: IndexStatus.READY,
          leaseOwnerToken: null,
          leasedUntil: null,
          error: null,
        },
      });
      if (jobUpdate.count !== 1) throw new Error("INDEX_JOB_LEASE_LOST");
      const documentUpdate = await transaction.knowledgeDocument.updateMany({
        where: { id: job.documentId, deletedAt: null },
        data: { indexStatus: IndexStatus.READY },
      });
      if (documentUpdate.count !== 1) throw new Error("DOCUMENT_DELETED");
    });
    console.log(`Indexed ${job.documentId}: ${chunkIndex} chunks`);
  } catch (error) {
    if (await documentWasDeleted(job.documentId)) {
      await discardDeletedJob(job.id, job.documentId, ownerToken);
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    const retry = job.attempts < 3;
    await prisma.$transaction(async (transaction) => {
      const updated = await transaction.indexJob.updateMany({
        where: {
          id: job.id,
          status: IndexStatus.PROCESSING,
          leaseOwnerToken: ownerToken,
        },
        data: {
          status: retry ? IndexStatus.PENDING : IndexStatus.FAILED,
          leaseOwnerToken: null,
          leasedUntil: null,
          error: message,
        },
      });
      if (updated.count !== 1) return;
      await transaction.knowledgeDocument.update({
        where: { id: job.documentId },
        data: { indexStatus: retry ? IndexStatus.PENDING : IndexStatus.FAILED },
      });
    });
    console.error(`Indexing ${job.documentId} failed: ${message}`);
  } finally {
    activeJob = null;
  }
  return true;
}

async function runCore() {
  console.log("Knowledge worker core lane started with concurrency=1");
  let queueCursor = 0;
  const queues = [
    () => processNextQuizImport(prisma),
    () => withKnowledgeReady(() => processNextKnowledgeImport(prisma), process.env.WORKER_ONCE === 'true'),
    () => withKnowledgeReady(() => processNextKnowledge(), process.env.WORKER_ONCE === 'true'),
    () => processNextPracticeStateBackfill(prisma),
  ];
  while (!shuttingDown) {
    let processed = false;
    try {
      for (let offset = 0; offset < queues.length; offset += 1) {
        const index = (queueCursor + offset) % queues.length;
        processed = await queues[index]!();
        if (processed) {
          queueCursor = (index + 1) % queues.length;
          break;
        }
      }
      if (!processed) {
        processed = await processNextKnowledgeRenderBackfill(prisma);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Worker loop failed: ${message}`);
    }
    if (process.env.WORKER_ONCE === "true") break;
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, processed ? 250 : IDLE_DELAY_MS),
    );
  }
}

async function runDailyScheduler() {
  console.log('Daily practice scheduler lane started with concurrency=1');
  while (!shuttingDown) {
    let processed = false;
    try {
      processed = await processDailyPracticeSchedulerTick(prisma);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Daily practice scheduler loop failed: ${message}`);
    }
    if (process.env.WORKER_ONCE === 'true') break;
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, processed ? 1_000 : IDLE_DELAY_MS),
    );
  }
}

async function runDailyGeneration(workerIndex: number) {
  console.log(`Daily practice generation lane ${workerIndex} started`);
  while (!shuttingDown) {
    let processed = false;
    try {
      processed = await processNextDailyPracticeGeneration(prisma);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Daily practice generation loop failed: ${message}`);
    }
    if (process.env.WORKER_ONCE === 'true') break;
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, processed ? 250 : IDLE_DELAY_MS),
    );
  }
}

async function runCurriculumMatching() {
  console.log('Curriculum question matching lane started with concurrency=1');
  while (!shuttingDown) {
    let processed = false;
    try {
      processed = await processNextCurriculumQuestionMapping(prisma);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Curriculum question matching loop failed: ${message}`);
    }
    if (process.env.WORKER_ONCE === 'true') break;
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, processed ? 250 : IDLE_DELAY_MS),
    );
  }
}

async function runCreditHourReviews() {
  console.log('Credit-hour vision review lane started with concurrency=1');
  while (!shuttingDown) {
    let processed = false;
    try {
      processed = await processNextCreditHourReview(prisma);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Credit-hour review loop failed: ${message}`);
    }
    if (process.env.WORKER_ONCE === 'true') break;
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, processed ? 250 : IDLE_DELAY_MS),
    );
  }
}

async function runLifecycleCleanup() {
  console.log('Lifecycle cleanup lane started with concurrency=1');
  while (!shuttingDown) {
    try {
      const result = await processLifecycleCleanupBatch(prisma, {
        batchSize: LIFECYCLE_CLEANUP_BATCH_SIZE,
        sourceBatchSize: IMPORT_SOURCE_CLEANUP_BATCH_SIZE,
      });
      if (Object.values(result).some((value) => value > 0)) {
        console.log(JSON.stringify({ event: 'lifecycle.cleanup', ...result }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Lifecycle cleanup failed: ${message}`);
    }
    if (process.env.WORKER_ONCE === 'true') break;
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, LIFECYCLE_CLEANUP_INTERVAL_MS),
    );
  }
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Knowledge worker received ${signal}`);
  const job = activeJob;
  await releaseActiveQuizImport(prisma).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to release quiz import lease: ${message}`);
  });
  await releaseActiveKnowledgeImport(prisma).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to release knowledge import lease: ${message}`);
  });
  await releaseActiveCurriculumQuestionMappings(prisma).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to release curriculum matching lease: ${message}`);
  });
  await releaseActiveCreditHourReview(prisma).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to release credit-hour review lease: ${message}`);
  });
  await releaseActivePracticeStateBackfills(prisma).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to release state backfill lease: ${message}`);
  });
  await releaseActiveDailySchedulerLeases(prisma).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to release daily scheduler lease: ${message}`);
  });
  await releaseActiveDailyPracticeGeneration(prisma).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to release daily generation lease: ${message}`);
  });
  if (job) {
    try {
      await prisma.$transaction(async (transaction) => {
        const released = await transaction.indexJob.updateMany({
          where: {
            id: job.id,
            status: IndexStatus.PROCESSING,
            leaseOwnerToken: job.ownerToken,
          },
          data: {
            status: IndexStatus.PENDING,
            leaseOwnerToken: null,
            leasedUntil: null,
          },
        });
        if (released.count !== 1) return;
        await transaction.knowledgeDocument.updateMany({
          where: { id: job.documentId, deletedAt: null },
          data: { indexStatus: IndexStatus.PENDING },
        });
        console.log(`Released index lease for ${job.documentId}`);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Failed to release index lease for ${job.documentId}: ${message}`,
      );
    }
  }
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

const dailyGenerationConcurrency = Math.max(
  1,
  Math.min(100, Number(process.env.AI_DAILY_PLAN_CONCURRENCY ?? 1)),
);

async function main() {
  await Promise.all([
    runCore(),
    runCurriculumMatching(),
    runCreditHourReviews(),
    runDailyScheduler(),
    runLifecycleCleanup(),
    ...Array.from({ length: dailyGenerationConcurrency }, (_, index) =>
      runDailyGeneration(index + 1),
    ),
  ]);
}

void main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Worker startup failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

function readBoundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}
