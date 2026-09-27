import { isAbsolute, relative, resolve, sep } from "node:path";
import { readAiRuntimeConfig } from "@bmc3/ai-core";

type RuntimeEnvironment = Record<string, string | undefined>;

export function validateApiRuntimeConfig(env: RuntimeEnvironment) {
  if (env.NODE_ENV !== "production") return;

  requireValues(env, [
    "DATABASE_URL",
    "WEB_ORIGIN",
    "STUDENT_DATA_KEY",
    "STORAGE_PROVIDER",
    "LOCAL_UPLOAD_DIR",
    "KNOWLEDGE_TEMP_DIR",
    "KNOWLEDGE_IMPORT_TEMP_DIR",
    "QUIZ_IMPORT_TEMP_DIR",
    "QUIZ_TOTAL_QUESTION_LIMIT",
    "MEDIA_STORAGE_PROVIDER",
    "MEDIA_COS_BUCKET",
    "MEDIA_COS_REGION",
    "MEDIA_COS_PUBLIC_ENDPOINT",
    "MEDIA_COS_SECRET_ID",
    "MEDIA_COS_SECRET_KEY",
    "AI_PROVIDER",
    "AI_BASE_URL",
    "AI_API_KEY",
    "AI_FLASH_MODEL",
    "AI_CHAT_TIMEOUT_MS",
    "AI_SHORT_ANSWER_GRADING_TIMEOUT_MS",
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
    "AI_DAILY_COST_LIMIT_MICROS",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIMENSIONS",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_API_KEY",
    "QDRANT_URL",
    "QDRANT_API_KEY",
    "QDRANT_COLLECTION",
    "QDRANT_COLLECTION_ALIAS",
  ]);

  validateDatabaseUrl(env.DATABASE_URL!);
  validateWebOrigin(env.WEB_ORIGIN!);
  validateStudentDataKey(env.STUDENT_DATA_KEY!);
  validateKnowledgeStorage(env);

  if (env.MEDIA_STORAGE_PROVIDER !== "cos") {
    throw new Error(
      "生产环境必须设置 MEDIA_STORAGE_PROVIDER=cos，禁止回退到数据库图片存储",
    );
  }
  validateAiConfig(env);
  if (env.EMBEDDING_PROVIDER !== "zhipu") {
    throw new Error("生产环境 EMBEDDING_PROVIDER 必须为 zhipu");
  }
  if (env.EMBEDDING_MODEL !== "embedding-3") {
    throw new Error("生产环境 EMBEDDING_MODEL 必须为 embedding-3");
  }
  if (env.EMBEDDING_DIMENSIONS !== "1024") {
    throw new Error("生产环境 EMBEDDING_DIMENSIONS 必须为 1024");
  }
  validateHttpsUrl("EMBEDDING_BASE_URL", env.EMBEDDING_BASE_URL!);
  validateHttpsUrl("MEDIA_COS_PUBLIC_ENDPOINT", env.MEDIA_COS_PUBLIC_ENDPOINT!);
  if (env.MEDIA_COS_ENDPOINT) {
    validateHttpsUrl("MEDIA_COS_ENDPOINT", env.MEDIA_COS_ENDPOINT);
  }
  validateQdrant(env);
  validateKnowledgeLimits(env);

  const quizQuestionLimit = Number(env.QUIZ_TOTAL_QUESTION_LIMIT);
  if (
    !Number.isInteger(quizQuestionLimit) ||
    quizQuestionLimit < 5_000 ||
    quizQuestionLimit > 1_000_000
  ) {
    throw new Error(
      "QUIZ_TOTAL_QUESTION_LIMIT 必须是 5000 到 1000000 的整数",
    );
  }

  const embeddingTimeout = Number(env.EMBEDDING_REQUEST_TIMEOUT_MS ?? "30000");
  if (
    !Number.isInteger(embeddingTimeout) ||
    embeddingTimeout < 1_000 ||
    embeddingTimeout > 60_000
  ) {
    throw new Error("EMBEDDING_REQUEST_TIMEOUT_MS 必须为 1000 到 60000");
  }

  const concurrency = Number(env.MEDIA_MAX_PROCESSING_CONCURRENCY ?? "2");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) {
    throw new Error("生产环境 MEDIA_MAX_PROCESSING_CONCURRENCY 必须是 1 或 2");
  }
  validateBoolean(
    "MEDIA_ORPHAN_CLEANUP_ENABLED",
    env.MEDIA_ORPHAN_CLEANUP_ENABLED ?? "false",
  );
}

