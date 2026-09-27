-- AlterTable
ALTER TABLE `QuizQuestion` ADD COLUMN `contentRevision` INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE `AiInvocation` MODIFY `taskType` ENUM('CHAT_QA', 'QUESTION_GENERATION', 'SHORT_ANSWER_GRADING', 'DAILY_PLAN', 'CREDIT_HOUR_REVIEW', 'CURRICULUM_MAPPING') NOT NULL;

-- AlterTable
ALTER TABLE `AiDailyUsage` DROP PRIMARY KEY,
    MODIFY `taskType` ENUM('CHAT_QA', 'QUESTION_GENERATION', 'SHORT_ANSWER_GRADING', 'DAILY_PLAN', 'CREDIT_HOUR_REVIEW', 'CURRICULUM_MAPPING') NOT NULL,
    ADD PRIMARY KEY (`usageDate`, `scope`, `taskType`);

-- AlterTable
ALTER TABLE `QuizAttempt` ADD COLUMN `questionStateAppliedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `DailyPracticePlanItem` ADD COLUMN `questionContentRevision` INTEGER NULL;

-- CreateTable
CREATE TABLE `PracticeCourse` (
    `id` VARCHAR(191) NOT NULL,
    `subjectId` VARCHAR(191) NOT NULL,
    `termKey` VARCHAR(80) NOT NULL,
    `startDate` DATE NOT NULL,
    `examDate` DATE NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `topicHash` CHAR(64) NOT NULL,
    `topics` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PracticeCourse_enabled_startDate_examDate_idx`(`enabled`, `startDate`, `examDate`),
    UNIQUE INDEX `PracticeCourse_subjectId_termKey_key`(`subjectId`, `termKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PracticeCourseRevision` (
    `id` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `snapshot` JSON NOT NULL,
    `reason` VARCHAR(1000) NOT NULL,
    `publishedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PracticeCourseRevision_courseId_revision_key`(`courseId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PracticeQuestionMapping` (
    `questionId` VARCHAR(191) NOT NULL,
    `courseId` VARCHAR(191) NOT NULL,
    `contentRevision` INTEGER NOT NULL,
    `topicHash` CHAR(64) NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'READY', 'NEEDS_REVIEW') NOT NULL DEFAULT 'PENDING',
    `topicIds` JSON NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `confidence` DOUBLE NULL,
    `manual` BOOLEAN NOT NULL DEFAULT false,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `leaseOwnerToken` VARCHAR(191) NULL,
    `leasedUntil` DATETIME(3) NULL,
    `lastError` VARCHAR(500) NULL,
    `promptVersion` VARCHAR(80) NOT NULL DEFAULT 'curriculum-mapping-v1',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PracticeQuestionMapping_status_leasedUntil_updatedAt_idx`(`status`, `leasedUntil`, `updatedAt`),
    INDEX `PracticeQuestionMapping_courseId_status_idx`(`courseId`, `status`),
    PRIMARY KEY (`questionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserQuestionState` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `questionId` VARCHAR(191) NOT NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `correctCount` INTEGER NOT NULL DEFAULT 0,
    `wrongCount` INTEGER NOT NULL DEFAULT 0,
    `masteryBps` INTEGER NOT NULL DEFAULT 0,
    `correctStreak` INTEGER NOT NULL DEFAULT 0,
    `lastScoreBps` INTEGER NULL,
    `lastAssignedAt` DATETIME(3) NULL,
    `lastPracticedAt` DATETIME(3) NULL,
    `lastWrongAt` DATETIME(3) NULL,
    `nextReviewAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `UserQuestionState_userId_nextReviewAt_idx`(`userId`, `nextReviewAt`),
    UNIQUE INDEX `UserQuestionState_userId_questionId_key`(`userId`, `questionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `QuizAttempt_questionStateAppliedAt_submittedAt_id_idx` ON `QuizAttempt`(`questionStateAppliedAt`, `submittedAt`, `id`);

-- AddForeignKey
ALTER TABLE `PracticeCourse` ADD CONSTRAINT `PracticeCourse_subjectId_fkey` FOREIGN KEY (`subjectId`) REFERENCES `KnowledgeSubject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PracticeCourseRevision` ADD CONSTRAINT `PracticeCourseRevision_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `PracticeCourse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PracticeQuestionMapping` ADD CONSTRAINT `PracticeQuestionMapping_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `QuizQuestion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PracticeQuestionMapping` ADD CONSTRAINT `PracticeQuestionMapping_courseId_fkey` FOREIGN KEY (`courseId`) REFERENCES `PracticeCourse`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserQuestionState` ADD CONSTRAINT `UserQuestionState_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserQuestionState` ADD CONSTRAINT `UserQuestionState_questionId_fkey` FOREIGN KEY (`questionId`) REFERENCES `QuizQuestion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
