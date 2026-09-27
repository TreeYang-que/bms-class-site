import { ApiClientError, api } from './api';
import type {
  AdminDailyPracticePlanActionResponse,
  AdminDailyPracticeSuggestionRequest,
  AdminDailyPracticeUserDetail,
  AdminDailyPracticeUserListResponse,
  DailyPracticeCycleAggregate,
  DailyPracticeCycleListResponse,
  DailyPracticeCycleRefreezeResponse,
  DailyPracticeFixedAssignment,
  DailyPracticeFixedAssignmentPublishRequest,
  DailyPracticeFixedQuestionCandidate,
  DailyPracticeGenerationSource,
  DailyPracticeHistoryDetail,
  DailyPracticeHistoryResponse,
  DailyPracticeServicePause,
  DailyPracticeServicePauseCreateRequest,
  DailyPracticeSettingsResponse,
  DailyPracticeSettingsUpdateRequest,
  DailyPracticeStartResponse,
  DailyPracticeSuggestionPayload,
  DailyPracticeSuggestionRecord,
  DailyPracticeTodayResponse,
  Page,
  PracticeCourseTopic,
  PracticeCourseView,
  PracticeQuestionMappingView,
} from '../types';

type RequestSignal = { signal?: AbortSignal };

export interface PracticeCourseHistoryEntry {
  id: string;
  revision: number;
  snapshot: { examDate: string; enabled: boolean; topics: PracticeCourseTopic[] };
  reason: string;
  publishedById: string;
  createdAt: string;
}

export function getPracticeCurriculum(options: RequestSignal = {}) {
  return api<{ practiceDate: string; initialized: boolean; courses: PracticeCourseView[] }>(
    '/admin/daily-practice/curriculum', { signal: options.signal },
  );
}

export function initializePracticeCurriculum() {
  return api('/admin/daily-practice/curriculum/initialize', {
    method: 'POST', body: JSON.stringify({}),
  });
}

