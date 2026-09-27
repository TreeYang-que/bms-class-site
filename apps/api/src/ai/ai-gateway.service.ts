import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AiClient,
  AiClientError,
  type AiCompletion,
  type AiRequest,
  type AiStreamEvent,
  estimateTokens,
  modelForStrategy,
  readAiRuntimeConfig,
} from '@bmc3/ai-core';
import {
  AiInvocationStatus,
  AiTaskType,
  AiUsageSource,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export interface AiInvocationContext {
  correlationType: string;
  correlationId: string;
  requestedById?: string;
  attempt?: number;
}

interface Reservation {
  id: string;
  taskType: AiTaskType;
  usageDate: Date;
  reservedTokens: number;
  startedAt: number;
}

@Injectable()
export class AiGatewayService {
  private readonly config = readAiRuntimeConfig(process.env);
  private readonly client = new AiClient(this.config);

  constructor(private readonly prisma: PrismaService) {}

  get provider() {
    return this.config.provider;
  }

  model(strategy: AiRequest['strategy']) {
    return modelForStrategy(this.config, strategy);
  }

  async complete(
    request: AiRequest,
    context: AiInvocationContext,
  ): Promise<AiCompletion> {
    const reservation = await this.reserve(request, context);
    try {
      const result = await this.client.complete(request);
      await this.finishSuccess(reservation, result);
      return result;
    } catch (error) {
      await this.finishFailure(reservation, error);
      throw error;
    }
  }

  async *stream(
    request: AiRequest,
    context: AiInvocationContext,
  ): AsyncGenerator<AiStreamEvent> {
    const reservation = await this.reserve(request, context);
    let usage: AiCompletion['usage'] | undefined;
    let providerRequestId: string | undefined;
    let completed = false;
    try {
      for await (const event of this.client.stream(request)) {
        if (event.type === 'usage') {
          usage = event.usage;
          providerRequestId = event.providerRequestId;
        }
        yield event;
      }
      completed = true;
      await this.finishSuccess(reservation, {
        content: '',
        provider: this.config.provider,
        model: this.model(request.strategy),
        providerRequestId,
        usage:
          usage ?? {
            inputTokens: estimateInputTokens(request),
            outputTokens: 0,
            source: 'ESTIMATED',
          },
        latencyMs: Date.now() - reservation.startedAt,
      });
    } catch (error) {
      await this.finishFailure(reservation, error);
      throw error;
    } finally {
      if (!completed) {
        await this.finishCancelled(reservation).catch(() => undefined);
      }
    }
  }

  private async reserve(
    request: AiRequest,
    context: AiInvocationContext,
  ): Promise<Reservation> {
    const taskType = request.taskType as AiTaskType;
    const usageDate = shanghaiUsageDate();
    const reservedTokens = estimateInputTokens(request) + request.maxOutputTokens;
    const limits = taskLimits(request.taskType);
    const leaseMs = Math.max(request.timeoutMs + 30_000, 90_000);
    const now = new Date();
    const startedAt = Date.now();
    const pricing = pricingFor(request.strategy);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const invocation = await this.prisma.$transaction(
          async (transaction) => {
            await recoverExpiredInvocations(transaction, now);
            await transaction.aiDailyUsage.upsert({
              where: {
                usageDate_scope_taskType: {
                  usageDate,
                  scope: 'GLOBAL',
                  taskType,
                },
              },
              create: { usageDate, scope: 'GLOBAL', taskType },
              update: {},
            });
            await transaction.$queryRaw(
              Prisma.sql`
                SELECT usageDate
                FROM AiDailyUsage
                WHERE usageDate = ${usageDate}
                  AND scope = 'GLOBAL'
                  AND taskType = ${taskType}
                FOR UPDATE
              `,
            );
            const usage = await transaction.aiDailyUsage.findUniqueOrThrow({
              where: {
                usageDate_scope_taskType: {
                  usageDate,
                  scope: 'GLOBAL',
                  taskType,
                },
              },
            });
            if (usage.activeCalls >= limits.concurrency) {
              throw new AiClientError(
                'AI 任务并发已满，请稍后重试',
                'RATE_LIMIT',
                true,
                429,
              );
            }
            if (usage.calls >= limits.dailyCalls) {
              throw new AiClientError(
                'AI 任务今日调用额度已用完',
                'RATE_LIMIT',
                false,
                429,
              );
            }
            const consumed =
              usage.inputTokens + usage.outputTokens + usage.reservedTokens;
            if (consumed + BigInt(reservedTokens) > BigInt(limits.dailyTokens)) {
              throw new AiClientError(
                'AI 任务今日 token 额度不足',
                'RATE_LIMIT',
                false,
                429,
              );
            }
            const created = await transaction.aiInvocation.create({
              data: {
                taskType,
                strategy: request.strategy,
                provider: this.config.provider,
                model: this.model(request.strategy),
                promptVersion: request.promptVersion,
                correlationType: context.correlationType,
                correlationId: context.correlationId,
                requestedById: context.requestedById,
                status: AiInvocationStatus.RUNNING,
                attempt: context.attempt ?? 1,
                inputHash: hashMessages(request),
                reservedTokens,
                pricingVersion: pricing.version,
                startedAt: now,
                leasedUntil: new Date(now.getTime() + leaseMs),
              },
              select: { id: true },
            });
            await transaction.aiDailyUsage.update({
              where: {
                usageDate_scope_taskType: {
                  usageDate,
                  scope: 'GLOBAL',
                  taskType,
                },
              },
              data: {
                calls: { increment: 1 },
                activeCalls: { increment: 1 },
                reservedTokens: { increment: reservedTokens },
              },
            });
            return created;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5_000,
            timeout: 15_000,
          },
        );
        return {
          id: invocation.id,
          taskType,
          usageDate,
          reservedTokens,
          startedAt,
        };
      } catch (error) {
        if (attempt < 3 && isSerializationConflict(error)) continue;
        throw error;
      }
    }
    throw new AiClientError('AI 调用额度预留失败', 'UPSTREAM_UNAVAILABLE', true);
  }

  private async finishSuccess(
    reservation: Reservation,
    result: AiCompletion,
  ) {
    const pricing = pricingForInvocation(result.model);
    const cost = estimateCostMicros(
      result.usage.inputTokens,
      result.usage.outputTokens,
      pricing,
    );
    await this.finish(reservation, {
      status: AiInvocationStatus.SUCCEEDED,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      usageSource:
        result.usage.source === 'PROVIDER'
          ? AiUsageSource.PROVIDER
          : AiUsageSource.ESTIMATED,
      estimatedCostMicros: cost,
      providerRequestId: result.providerRequestId,
      latencyMs: result.latencyMs,
      outputHash: result.content ? sha256(result.content) : undefined,
    });
  }

  private async finishFailure(reservation: Reservation, error: unknown) {
    const category =
      error instanceof AiClientError ? error.category : 'UPSTREAM_UNAVAILABLE';
    await this.finish(reservation, {
      status:
        category === 'CANCELLED'
          ? AiInvocationStatus.CANCELLED
          : AiInvocationStatus.FAILED,
      errorCategory: category,
      errorMessage: safeErrorMessage(error),
      failed: true,
      latencyMs: Date.now() - reservation.startedAt,
    });
  }

  private finishCancelled(reservation: Reservation) {
    return this.finish(reservation, {
      status: AiInvocationStatus.CANCELLED,
      errorCategory: 'CANCELLED',
      errorMessage: '调用方提前结束响应流',
      failed: true,
      latencyMs: Date.now() - reservation.startedAt,
    });
  }

  private async finish(
    reservation: Reservation,
    result: {
      status: AiInvocationStatus;
      inputTokens?: number;
      outputTokens?: number;
      usageSource?: AiUsageSource;
      estimatedCostMicros?: bigint;
      providerRequestId?: string;
      latencyMs?: number;
      outputHash?: string;
      errorCategory?: string;
      errorMessage?: string;
      failed?: boolean;
    },
  ) {
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.aiInvocation.updateMany({
        where: {
          id: reservation.id,
          status: {
            in: [AiInvocationStatus.RESERVED, AiInvocationStatus.RUNNING],
          },
        },
        data: {
          status: result.status,
          inputTokens: result.inputTokens ?? 0,
          outputTokens: result.outputTokens ?? 0,
          usageSource: result.usageSource ?? AiUsageSource.ESTIMATED,
          estimatedCostMicros: result.estimatedCostMicros ?? 0,
          providerRequestId: result.providerRequestId,
          latencyMs: result.latencyMs,
          outputHash: result.outputHash,
          errorCategory: result.errorCategory,
          errorMessage: result.errorMessage,
          completedAt: new Date(),
          leasedUntil: null,
          reservedTokens: 0,
        },
      });
      if (!updated.count) return;
      await transaction.$executeRaw(
        Prisma.sql`
          UPDATE AiDailyUsage
          SET activeCalls = GREATEST(activeCalls - 1, 0),
              reservedTokens = GREATEST(reservedTokens - ${reservation.reservedTokens}, 0),
              inputTokens = inputTokens + ${result.inputTokens ?? 0},
              outputTokens = outputTokens + ${result.outputTokens ?? 0},
              estimatedCostMicros = estimatedCostMicros + ${result.estimatedCostMicros ?? 0},
              failures = failures + ${result.failed ? 1 : 0}
          WHERE usageDate = ${reservation.usageDate}
            AND scope = 'GLOBAL'
            AND taskType = ${reservation.taskType}
        `,
      );
    });
  }
}

