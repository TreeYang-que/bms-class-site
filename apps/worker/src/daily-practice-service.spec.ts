import { loadDailyPracticeServiceGate } from './daily-practice-service';

it('limits a paused global service to explicitly selected test users, while letting the scheduler run', async () => {
  const prisma = {
    dailyPracticeSettings: { findUnique: jest.fn(async () => ({ enabled: false, revision: 5, internalTestUserIds: ['tester'], reason: '全站暂停' })) },
    dailyPracticeServicePause: { findFirst: jest.fn(async () => null) },
  };
  const now = new Date('2026-09-25T06:00:00Z');
  expect(await loadDailyPracticeServiceGate(prisma as never, now)).toMatchObject({ open: true, internalTestUserIds: ['tester'] });
  expect(await loadDailyPracticeServiceGate(prisma as never, now, 'tester')).toMatchObject({ open: true });
  expect(await loadDailyPracticeServiceGate(prisma as never, now, 'other')).toMatchObject({ open: false });
  prisma.dailyPracticeSettings.findUnique.mockResolvedValue({ enabled: false, revision: 6, internalTestUserIds: [], reason: '撤销测试' });
  expect(await loadDailyPracticeServiceGate(prisma as never, now, 'tester')).toMatchObject({ open: false });
});

it('keeps scheduled pauses effective for internal testers', async () => {
  const prisma = {
    dailyPracticeSettings: { findUnique: jest.fn(async () => ({ enabled: false, revision: 5, internalTestUserIds: ['tester'] })) },
    dailyPracticeServicePause: { findFirst: jest.fn(async () => ({ reason: '维护', endsAt: new Date('2026-09-26T00:00:00Z') })) },
  };
  expect(await loadDailyPracticeServiceGate(prisma as never, new Date(), 'tester')).toMatchObject({ open: false, reason: '维护' });
});
