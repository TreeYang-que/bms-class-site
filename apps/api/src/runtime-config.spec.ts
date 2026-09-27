import { validateApiRuntimeConfig } from "./runtime-config";

function productionEnvironment() {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "mysql://bmc3:secret@bmc3-mysql:3306/bmc3",
    WEB_ORIGIN: "https://class.example.test",
    STUDENT_DATA_KEY: Buffer.alloc(32, 7).toString("base64"),
    STORAGE_PROVIDER: "local",
    LOCAL_UPLOAD_DIR: "/data/uploads",
    KNOWLEDGE_TEMP_DIR: "/data/knowledge-tmp",
    KNOWLEDGE_IMPORT_TEMP_DIR: "/data/knowledge-import-tmp",
    QUIZ_IMPORT_TEMP_DIR: "/data/quiz-import-tmp",
    QUIZ_TOTAL_QUESTION_LIMIT: "100000",
    MEDIA_STORAGE_PROVIDER: "cos",
    MEDIA_COS_BUCKET: "private-media-1000000000",
    MEDIA_COS_REGION: "ap-test",
    MEDIA_COS_PUBLIC_ENDPOINT: "https://media.example.test",
    MEDIA_COS_SECRET_ID: "secret-id",
    MEDIA_COS_SECRET_KEY: "secret-key",
    MEDIA_MAX_PROCESSING_CONCURRENCY: "2",
    MEDIA_ORPHAN_CLEANUP_ENABLED: "false",
    AI_PROVIDER: "deepseek",
    AI_BASE_URL: "https://api.deepseek.com",
    AI_API_KEY: "ai-key",
    AI_FLASH_MODEL: "deepseek-v4-flash",
    AI_CHAT_TIMEOUT_MS: "60000",
    AI_SHORT_ANSWER_GRADING_TIMEOUT_MS: "45000",
    AI_CURRICULUM_MAPPING_TIMEOUT_MS: "180000",
    AI_CURRICULUM_MAPPING_DAILY_CALL_LIMIT: "1000",
    AI_CURRICULUM_MAPPING_DAILY_TOKEN_LIMIT: "10000000",
    AI_DAILY_PLAN_TIMEOUT_MS: "300000",
    AI_DAILY_PLAN_CONCURRENCY: "1",
    AI_DAILY_PLAN_MAX_INPUT_TOKENS: "16000",
    AI_DAILY_PLAN_MAX_OUTPUT_TOKENS: "32000",
    AI_DAILY_PLAN_DAILY_CALL_LIMIT: "50",
    AI_DAILY_PLAN_DAILY_TOKEN_LIMIT: "500000",
    DAILY_PRACTICE_JOB_LEASE_MS: "600000",
    DAILY_PRACTICE_STATE_BACKFILL_BATCH_SIZE: "50",
    AI_DAILY_COST_LIMIT_MICROS: "0",
    EMBEDDING_PROVIDER: "zhipu",
    EMBEDDING_MODEL: "embedding-3",
    EMBEDDING_DIMENSIONS: "1024",
    EMBEDDING_BASE_URL: "https://open.bigmodel.cn/api/paas/v4/embeddings",
    EMBEDDING_API_KEY: "embedding-key",
    QDRANT_URL: "http://bmc3-qdrant:6333",
    QDRANT_API_KEY: "qdrant-secret",
    QDRANT_COLLECTION: "bmc3_knowledge_embedding3_1024_v1",
    QDRANT_COLLECTION_ALIAS: "bmc3_knowledge_active",
  };
}

describe("validateApiRuntimeConfig", () => {
  it("accepts a complete production configuration with cleanup disabled", () => {
    expect(() =>
      validateApiRuntimeConfig(productionEnvironment()),
    ).not.toThrow();
  });

  it("requires an exact HTTPS web origin", () => {
    expect(() =>
      validateApiRuntimeConfig({
        ...productionEnvironment(),
        WEB_ORIGIN: "http://192.0.2.10",
      }),
    ).toThrow("单一精确 HTTPS 来源");
  });

  it("rejects production mock providers and excess image concurrency", () => {
    expect(() =>
      validateApiRuntimeConfig({
        ...productionEnvironment(),
        AI_PROVIDER: "mock",
      }),
    ).toThrow("AI_PROVIDER 必须为 deepseek");
    expect(() =>
      validateApiRuntimeConfig({
        ...productionEnvironment(),
        AI_FLASH_MODEL: "deepseek-v4-pro",
      }),
    ).toThrow("AI_FLASH_MODEL 必须为 deepseek-v4-flash");
    expect(() =>
      validateApiRuntimeConfig({
        ...productionEnvironment(),
        EMBEDDING_PROVIDER: "mock",
      }),
    ).toThrow("EMBEDDING_PROVIDER 必须为 zhipu");
    expect(() =>
      validateApiRuntimeConfig({
        ...productionEnvironment(),
        MEDIA_MAX_PROCESSING_CONCURRENCY: "3",
      }),
    ).toThrow("必须是 1 或 2");
  });

  it("keeps the temporary directory outside persistent uploads", () => {
    expect(() =>
      validateApiRuntimeConfig({
        ...productionEnvironment(),
        KNOWLEDGE_TEMP_DIR: "/data/uploads/tmp",
      }),
    ).toThrow("临时上传目录必须与持久上传目录隔离");
  });

  it("requires bounded daily-practice model and worker settings", () => {
    const missing = productionEnvironment();
    delete (missing as Partial<typeof missing>).AI_DAILY_PLAN_TIMEOUT_MS;
    expect(() => validateApiRuntimeConfig(missing)).toThrow(
      "AI_DAILY_PLAN_TIMEOUT_MS",
    );

    expect(() =>
      validateApiRuntimeConfig({
        ...productionEnvironment(),
        AI_DAILY_PLAN_CONCURRENCY: "33",
      }),
    ).toThrow("AI_DAILY_PLAN_CONCURRENCY");
    expect(() =>
      validateApiRuntimeConfig({
        ...productionEnvironment(),
        DAILY_PRACTICE_JOB_LEASE_MS: "59999",
      }),
    ).toThrow("DAILY_PRACTICE_JOB_LEASE_MS");
  });
});
