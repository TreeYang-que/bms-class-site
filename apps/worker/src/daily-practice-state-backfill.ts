import { randomUUID } from 'node:crypto';
import {
  applySubmittedAttemptState,
  AttemptStateValidationError,
  type SubmittedAttemptStateInput,
} from '@bmc3/daily-practice-prisma';
import {
  UserPracticeInitializationStatus,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { safeAiErrorMessage } from './ai-invocation-gateway';

const activeProfileLeases = new Map<string, string>();

export interface StateBackfillOptions {
  now?: Date;
  leaseMs?: number;
  batchSize?: number;
  applyAttemptState?: typeof applySubmittedAttemptState;
}

export async function processNextPracticeStateBackfill(
  prisma: PrismaClient,
  options: StateBackfillOptions = {},
) {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? configuredInteger(
    'DAILY_PRACTICE_JOB_LEASE_MS',
    60_000,
    60 * 60_000,
    10 * 60_000,
  );
  const batchSize = options.batchSize ?? configuredInteger(
    'DAILY_PRACTICE_STATE_BACKFILL_BATCH_SIZE',
    1,
    500,
    25,
  );
  const claimed = await claimBackfillProfile(prisma, now, leaseMs);
  if (!claimed) return false;
  activeProfileLeases.set(claimed.userId, claimed.ownerToken);
  try {
    const attempts = await prisma.quizAttempt.findMany({
      where: {
        userId: claimed.userId,
        submittedAt: { not: null },
        OR: [{ knowledgeStateAppliedAt: null }, { questionStateAppliedAt: null }],
      },
      orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
      select: {
        id: true,
        userId: true,
        snapshot: true,
        results: true,
        submittedAt: true,
        dailyPracticePlanRevisionId: true,
      },
    });
    for (const attempt of attempts) {
      if (!attempt.submittedAt) continue;
      await prisma.$transaction(async (transaction) => {
        const applied = await (options.applyAttemptState ?? applySubmittedAttemptState)(
          transaction,
          attempt as SubmittedAttemptStateInput,
          new Date(),
        );
        if (applied.deferred) {
          throw new PracticeStateOrderingError(
            'state backfill selected an attempt before an older pending attempt',
          );
        }
        const checkpoint = await transaction.userPracticeProfile.updateMany({
          where: {
            userId: claimed.userId,
            leaseOwnerToken: claimed.ownerToken,
            initializationStatus: UserPracticeInitializationStatus.PROCESSING,
          },
          data: {
            initializedThroughAttemptId: attempt.id,
            initializedThroughAttemptAt: attempt.submittedAt,
            leasedUntil: new Date(Date.now() + leaseMs),
            initializationError: null,
          },
        });
        if (checkpoint.count !== 1) {
          throw new PracticeStateLeaseLostError('state backfill profile lease was lost');
        }
        return applied;
      });
    }
    const remaining = await prisma.quizAttempt.count({
      where: {
        userId: claimed.userId,
        submittedAt: { not: null },
        OR: [{ knowledgeStateAppliedAt: null }, { questionStateAppliedAt: null }],
      },
    });
    const updated = await prisma.userPracticeProfile.updateMany({
      where: {
        userId: claimed.userId,
        leaseOwnerToken: claimed.ownerToken,
        initializationStatus: UserPracticeInitializationStatus.PROCESSING,
      },
      data: remaining
        ? {
            initializationStatus: UserPracticeInitializationStatus.PENDING,
            leaseOwnerToken: null,
            leasedUntil: null,
          }
        : {
            initializationStatus: UserPracticeInitializationStatus.READY,
            initializedThroughAttemptAt:
              attempts.at(-1)?.submittedAt ?? claimed.initializedThroughAttemptAt,
            leaseOwnerToken: null,
            leasedUntil: null,
            initializationError: null,
          },
    });
    if (updated.count !== 1) {
      throw new PracticeStateLeaseLostError('state backfill final lease was lost');
    }
    return true;
  } catch (error) {
    const permanent = error instanceof AttemptStateValidationError;
    await prisma.userPracticeProfile.updateMany({
      where: {
        userId: claimed.userId,
        leaseOwnerToken: claimed.ownerToken,
      },
      data: {
        initializationStatus: permanent
          ? UserPracticeInitializationStatus.FAILED
          : UserPracticeInitializationStatus.PENDING,
        initializationError: safeAiErrorMessage(error).slice(0, 500),
        leaseOwnerToken: null,
        leasedUntil: null,
      },
    });
    if (permanent) return true;
    throw error;
  } finally {
    activeProfileLeases.delete(claimed.userId);
  }
}

export async function releaseActivePracticeStateBackfills(prisma: PrismaClient) {
  const leases = [...activeProfileLeases.entries()];
  for (const [userId, ownerToken] of leases) {
    await prisma.userPracticeProfile.updateMany({
      where: { userId, leaseOwnerToken: ownerToken },
      data: {
        initializationStatus: UserPracticeInitializationStatus.PENDING,
        leaseOwnerToken: null,
        leasedUntil: null,
      },
    });
    activeProfileLeases.delete(userId);
  }
}

async function claimBackfillProfile(
  prisma: PrismaClient,
  now: Date,
  leaseMs: number,
) {
  const pendingAttempts = await prisma.quizAttempt.findMany({
    where: {
      submittedAt: { not: null },
      AND: [{ OR: [{ knowledgeStateAppliedAt: null }, { questionStateAppliedAt: null }] }],
      OR: [
        { user: { practiceProfile: { is: null } } },
        {
          user: {
            practiceProfile: {
              is: {
                initializationStatus: {
                  not: UserPracticeInitializationStatus.FAILED,
                },
                OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
              },
            },
          },
        },
      ],
    },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
    distinct: ['userId'],
    take: 50,
    select: { userId: true },
  });
  for (const pendingAttempt of pendingAttempts) {
    const userId = pendingAttempt.userId;
    await prisma.userPracticeProfile.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
    const ownerToken = randomUUID();
    const claimed = await prisma.userPracticeProfile.updateMany({
      where: {
        userId,
        initializationStatus: {
          not: UserPracticeInitializationStatus.FAILED,
        },
        OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
      },
      data: {
        initializationStatus: UserPracticeInitializationStatus.PROCESSING,
        leaseOwnerToken: ownerToken,
        leasedUntil: new Date(now.getTime() + leaseMs),
        initializationError: null,
      },
    });
    if (claimed.count !== 1) continue;
    const profile = await prisma.userPracticeProfile.findUniqueOrThrow({
      where: { userId },
      select: { initializedThroughAttemptAt: true },
    });
    return { userId, ownerToken, ...profile };
  }
  const fallbackCandidate = await prisma.userPracticeProfile.findFirst({
    where: {
      initializationStatus: {
        in: [
          UserPracticeInitializationStatus.PENDING,
          UserPracticeInitializationStatus.PROCESSING,
        ],
      },
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
    },
    orderBy: [{ updatedAt: 'asc' }, { userId: 'asc' }],
    select: { userId: true },
  });
  const userId = fallbackCandidate?.userId ?? null;
  if (!userId) return null;
  const ownerToken = randomUUID();
  const claimed = await prisma.userPracticeProfile.updateMany({
    where: {
      userId,
      initializationStatus: {
        in: [
          UserPracticeInitializationStatus.PENDING,
          UserPracticeInitializationStatus.PROCESSING,
        ],
      },
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: now } }],
    },
    data: {
      initializationStatus: UserPracticeInitializationStatus.PROCESSING,
      leaseOwnerToken: ownerToken,
      leasedUntil: new Date(now.getTime() + leaseMs),
      initializationError: null,
    },
  });
  if (claimed.count !== 1) return null;
  const profileState = await prisma.userPracticeProfile.findUniqueOrThrow({
    where: { userId },
    select: { initializedThroughAttemptAt: true },
  });
  return { userId, ownerToken, ...profileState };
}

function configuredInteger(
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be ${minimum}-${maximum}`);
  }
  return value;
}

export class PracticeStateLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PracticeStateLeaseLostError';
  }
}

export class PracticeStateOrderingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PracticeStateOrderingError';
  }
}

export type PracticeStateBackfillTransaction = Prisma.TransactionClient;
