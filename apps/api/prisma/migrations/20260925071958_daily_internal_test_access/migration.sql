-- Generated with prisma migrate dev in an isolated disposable database.
-- Unrelated historical constraint/index naming drift was excluded during review.
ALTER TABLE `DailyPracticeSettings` ADD COLUMN `internalTestUserIds` JSON NULL;