function estimateInputTokens(request: AiRequest) {
  return estimateTokens(
    request.messages.map((message) => message.content).join('\n'),
  );
}

function hashMessages(request: AiRequest) {
  return sha256(
    JSON.stringify({
      taskType: request.taskType,
      strategy: request.strategy,
      promptVersion: request.promptVersion,
      messages: request.messages,
    }),
  );
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function shanghaiUsageDate(now = Date.now()) {
  const value = new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 10);
  return new Date(`${value}T00:00:00.000Z`);
}

function taskLimits(taskType: AiRequest['taskType']) {
  const prefix =
    taskType === 'SHORT_ANSWER_GRADING'
      ? 'AI_SHORT_ANSWER_GRADING'
      : taskType === 'CURRICULUM_MAPPING'
        ? 'AI_CURRICULUM_MAPPING'
        : taskType === 'DAILY_PLAN'
          ? 'AI_DAILY_PLAN'
          : 'AI_CHAT';
  return {
    concurrency: boundedInteger(`${prefix}_CONCURRENCY`, 1, 20, 3),
    dailyCalls: boundedInteger(`${prefix}_DAILY_CALL_LIMIT`, 1, 100_000, 1_000),
    dailyTokens: boundedInteger(
      `${prefix}_DAILY_TOKEN_LIMIT`,
      1_000,
      1_000_000_000,
      10_000_000,
    ),
  };
}

