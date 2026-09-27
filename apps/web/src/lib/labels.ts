import type {
  AccountStatus,
  ContentStatus,
  DailyPracticeCycleStatus,
  DailyPracticeGenerationSource,
  DailyPracticeIntensity,
  DailyPracticeSuggestionStatus,
  DailyPracticeTodayStatus,
  IndexStatus,
  KnowledgeKind,
  QuestionType,
  Role,
  TeachingProgressChangeType,
  Visibility,
} from "../types";

/** 英文枚举值不得在界面出现，统一映射为中文标签 */

export const roleLabels: Record<Role, string> = {
  MEMBER: "成员",
  EDITOR: "编辑",
  ADMIN: "管理员",
};

export const accountStatusLabels: Record<AccountStatus, string> = {
  PENDING: "待审核",
  ACTIVE: "正常",
  SUSPENDED: "已停用",
};

export const accountStatusTones: Record<AccountStatus, string> = {
  PENDING: "warning",
  ACTIVE: "success",
  SUSPENDED: "danger",
};

export const visibilityLabels: Record<Visibility, string> = {
  PUBLIC: "公开",
  MEMBERS: "成员可见",
};

export const contentStatusLabels: Record<ContentStatus, string> = {
  DRAFT: "草稿",
  PUBLISHED: "已发布",
  ARCHIVED: "已归档",
};

export const knowledgeKindLabels: Record<KnowledgeKind, string> = {
  ARTICLE: "文章",
  PDF: "PDF 文档",
  DOCX: "Word 文档",
  MARKDOWN: "Markdown",
};

export const indexStatusLabels: Record<IndexStatus, string> = {
  PENDING: "等待索引",
  PROCESSING: "索引中",
  READY: "已索引",
  FAILED: "索引失败",
};

export const indexStatusTones: Record<IndexStatus, string> = {
  PENDING: "muted",
  PROCESSING: "warning",
  READY: "success",
  FAILED: "danger",
};

export const questionTypeLabels: Record<QuestionType, string> = {
  SINGLE: "单选题",
  MULTIPLE: "多选题",
  TRUE_FALSE: "判断题",
  SHORT_ANSWER: "简答题",
};

export const dailyPracticeStatusLabels: Record<DailyPracticeTodayStatus, string> = {
  SERVICE_PAUSED: "服务暂停",
  INITIALIZING: "正在初始化",
  NO_TEACHING_PROGRESS: "等待教学进度",
  TERM_COMPLETED: "本学期练习已结束",
  GENERATING: "正在生成",
  PENDING: "等待生成",
  PROCESSING: "正在生成",
  READY: "今日计划已就绪",
  LIMITED_CONTENT: "可用题目有限",
  NO_CONTENT: "暂无个性化题目",
  DEGRADED_READY: "回退计划已就绪",
  FAILED: "生成失败",
  PAUSED: "计划已暂停",
  STARTED: "练习进行中",
  COMPLETED: "今日已完成",
  STALE: "计划需要更新",
};

export const dailyPracticeStatusTones: Record<DailyPracticeTodayStatus, string> = {
  SERVICE_PAUSED: "warning",
  INITIALIZING: "muted",
  NO_TEACHING_PROGRESS: "warning",
  TERM_COMPLETED: "muted",
  GENERATING: "accent",
  PENDING: "muted",
  PROCESSING: "accent",
  READY: "success",
  LIMITED_CONTENT: "warning",
  NO_CONTENT: "warning",
  DEGRADED_READY: "warning",
  FAILED: "danger",
  PAUSED: "warning",
  STARTED: "accent",
  COMPLETED: "success",
  STALE: "warning",
};

export const dailyPracticeGenerationLabels: Record<
  DailyPracticeGenerationSource,
  string
> = {
  PRO_MAX: "Flash Max",
  PRO_HIGH: "Flash 高思考回退",
  FLASH_HIGH: "Flash 标准思考回退",
  DETERMINISTIC: "规则生成",
  NO_MODEL: "无模型",
};

export const dailyPracticeIntensityLabels: Record<DailyPracticeIntensity, string> = {
  LIGHT: "轻量",
  STANDARD: "标准",
  CHALLENGING: "强化",
};

export const dailyPracticeSuggestionStatusLabels: Record<
  DailyPracticeSuggestionStatus,
  string
> = {
  PENDING: "待应用",
  APPLIED: "已采纳",
  PARTIALLY_APPLIED: "部分采纳",
  NOT_APPLIED: "未采纳",
  SUPERSEDED: "已被新建议替代",
  EXPIRED_SERVICE_PAUSED: "因停服过期",
};

/** 兜底：映射缺失时返回原值，避免界面出现 undefined */
export function labelOf(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

export const dailyPracticeCycleStatusLabels: Record<
  DailyPracticeCycleStatus,
  string
> = {
  BUILDING: "正在构建",
  GENERATING: "正在生成",
  READY: "已就绪",
  PAUSED: "已暂停",
  DEGRADED: "已降级",
  FAILED: "生成失败",
};

export const dailyPracticeCycleStatusTones: Record<
  DailyPracticeCycleStatus,
  string
> = {
  BUILDING: "accent",
  GENERATING: "accent",
  READY: "success",
  PAUSED: "warning",
  DEGRADED: "warning",
  FAILED: "danger",
};

export const teachingProgressChangeTypeLabels: Record<
  TeachingProgressChangeType,
  string
> = {
  INITIAL: "首次发布",
  ADD: "新增",
  CORRECTION: "更正",
};
