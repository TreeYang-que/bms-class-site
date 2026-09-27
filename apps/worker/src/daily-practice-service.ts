import type { Prisma, PrismaClient } from '@prisma/client';
import { internalTestUsers } from '@bmc3/daily-practice-core';

type ServiceClient = Pick<
  PrismaClient | Prisma.TransactionClient,
  'dailyPracticeSettings' | 'dailyPracticeServicePause'
>;

export interface DailyPracticeServiceGate {
  open: boolean;
  settingsRevision: number;
  reason: string | null;
  pausedUntil: Date | null;
  internalTestUserIds: string[] | null;
}

export async function loadDailyPracticeServiceGate(
  prisma: ServiceClient,
  now = new Date(),
  userId?: string,
): Promise<DailyPracticeServiceGate> {
  const [settings, pause] = await Promise.all([
    prisma.dailyPracticeSettings.findUnique({
      where: { singletonId: 1 },
      select: { enabled: true, revision: true, reason: true, internalTestUserIds: true },
    }),
    prisma.dailyPracticeServicePause.findFirst({
      where: {
        cancelledAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
      select: { reason: true, endsAt: true },
    }),
  ]);
  const testIds = internalTestUsers(settings?.internalTestUserIds);
  const internalTestUserIds = settings?.enabled ? null : testIds;
  if (!settings?.enabled && !(userId ? testIds.includes(userId) : testIds.length > 0)) {
    return {
      open: false,
      settingsRevision: settings?.revision ?? 0,
      reason: settings?.reason ?? '每日一练服务未开启',
      pausedUntil: null,
      internalTestUserIds,
    };
  }
  if (pause) {
    return {
      open: false,
      settingsRevision: settings?.revision ?? 0,
      reason: pause.reason,
      pausedUntil: pause.endsAt,
      internalTestUserIds,
    };
  }
  return {
    open: true,
    settingsRevision: settings?.revision ?? 0,
    reason: null,
    pausedUntil: null,
    internalTestUserIds,
  };
}

export async function loadDailyPracticeDayGate(prisma: ServiceClient & Pick<PrismaClient | Prisma.TransactionClient, 'dailyPracticeDay'>, dayId: string, now = new Date()) {
  const day = await prisma.dailyPracticeDay.findUnique({ where: { id: dayId }, select: { userId: true } });
  const gate = await loadDailyPracticeServiceGate(prisma, now, day?.userId ?? '');
  return { ...gate, open: Boolean(day && gate.open) };
}