function validateAiConfig(env: RuntimeEnvironment) {
  const config = readAiRuntimeConfig(env);
  if (config.provider !== "deepseek") {
    throw new Error("生产环境 AI_PROVIDER 必须为 deepseek");
  }
  if (config.flashModel !== "deepseek-v4-flash") {
    throw new Error("生产环境 AI_FLASH_MODEL 必须为 deepseek-v4-flash");
  }
  validateHttpsUrl("AI_BASE_URL", config.baseUrl);
  const integers: Array<[string, number, number]> = [
    ["AI_CHAT_TIMEOUT_MS", 1_000, 600_000],
    ["AI_SHORT_ANSWER_GRADING_TIMEOUT_MS", 1_000, 600_000],
    ["AI_CURRICULUM_MAPPING_TIMEOUT_MS", 1_000, 600_000],
    ["AI_CURRICULUM_MAPPING_DAILY_CALL_LIMIT", 1, 1_000_000],
    ["AI_CURRICULUM_MAPPING_DAILY_TOKEN_LIMIT", 1_000, 1_000_000_000],
    ["AI_DAILY_PLAN_TIMEOUT_MS", 1_000, 600_000],
    ["AI_DAILY_PLAN_CONCURRENCY", 1, 32],
    ["AI_DAILY_PLAN_MAX_INPUT_TOKENS", 1, 32_000],
    ["AI_DAILY_PLAN_MAX_OUTPUT_TOKENS", 100, 32_000],
    ["AI_DAILY_PLAN_DAILY_CALL_LIMIT", 1, 100_000],
    ["AI_DAILY_PLAN_DAILY_TOKEN_LIMIT", 1_000, 1_000_000_000],
    ["DAILY_PRACTICE_JOB_LEASE_MS", 60_000, 3_600_000],
    ["DAILY_PRACTICE_STATE_BACKFILL_BATCH_SIZE", 1, 1_000],
    ["AI_DAILY_COST_LIMIT_MICROS", 0, 1_000_000_000_000],
  ];
  for (const [name, minimum, maximum] of integers) {
    const value = Number(env[name]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数`);
    }
  }
}

function requireValues(env: RuntimeEnvironment, names: string[]) {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`生产运行时配置不完整：缺少 ${missing.join(", ")}`);
  }
}

function validateDatabaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL 格式无效");
  }
  if (
    url.protocol !== "mysql:" ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    !url.pathname.slice(1)
  ) {
    throw new Error(
      "DATABASE_URL 必须是包含用户、密码、主机和数据库名的 MySQL 连接串",
    );
  }
}

function validateWebOrigin(value: string) {
  if (value.includes(",")) {
    throw new Error("生产 WEB_ORIGIN 必须是单一精确 HTTPS 来源");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WEB_ORIGIN 格式无效");
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error("生产 WEB_ORIGIN 必须是单一精确 HTTPS 来源");
  }
}

function validateStudentDataKey(value: string) {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error("STUDENT_DATA_KEY 必须是规范的 32 字节 Base64 密钥");
  }
}

function validateKnowledgeStorage(env: RuntimeEnvironment) {
  if (env.STORAGE_PROVIDER !== "local") {
    throw new Error(
      "当前 VM 部署必须设置 STORAGE_PROVIDER=local 以使用共享知识目录",
    );
  }
  const uploadDir = env.LOCAL_UPLOAD_DIR!;
  const tempDirs = [
    env.KNOWLEDGE_TEMP_DIR!,
    env.KNOWLEDGE_IMPORT_TEMP_DIR!,
    env.QUIZ_IMPORT_TEMP_DIR!,
  ];
  if (
    !isAbsolute(uploadDir) ||
    tempDirs.some((tempDir) => !isAbsolute(tempDir))
  ) {
    throw new Error(
      "知识上传目录和题库导入目录必须是绝对路径",
    );
  }
  const resolvedUploadDir = resolve(uploadDir);
  for (const tempDir of tempDirs) {
    const relativeTempDir = relative(resolvedUploadDir, resolve(tempDir));
    if (
      relativeTempDir === "" ||
      (relativeTempDir !== ".." &&
        !relativeTempDir.startsWith(`..${sep}`) &&
        !isAbsolute(relativeTempDir))
    ) {
      throw new Error("临时上传目录必须与持久上传目录隔离");
    }
  }
}

function validateQdrant(env: RuntimeEnvironment) {
  let url: URL;
  try {
    url = new URL(env.QDRANT_URL!);
  } catch {
    throw new Error("QDRANT_URL 格式无效");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new Error("QDRANT_URL 必须使用 HTTP 或 HTTPS");
  }
  if (env.QDRANT_COLLECTION === env.QDRANT_COLLECTION_ALIAS) {
    throw new Error("QDRANT collection 与 alias 不能同名");
  }
  const timeout = Number(env.QDRANT_REQUEST_TIMEOUT_MS ?? "10000");
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 60_000) {
    throw new Error("QDRANT_REQUEST_TIMEOUT_MS 必须为 1000 到 60000");
  }
}

function validateKnowledgeLimits(env: RuntimeEnvironment) {
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
    ["KNOWLEDGE_IMPORT_UNCONFIRMED_PER_USER", 2, 1],
    ["KNOWLEDGE_ACTIVE_IMPORTS_GLOBAL", 10, 1],
    ["KNOWLEDGE_PRIVATE_ACTIVE_IMPORTS_PER_USER", 1, 1],
    ["KNOWLEDGE_PRIVATE_ACTIVE_IMPORTS_GLOBAL", 5, 1],
    ["KNOWLEDGE_IMPORT_MIN_FREE_BYTES", 5_368_709_120, 0],
    ["KNOWLEDGE_MAX_ACTIVE_CHUNKS", 100_000, 1],
    ["KNOWLEDGE_MAX_PRIVATE_ACTIVE_CHUNKS", 50_000, 1],
    ["KNOWLEDGE_MAX_LIVE_QDRANT_POINTS", 120_000, 1],
    ["KNOWLEDGE_PRIVATE_MAX_LIBRARIES_PER_USER", 2, 1],
    ["KNOWLEDGE_PRIVATE_MAX_ACTIVE_DOCUMENTS_PER_USER", 10, 1],
    ["KNOWLEDGE_PRIVATE_MAX_ACTIVE_CHUNKS_PER_USER", 2_000, 1],
    ["KNOWLEDGE_PRIVATE_MAX_IMAGES_PER_USER", 200, 0],
    ["KNOWLEDGE_PRIVATE_MAX_MEDIA_BYTES_PER_USER", 52_428_800, 0],
    ["AI_MAX_LIBRARIES_PER_CONVERSATION", 20, 1],
    ["AI_MAX_IMAGES_PER_RESPONSE", 4, 0],
  ];
  for (const [name, hardMaximum, minimum] of limits) {
    const value = Number(env[name] ?? hardMaximum);
    if (!Number.isInteger(value) || value < minimum || value > hardMaximum) {
      throw new Error(`${name} 必须是 ${minimum} 到 ${hardMaximum} 的整数`);
    }
  }
  if (
    Number(env.KNOWLEDGE_PRIVATE_ACTIVE_IMPORTS_GLOBAL ?? 5) >
    Number(env.KNOWLEDGE_ACTIVE_IMPORTS_GLOBAL ?? 10)
  ) {
    throw new Error(
      "KNOWLEDGE_PRIVATE_ACTIVE_IMPORTS_GLOBAL 不能超过 KNOWLEDGE_ACTIVE_IMPORTS_GLOBAL",
    );
  }
}

function validateHttpsUrl(name: string, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 格式无效`);
  }
  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error(`${name} 必须使用 HTTPS`);
  }
}

function validateBoolean(name: string, value: string) {
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} 必须是 true 或 false`);
  }
}
