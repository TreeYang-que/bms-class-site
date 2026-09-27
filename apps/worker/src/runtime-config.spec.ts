import { validateWorkerRuntimeConfig } from "./runtime-config";

describe("validateWorkerRuntimeConfig", () => {
  it("accepts the shared local knowledge directory in production", () => {
    expect(() =>
      validateWorkerRuntimeConfig({
        NODE_ENV: "production",
        DATABASE_URL: "mysql://bmc3:secret@bmc3-mysql:3306/bmc3",
        STORAGE_PROVIDER: "local",
        LOCAL_UPLOAD_DIR: "/data/uploads",
        MEDIA_STORAGE_PROVIDER: "cos",
        MEDIA_COS_BUCKET: "private-media-1000000000",
        MEDIA_COS_REGION: "ap-test",
        MEDIA_COS_PUBLIC_ENDPOINT: "https://media.example.test",
        MEDIA_COS_SECRET_ID: "secret-id",
        MEDIA_COS_SECRET_KEY: "secret-key",
        MEDIA_MAX_PROCESSING_CONCURRENCY: "2",
        EMBEDDING_PROVIDER: "zhipu",
        EMBEDDING_MODEL: "embedding-3",
        EMBEDDING_DIMENSIONS: "1024",
        EMBEDDING_BASE_URL: "https://embedding.example.test/v1/embeddings",
        EMBEDDING_API_KEY: "embedding-secret",
        EMBEDDING_BATCH_SIZE: "32",
        WORKER_EMBEDDING_CONCURRENCY: "1",
        QDRANT_URL: "http://bmc3-qdrant:6333",
        QDRANT_API_KEY: "qdrant-secret",
        QDRANT_COLLECTION: "bmc3_knowledge_embedding3_1024_v1",
        QDRANT_COLLECTION_ALIAS: "bmc3_knowledge_active",
        AI_PROVIDER: "deepseek",
        AI_BASE_URL: "https://api.deepseek.com",
        AI_API_KEY: "ai-key",
        AI_FLASH_MODEL: "deepseek-v4-flash",
        AI_CREDIT_HOUR_REVIEW_MODEL: "deepseek-v4-flash-vision-exp",
        AI_CREDIT_HOUR_REVIEW_TIMEOUT_MS: "120000",
        AI_CREDIT_HOUR_REVIEW_CONCURRENCY: "1",
        AI_CREDIT_HOUR_REVIEW_DAILY_CALL_LIMIT: "500",
        AI_CREDIT_HOUR_REVIEW_DAILY_TOKEN_LIMIT: "5000000",
        AI_CURRICULUM_MAPPING_TIMEOUT_MS: "180000",
        AI_CURRICULUM_MAPPING_DAILY_CALL_LIMIT: "1000",
        AI_CURRICULUM_MAPPING_DAILY_TOKEN_LIMIT: "10000000",
        AI_DAILY_PLAN_TIMEOUT_MS: "180000",
        AI_DAILY_PLAN_CONCURRENCY: "1",
        AI_DAILY_PLAN_MAX_INPUT_TOKENS: "32000",
        AI_DAILY_PLAN_MAX_OUTPUT_TOKENS: "32000",
        AI_DAILY_PLAN_DAILY_CALL_LIMIT: "1000",
        AI_DAILY_PLAN_DAILY_TOKEN_LIMIT: "10000000",
        DAILY_PRACTICE_JOB_LEASE_MS: "600000",
        DAILY_PRACTICE_STATE_BACKFILL_BATCH_SIZE: "25",
      }),
    ).not.toThrow();
  });

  it("rejects an incomplete production configuration", () => {
    expect(() =>
      validateWorkerRuntimeConfig({ NODE_ENV: "production" }),
    ).toThrow("Worker 生产运行时配置不完整");
  });

  it("rejects a daily lease shorter than model timeout plus settlement", () => {
    const env = {
      NODE_ENV: "production",
      DATABASE_URL: "mysql://bmc3:secret@bmc3-mysql:3306/bmc3",
      STORAGE_PROVIDER: "local",
      LOCAL_UPLOAD_DIR: "/data/uploads",
      MEDIA_STORAGE_PROVIDER: "cos",
      MEDIA_COS_BUCKET: "private-media-1000000000",
      MEDIA_COS_REGION: "ap-test",
      MEDIA_COS_PUBLIC_ENDPOINT: "https://media.example.test",
      MEDIA_COS_SECRET_ID: "secret-id",
      MEDIA_COS_SECRET_KEY: "secret-key",
      EMBEDDING_PROVIDER: "zhipu",
      EMBEDDING_MODEL: "embedding-3",
      EMBEDDING_DIMENSIONS: "1024",
      EMBEDDING_BASE_URL: "https://embedding.example.test/v1/embeddings",
      EMBEDDING_API_KEY: "secret",
      EMBEDDING_BATCH_SIZE: "32",
      WORKER_EMBEDDING_CONCURRENCY: "1",
      QDRANT_URL: "http://bmc3-qdrant:6333",
      QDRANT_API_KEY: "secret",
      QDRANT_COLLECTION: "collection",
      QDRANT_COLLECTION_ALIAS: "alias",
      AI_PROVIDER: "deepseek",
      AI_BASE_URL: "https://api.deepseek.com",
      AI_API_KEY: "secret",
      AI_FLASH_MODEL: "flash",
      AI_CREDIT_HOUR_REVIEW_MODEL: "deepseek-v4-flash-vision-exp",
      AI_CREDIT_HOUR_REVIEW_TIMEOUT_MS: "120000",
      AI_CREDIT_HOUR_REVIEW_CONCURRENCY: "1",
      AI_CREDIT_HOUR_REVIEW_DAILY_CALL_LIMIT: "500",
      AI_CREDIT_HOUR_REVIEW_DAILY_TOKEN_LIMIT: "5000000",
      AI_CURRICULUM_MAPPING_TIMEOUT_MS: "180000",
      AI_CURRICULUM_MAPPING_DAILY_CALL_LIMIT: "1000",
      AI_CURRICULUM_MAPPING_DAILY_TOKEN_LIMIT: "10000000",
      AI_DAILY_PLAN_TIMEOUT_MS: "180000",
      AI_DAILY_PLAN_CONCURRENCY: "1",
      AI_DAILY_PLAN_MAX_INPUT_TOKENS: "32000",
      AI_DAILY_PLAN_MAX_OUTPUT_TOKENS: "4000",
      AI_DAILY_PLAN_DAILY_CALL_LIMIT: "1000",
      AI_DAILY_PLAN_DAILY_TOKEN_LIMIT: "10000000",
      DAILY_PRACTICE_JOB_LEASE_MS: "180000",
      DAILY_PRACTICE_STATE_BACKFILL_BATCH_SIZE: "25",
    };
    expect(() => validateWorkerRuntimeConfig(env)).toThrow(
      "DAILY_PRACTICE_JOB_LEASE_MS 必须至少覆盖",
    );
  });
});