function boundedInteger(
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new AiClientError(
      `${name} 必须是 ${minimum} 到 ${maximum} 的整数`,
      'CONFIGURATION',
      false,
    );
  }
  return value;
}

interface Pricing {
  version: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
}

function pricingFor(_strategy: AiRequest['strategy']): Pricing {
  const tier = 'FLASH';
  return {
    version: process.env.AI_PRICING_VERSION ?? 'unpriced-v1',
    inputMicrosPerMillion: nonNegativeInteger(
      `AI_${tier}_INPUT_COST_MICROS_PER_MILLION`,
    ),
    outputMicrosPerMillion: nonNegativeInteger(
      `AI_${tier}_OUTPUT_COST_MICROS_PER_MILLION`,
    ),
  };
}

function pricingForInvocation(model: string): Pricing {
  return pricingFor(model.includes('pro') ? 'PRO_HIGH' : 'FLASH_HIGH');
}

function nonNegativeInteger(name: string) {
  const value = Number(process.env[name] ?? 0);
  if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000_000) {
    throw new AiClientError(
      `${name} 必须是非负整数`,
      'CONFIGURATION',
      false,
    );
  }
  return value;
}

function estimateCostMicros(
  inputTokens: number,
  outputTokens: number,
  pricing: Pricing,
) {
  return BigInt(
    Math.ceil(
      (inputTokens * pricing.inputMicrosPerMillion +
        outputTokens * pricing.outputMicrosPerMillion) /
        1_000_000,
    ),
  );
}

async function recoverExpiredInvocations(
  transaction: Prisma.TransactionClient,
  now: Date,
) {
  const expired = await transaction.aiInvocation.findMany({
    where: {
      status: {
        in: [AiInvocationStatus.RESERVED, AiInvocationStatus.RUNNING],
      },
      leasedUntil: { lt: now },
    },
    select: {
      id: true,
      taskType: true,
      reservedTokens: true,
      createdAt: true,
    },
    take: 100,
  });
  if (!expired.length) return;
  await transaction.aiInvocation.updateMany({
    where: { id: { in: expired.map((item) => item.id) } },
    data: {
      status: AiInvocationStatus.EXPIRED,
      leasedUntil: null,
      completedAt: now,
      errorCategory: 'LEASE_EXPIRED',
      errorMessage: '调用租约过期，额度已回收',
      reservedTokens: 0,
    },
  });
  const groups = new Map<string, {
    usageDate: Date;
    taskType: AiTaskType;
    activeCalls: number;
    reservedTokens: number;
  }>();
  for (const item of expired) {
    const usageDate = shanghaiUsageDate(item.createdAt.getTime());
    const key = `${usageDate.toISOString()}\0${item.taskType}`;
    const group = groups.get(key) ?? {
      usageDate,
      taskType: item.taskType,
      activeCalls: 0,
      reservedTokens: 0,
    };
    group.activeCalls += 1;
    group.reservedTokens += item.reservedTokens;
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    await transaction.$executeRaw(
      Prisma.sql`
        UPDATE AiDailyUsage
        SET activeCalls = GREATEST(activeCalls - ${group.activeCalls}, 0),
            reservedTokens = GREATEST(reservedTokens - ${group.reservedTokens}, 0),
            failures = failures + ${group.activeCalls}
        WHERE usageDate = ${group.usageDate}
          AND scope = 'GLOBAL'
          AND taskType = ${group.taskType}
      `,
    );
  }
}

function isSerializationConflict(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2034'
  );
}

function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/giu, 'Bearer [redacted]').slice(0, 500);
}
