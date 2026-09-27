import { isAbsolute } from "node:path";
import { readAiRuntimeConfig } from "@bmc3/ai-core";
import { readMediaCosConfig } from "@bmc3/media-core";

type RuntimeEnvironment = Record<string, string | undefined>;

export function validateWorkerRuntimeConfig(env: RuntimeEnvironment) {
  if (env.NODE_ENV !== "production") return;

  const required = [
    "DATABASE_URL",
    "STORAGE_PROVIDER",
    "LOCAL_UPLOAD_DIR",
    "MEDIA_STORAGE_PROVIDER",
    "MEDIA_COS_BUCKET",
    "MEDIA_COS_REGION",
    "MEDIA_COS_PUBLIC_ENDPOINT",
    "MEDIA_COS_SECRET_ID",
    "MEDIA_COS_SECRET_KEY",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIMENSIONS",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_API_KEY",
    "EMBEDDING_BATCH_SIZE",
    "WORKER_EMBEDDING_CONCURRENCY",
    "QDRANT_URL",
    "QDRANT_API_KEY",
    "QDRANT_COLLECTION",
    "QDRANT_COLLECTION_ALIAS",
    "AI_PROVIDER",
    "AI_BASE_URL",
    "AI_API_KEY",
    "AI_FLASH_MODEL",
    "AI_CREDIT_HOUR_REVIEW_MODEL",
    "AI_CREDIT_HOUR_REVIEW_TIMEOUT_MS",
    "AI_CREDIT_HOUR_REVIEW_CONCURRENCY",
    "AI_CREDIT_HOUR_REVIEW_DAILY_CALL_LIMIT",
    "AI_CREDIT_HOUR_REVIEW_DAILY_TOKEN_LIMIT",
    "AI_CURRICULUM_MAPPING_TIMEOUT_MS",
    "AI_CURRICULUM_MAPPING_DAILY_CALL_LIMIT",
    "AI_CURRICULUM_MAPPING_DAILY_TOKEN_LIMIT",
    "AI_DAILY_PLAN_TIMEOUT_MS",
    "AI_DAILY_PLAN_CONCURRENCY",
    "AI_DAILY_PLAN_MAX_INPUT_TOKENS",
    "AI_DAILY_PLAN_MAX_OUTPUT_TOKENS",
    "AI_DAILY_PLAN_DAILY_CALL_LIMIT",
    "AI_DAILY_PLAN_DAILY_TOKEN_LIMIT",
    "DAILY_PRACTICE_JOB_LEASE_MS",
    "DAILY_PRACTICE_STATE_BACKFILL_BATCH_SIZE",
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`Worker 生产运行时配置不完整：缺少 ${missing.join(", ")}`);
  }
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(env.DATABASE_URL!);
  } catch {
    throw new Error("Worker DATABASE_URL 格式无效");
  }
  if (
    databaseUrl.protocol !== "mysql:" ||
    !databaseUrl.hostname ||
    !databaseUrl.username ||
    !databaseUrl.password ||
    !databaseUrl.pathname.slice(1)
  ) {
    throw new Error("Worker DATABASE_URL 必须是完整 MySQL 连接串");
  }
  const dailyLimits: Array<[string, number, number]> = [
    ["AI_CURRICULUM_MAPPING_TIMEOUT_MS", 1_000, 600_000],
    ["AI_CURRICULUM_MAPPING_DAILY_CALL_LIMIT", 1, 1_000_000],
    ["AI_CURRICULUM_MAPPING_DAILY_TOKEN_LIMIT", 1_000, 1_000_000_000],
    ["AI_DAILY_PLAN_TIMEOUT_MS", 1_000, 600_000],
    ["AI_DAILY_PLAN_CONCURRENCY", 1, 100],
    ["AI_DAILY_PLAN_MAX_INPUT_TOKENS", 1_000, 32_000],
    ["AI_DAILY_PLAN_MAX_OUTPUT_TOKENS", 100, 32_000],
    ["AI_DAILY_PLAN_DAILY_CALL_LIMIT", 1, 1_000_000],
    ["AI_DAILY_PLAN_DAILY_TOKEN_LIMIT", 1_000, 1_000_000_000],
    ["DAILY_PRACTICE_JOB_LEASE_MS", 60_000, 3_600_000],
    ["DAILY_PRACTICE_STATE_BACKFILL_BATCH_SIZE", 1, 500],
    ["LIFECYCLE_CLEANUP_INTERVAL_MS", 60_000, 86_400_000],
    ["LIFECYCLE_CLEANUP_BATCH_SIZE", 1, 1_000],
    ["IMPORT_SOURCE_CLEANUP_BATCH_SIZE", 1, 100],
  ];
  for (const [name, minimum, maximum] of dailyLimits) {
    const defaults: Record<string, number> = {
      LIFECYCLE_CLEANUP_INTERVAL_MS: 300_000,
      LIFECYCLE_CLEANUP_BATCH_SIZE: 100,
      IMPORT_SOURCE_CLEANUP_BATCH_SIZE: 10,
    };
    const value = Number(env[name] ?? defaults[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`);
    }
  }
  if (
    Number(env.DAILY_PRACTICE_JOB_LEASE_MS) <
    Number(env.AI_DAILY_PLAN_TIMEOUT_MS) + 30_000
  ) {
    throw new Error(
      "DAILY_PRACTICE_JOB_LEASE_MS 必须至少覆盖每日计划超时和 30 秒结算余量",
    );
  }
  if (
    Number(env.DAILY_PRACTICE_JOB_LEASE_MS) <
    Number(env.AI_CURRICULUM_MAPPING_TIMEOUT_MS) + 30_000
  ) {
    throw new Error('DAILY_PRACTICE_JOB_LEASE_MS 必须至少覆盖课程匹配超时和 30 秒结算余量');
  }
  if (env.STORAGE_PROVIDER !== "local") {
    throw new Error("当前 VM Worker 必须设置 STORAGE_PROVIDER=local");
  }
  if (!isAbsolute(env.LOCAL_UPLOAD_DIR!)) {
    throw new Error("Worker LOCAL_UPLOAD_DIR 必须是绝对路径");
  }
  if (env.MEDIA_STORAGE_PROVIDER !== "cos") {
    throw new Error("生产环境 Worker 必须设置 MEDIA_STORAGE_PROVIDER=cos");
  }
  readMediaCosConfig(env);
  const concurrency = Number(env.MEDIA_MAX_PROCESSING_CONCURRENCY ?? "2");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
    throw new Error("Worker MEDIA_MAX_PROCESSING_CONCURRENCY 必须是 1 或 2");
  }
  if (env.EMBEDDING_PROVIDER !== "zhipu") {
    throw new Error("生产环境 Worker EMBEDDING_PROVIDER 必须为 zhipu");
  }
  if (env.EMBEDDING_MODEL !== "embedding-3") {
    throw new Error("生产环境 Worker EMBEDDING_MODEL 必须为 embedding-3");
  }
  if (env.EMBEDDING_DIMENSIONS !== "1024") {
    throw new Error("生产环境 Worker EMBEDDING_DIMENSIONS 必须为 1024");
  }
  let embeddingUrl: URL;
  let qdrantUrl: URL;
  try {
    embeddingUrl = new URL(env.EMBEDDING_BASE_URL!);
    qdrantUrl = new URL(env.QDRANT_URL!);
  } catch {
    throw new Error("Worker Embedding 或 Qdrant URL 格式无效");
  }
  if (embeddingUrl.protocol !== "https:") {
    throw new Error("Worker EMBEDDING_BASE_URL 必须使用 HTTPS");
  }
  if (!["http:", "https:"].includes(qdrantUrl.protocol)) {
    throw new Error("Worker QDRANT_URL 协议无效");
  }
  const embeddingBatch = Number(env.EMBEDDING_BATCH_SIZE);
  if (!Number.isInteger(embeddingBatch) || embeddingBatch < 1 || embeddingBatch > 64) {
    throw new Error("Worker EMBEDDING_BATCH_SIZE 必须是 1 到 64 的整数");
  }
  if (env.WORKER_EMBEDDING_CONCURRENCY !== "1") {
    throw new Error("Worker EMBEDDING 并发必须保持为 1");
  }
  const ai = readAiRuntimeConfig(env);
  if (ai.provider !== "deepseek") {
    throw new Error("生产环境 Worker AI_PROVIDER 必须为 deepseek");
  }
  if (ai.flashModel !== "deepseek-v4-flash") {
    throw new Error("生产环境 Worker AI_FLASH_MODEL 必须为 deepseek-v4-flash");
  }
  if (ai.creditHourReviewModel !== "deepseek-v4-flash-vision-exp") {
    throw new Error(
      "生产环境 Worker AI_CREDIT_HOUR_REVIEW_MODEL 必须为 deepseek-v4-flash-vision-exp",
    );
  }
  let aiUrl: URL;
  try {
    aiUrl = new URL(ai.baseUrl);
  } catch {
    throw new Error("Worker AI_BASE_URL 格式无效");
  }
  if (aiUrl.protocol !== "https:") {
    throw new Error("Worker AI_BASE_URL 必须使用 HTTPS");
  }
  const aiLimits: Array<[string, number, number]> = [
    ["AI_CREDIT_HOUR_REVIEW_TIMEOUT_MS", 10_000, 300_000],
    ["AI_CREDIT_HOUR_REVIEW_CONCURRENCY", 1, 4],
    ["AI_CREDIT_HOUR_REVIEW_DAILY_CALL_LIMIT", 1, 100_000],
    ["AI_CREDIT_HOUR_REVIEW_DAILY_TOKEN_LIMIT", 1_000, 1_000_000_000],
  ];
  for (const [name, minimum, maximum] of aiLimits) {
    const value = Number(env[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`);
    }
  }
  const limits: Array<[string, number, number]> = [
    ["KNOWLEDGE_IMPORT_MAX_MARKDOWN_BYTES", 10_485_760, 1],
    ["KNOWLEDGE_IMPORT_MAX_ZIP_BYTES", 209_715_200, 1],
    ["KNOWLEDGE_IMPORT_MAX_EXPANDED_BYTES", 524_288_000, 1],
    ["KNOWLEDGE_IMPORT_MAX_ZIP_RATIO", 100, 1],
    ["KNOWLEDGE_IMPORT_MAX_IMAGES", 1_000, 0],
    ["KNOWLEDGE_IMPORT_MAX_IMAGE_BYTES", 10_485_760, 1],
    ["KNOWLEDGE_IMPORT_MAX_IMAGE_PIXELS", 32_000_000, 1],
    ["KNOWLEDGE_IMPORT_MAX_PROCESSED_IMAGE_BYTES", 307_200, 1],
    ["KNOWLEDGE_IMPORT_PREFLIGHT_CONCURRENCY", 2, 1],
    ["KNOWLEDGE_IMPORT_IMAGE_CONCURRENCY", 2, 1],
  ];
  for (const [name, hardMaximum, minimum] of limits) {
    const value = Number(env[name] ?? hardMaximum);
    if (!Number.isInteger(value) || value < minimum || value > hardMaximum) {
      throw new Error(`${name} 必须是 ${minimum} 到 ${hardMaximum} 的整数`);
    }
  }
  if (Number(env.KNOWLEDGE_IMPORT_IMAGE_CONCURRENCY ?? 2) > concurrency) {
    throw new Error(
      "KNOWLEDGE_IMPORT_IMAGE_CONCURRENCY 不能超过 MEDIA_MAX_PROCESSING_CONCURRENCY",
    );
  }
}
