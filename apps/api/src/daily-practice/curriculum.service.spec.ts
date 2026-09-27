import { ConflictException } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';
import type { AuditService } from '../common/audit.service';
import { CurriculumService } from './curriculum.service';

describe('curriculum mapping retry', () => {
  function setup(count = 1) {
    const tx = {
      practiceQuestionMapping: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            question: { contentRevision: 3 },
            course: { topicHash: 'new-hash' },
          }),
        updateMany: jest.fn().mockResolvedValue({ count }),
      },
      dailyPracticeDay: { updateMany: jest.fn() },
      dailyPracticeCycle: { updateMany: jest.fn() },
    };
    const prisma = { $transaction: jest.fn(async (callback) => callback(tx)) };
    const audit = { record: jest.fn() };
    const service = new CurriculumService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
    return { tx, audit, service };
  }

  it('atomically invalidates only unstarted plans and fences an in-flight matcher', async () => {
    const { tx, audit, service } = setup();
    await service.retryMapping({ id: 'admin' } as User, 'question', 4);
    expect(tx.practiceQuestionMapping.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { questionId: 'question', revision: 4 },
        data: expect.objectContaining({
          status: 'PENDING',
          contentRevision: 3,
          topicHash: 'new-hash',
          leaseOwnerToken: null,
          revision: { increment: 1 },
        }),
      }),
    );
    expect(tx.dailyPracticeDay.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startedAt: null,
          status: { notIn: ['STARTED', 'COMPLETED'] },
        }),
        data: expect.objectContaining({ status: 'STALE' }),
      }),
    );
    expect(tx.dailyPracticeCycle.updateMany).toHaveBeenCalled();
    expect(audit.record.mock.calls[0]?.at(-1)).toBe(tx);
  });

  it('rejects a stale administrator revision before changing plans or audit', async () => {
    const { tx, audit, service } = setup(0);
    await expect(
      service.retryMapping({ id: 'admin' } as User, 'question', 4),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.dailyPracticeDay.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