export function updatePracticeCourse(id: string, payload: {
  expectedRevision: number;
  examDate?: string;
  enabled?: boolean;
  topics?: PracticeCourseTopic[];
  reason: string;
}) {
  return api<PracticeCourseView>(`/admin/daily-practice/curriculum/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(payload),
  });
}

export function getPracticeCourseHistory(id: string, options: RequestSignal = {}) {
  return api<{ items: PracticeCourseHistoryEntry[] }>(
    `/admin/daily-practice/curriculum/${encodeURIComponent(id)}/history`,
    { signal: options.signal },
  );
}

export function getQuestionMappings(params: {
  courseId: string; status?: string; page?: number; pageSize?: number;
}, options: RequestSignal = {}) {
  return api<Page<PracticeQuestionMappingView>>(
    `/admin/daily-practice/question-mappings${queryOf(params)}`,
    { signal: options.signal },
  );
}

export function updateQuestionMapping(questionId: string, payload: {
  expectedContentRevision?: number;
  expectedRevision: number; topicIds: string[]; reason: string;
}) {
  return api<PracticeQuestionMappingView>(
    `/admin/daily-practice/question-mappings/${encodeURIComponent(questionId)}`,
    { method: 'PATCH', body: JSON.stringify(payload) },
  );
}

export function retryQuestionMapping(questionId: string, expectedRevision: number) {
  return api(`/admin/daily-practice/question-mappings/${encodeURIComponent(questionId)}/retry`, {
    method: 'POST', body: JSON.stringify({ expectedRevision }),
  });
}

export function queueCourseQuestionMappings(courseId: string) {
  return api(`/admin/daily-practice/curriculum/${encodeURIComponent(courseId)}/queue-mappings`, {
    method: 'POST', body: JSON.stringify({}),
  });
}

function queryOf(values: Record<string, string | number | boolean | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `?${suffix}` : '';
}

export function shanghaiPracticeDate(offsetDays = 0, now = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(now),
  );
  const currentDayInstant = new Date(
    now.getTime() + (offsetDays - (hour < 4 ? 1 : 0)) * 86_400_000,
  );
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(currentDayInstant);
}

export function getToday(options: RequestSignal = {}) {
  return api<DailyPracticeTodayResponse>('/daily-practice/today', {
    signal: options.signal,
  });
}

export function startDailyPlan(planId: string) {
  return api<DailyPracticeStartResponse>(
    `/daily-practice/plans/${encodeURIComponent(planId)}/start`,
    { method: 'POST' },
  );
}

export function submitDailySuggestion(payload: DailyPracticeSuggestionPayload) {
  return api<DailyPracticeSuggestionRecord>('/daily-practice/suggestions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getDailyHistory(
  page: number,
  pageSize: number,
  options: RequestSignal = {},
) {
  return api<DailyPracticeHistoryResponse>(
    `/daily-practice/history${queryOf({ page, pageSize })}`,
    { signal: options.signal },
  );
}

export function getDailyHistoryDetail(
  planId: string,
  options: RequestSignal = {},
) {
  return api<DailyPracticeHistoryDetail>(
    `/daily-practice/history/${encodeURIComponent(planId)}`,
    { signal: options.signal },
  );
}

export function getDailySettings() {
  return api<DailyPracticeSettingsResponse>('/admin/daily-practice/settings');
}

export function updateDailySettings(payload: DailyPracticeSettingsUpdateRequest) {
  return api<DailyPracticeSettingsResponse>('/admin/daily-practice/settings', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function getServicePauses(page = 1, pageSize = 20) {
  return api<Page<DailyPracticeServicePause>>(
    `/admin/daily-practice/service-pauses${queryOf({ page, pageSize })}`,
  );
}

export function createServicePause(payload: DailyPracticeServicePauseCreateRequest) {
  return api<DailyPracticeServicePause>('/admin/daily-practice/service-pauses', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function cancelServicePause(id: string) {
  return api<DailyPracticeServicePause>(
    `/admin/daily-practice/service-pauses/${encodeURIComponent(id)}/cancel`,
    { method: 'POST' },
  );
}

export interface FixedQuestionFilters {
  practiceDate?: string;
  subjectId?: string;
  chapterIds?: string[];
  chapterMatch?: 'ANY' | 'ALL';
  includeCrossChapter?: boolean;
  typeLabel?: string;
  pastPaper?: 'ALL' | 'EXCLUDE' | 'ONLY';
  search?: string;
  page?: number;
  pageSize?: number;
}

export function getFixedQuestionCandidates(
  filters: FixedQuestionFilters,
  options: RequestSignal = {},
) {
  return api<Page<DailyPracticeFixedQuestionCandidate>>(
    `/admin/daily-practice/fixed-question-candidates${queryOf({
      practiceDate: filters.practiceDate,
      subjectId: filters.subjectId,
      chapterIds: filters.chapterIds?.join(','),
      chapterMatch: filters.chapterIds?.length ? filters.chapterMatch : undefined,
      includeCrossChapter: filters.includeCrossChapter ?? false,
      typeLabel: filters.typeLabel,
      pastPaper: filters.pastPaper === 'ALL' ? undefined : filters.pastPaper,
      search: filters.search,
      page: filters.page ?? 1,
      pageSize: filters.pageSize ?? 20,
    })}`,
    { signal: options.signal },
  );
}

export async function getFixedAssignment(
  practiceDate: string,
  options: RequestSignal = {},
) {
  try {
    return await api<DailyPracticeFixedAssignment>(
      `/admin/daily-practice/fixed-assignments/${encodeURIComponent(practiceDate)}`,
      { signal: options.signal },
    );
  } catch (caught) {
    if (caught instanceof ApiClientError && caught.status === 404) return null;
    throw caught;
  }
}

export function publishFixedAssignment(
  payload: DailyPracticeFixedAssignmentPublishRequest,
) {
  return api<DailyPracticeFixedAssignment>(
    '/admin/daily-practice/fixed-assignments',
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export async function getDailyCycle(
  practiceDate: string,
  options: RequestSignal = {},
) {
  try {
    return await api<DailyPracticeCycleAggregate>(
      `/admin/daily-practice/cycles/${encodeURIComponent(practiceDate)}`,
      { signal: options.signal },
    );
  } catch (caught) {
    if (caught instanceof ApiClientError && caught.status === 404) return null;
    throw caught;
  }
}

export function getDailyCycles(
  params: { from?: string; to?: string; page?: number; pageSize?: number } = {},
  options: RequestSignal = {},
) {
  return api<DailyPracticeCycleListResponse>(
    `/admin/daily-practice/cycles${queryOf({
      from: params.from,
      to: params.to,
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 20,
    })}`,
    { signal: options.signal },
  );
}

export function refreezeDailyCycle(practiceDate: string) {
  return api<DailyPracticeCycleRefreezeResponse>(
    `/admin/daily-practice/cycles/${encodeURIComponent(practiceDate)}/refreeze`,
    { method: 'POST' },
  );
}

export interface AdminUserFilters {
  search?: string;
  planStatus?: string;
  generationSource?: DailyPracticeGenerationSource | '';
  completed?: boolean;
  hasSuggestion?: boolean;
  hasGap?: boolean;
  page?: number;
  pageSize?: number;
}

export function getAdminDailyUsers(
  filters: AdminUserFilters,
  options: RequestSignal = {},
) {
  return api<AdminDailyPracticeUserListResponse>(
    `/admin/daily-practice/users${queryOf({
      search: filters.search,
      planStatus: filters.planStatus,
      generationSource: filters.generationSource,
      completed: filters.completed,
      hasSuggestion: filters.hasSuggestion,
      hasGap: filters.hasGap,
      page: filters.page ?? 1,
      pageSize: filters.pageSize ?? 20,
    })}`,
    { signal: options.signal },
  );
}

export function getAdminDailyUser(userId: string, options: RequestSignal = {}) {
  return api<AdminDailyPracticeUserDetail>(
    `/admin/daily-practice/users/${encodeURIComponent(userId)}`,
    { signal: options.signal },
  );
}

export function submitAdminDailySuggestion(
  userId: string,
  payload: AdminDailyPracticeSuggestionRequest,
) {
  return api<DailyPracticeSuggestionRecord>(
    `/admin/daily-practice/users/${encodeURIComponent(userId)}/suggestions`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export function regenerateAdminDailyPlan(userId: string, practiceDate: string) {
  return api<AdminDailyPracticePlanActionResponse>(
    `/admin/daily-practice/users/${encodeURIComponent(userId)}/plans/${encodeURIComponent(practiceDate)}/regenerate`,
    { method: 'POST' },
  );
}

export function previewAdminDailyPlan(userId: string, practiceDate: string) {
  return api<AdminDailyPracticePlanActionResponse>(
    `/admin/daily-practice/users/${encodeURIComponent(userId)}/plans/${encodeURIComponent(practiceDate)}/preview`,
    { method: 'POST' },
  );
}
