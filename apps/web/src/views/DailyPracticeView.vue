<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Clock3, Play, RefreshCw } from 'lucide-vue-next';
import PageHeader from '../components/layout/PageHeader.vue';
import EmptyState from '../components/common/EmptyState.vue';
import ErrorState from '../components/common/ErrorState.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import StatusBadge from '../components/common/StatusBadge.vue';
import DailyLearningSummary from '../components/daily/DailyLearningSummary.vue';
import DailyCourseProgress from '../components/daily/DailyCourseProgress.vue';
import DailyPlanPreview from '../components/daily/DailyPlanPreview.vue';
import DailyPracticeHistory from '../components/daily/DailyPracticeHistory.vue';
import DailySuggestionForm from '../components/daily/DailySuggestionForm.vue';
import QuizRunner from '../components/quiz/QuizRunner.vue';
import { api, formatError } from '../lib/api';
import { getToday } from '../lib/dailyPractice';
import { formatDateTime } from '../lib/formatters';
import {
  dailyPracticeGenerationLabels,
  dailyPracticeStatusLabels,
  dailyPracticeStatusTones,
} from '../lib/labels';
import { useToast } from '../composables/useToast';
import { useLatestRequest } from '../composables/useLatestRequest';
import type {
  DailyPracticeStartResponse,
  DailyPracticeSuggestionRecord,
  DailyPracticeTodayResponse,
  DailyPracticeTodayStatus,
  QuizAttemptLifecycle,
  QuizSubmitResponse,
} from '../types';

type DailyPracticeAttempt = QuizAttemptLifecycle & { planRevisionId: string };

const POLL_INTERVAL_MS = 5_000;
const pollingStatuses = new Set<DailyPracticeTodayStatus>([
  'INITIALIZING',
  'GENERATING',
  'PENDING',
  'PROCESSING',
  'STALE',
]);

const toast = useToast();
const today = ref<DailyPracticeTodayResponse | null>(null);
const loading = ref(false);
const loaded = ref(false);
const error = ref('');
const todayRequests = useLatestRequest();
const practiceRequests = useLatestRequest();
const starting = practiceRequests.loading;
const attempt = ref<DailyPracticeAttempt | null>(null);
const submittedResult = ref<QuizSubmitResponse | null>(null);
const historyRevision = ref(0);
let pollTimer: number | undefined;
let rolloverTimer: number | undefined;
let triggeredRollover = '';

const canEnterPractice = computed(() => {
  const value = today.value;
  if (!value?.planRevisionId || value.counts.total < 1) return false;
  if (value.attempt?.submittedAt || value.status === 'COMPLETED') return false;
  if (value.attempt) return true;
  return ['READY', 'LIMITED_CONTENT', 'DEGRADED_READY', 'NO_CONTENT'].includes(
    value.status,
  );
});

const actionLabel = computed(() =>
  today.value?.attempt ? '继续练习' : '开始今日练习',
);

const initializationPercent = computed(() => {
  const value = today.value?.initialization;
  if (!value?.totalAttempts) return 0;
  return Math.min(100, Math.round((value.appliedAttempts / value.totalAttempts) * 100));
});

function clearPoll() {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
}

function clearRollover() {
  if (rolloverTimer !== undefined) window.clearTimeout(rolloverTimer);
  rolloverTimer = undefined;
}

function scheduleRollover() {
  clearRollover();
  const boundary = today.value?.nextDayStartsAt;
  if (!boundary) return;
  const boundaryTime = Date.parse(boundary);
  if (!Number.isFinite(boundaryTime)) return;
  if (boundaryTime <= Date.now() && triggeredRollover === boundary) {
    rolloverTimer = window.setTimeout(() => void load(true), POLL_INTERVAL_MS);
    return;
  }
  const delay = Math.max(0, boundaryTime - Date.now() + 50);
  rolloverTimer = window.setTimeout(() => {
    triggeredRollover = boundary;
    void load(true);
  }, delay);
}

function schedulePoll() {
  clearPoll();
  if (today.value && pollingStatuses.has(today.value.status)) {
    pollTimer = window.setTimeout(() => void load(true), POLL_INTERVAL_MS);
  }
}

async function load(background = false) {
  if (!background) loading.value = true;
  error.value = '';
  await todayRequests.runLatest(
    ({ signal }) => getToday({ signal }),
    {
      commit(result) {
        today.value = result;
        loaded.value = true;
      },
      onError(caught) {
        error.value = formatError(caught, '今日练习加载失败');
      },
      onFinally() {
        loading.value = false;
        schedulePoll();
        scheduleRollover();
      },
    },
  );
}

async function enterPractice() {
  const planId = today.value?.planRevisionId;
  if (!planId || !canEnterPractice.value || starting.value) return;
  const result = await practiceRequests.runLatest(
    async ({ signal, isCurrent }) => {
      const started = await api<DailyPracticeStartResponse>(
        `/daily-practice/plans/${encodeURIComponent(planId)}/start`,
        { method: 'POST', signal },
      );
      if (started.planRevisionId !== planId) {
        throw new Error('今日练习计划已变化，请刷新后重试');
      }
      if (!isCurrent()) throw new DOMException('请求已取消', 'AbortError');
      const lifecycle = await api<QuizAttemptLifecycle>(
        `/quizzes/attempts/${encodeURIComponent(started.attemptId)}`,
        { signal },
      );
      if (lifecycle.attemptId !== started.attemptId) {
        throw new Error('答题记录与今日练习不匹配');
      }
      return { ...lifecycle, planRevisionId: started.planRevisionId };
    },
    {
      commit(restored) {
        if (today.value?.planRevisionId !== planId) return;
        attempt.value = restored;
        submittedResult.value = null;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
    },
  );
  if (result.status === 'failed') {
    toast.error(formatError(result.error, '无法开始今日练习'));
    await load(true);
  }
}

function onSubmitted(result: QuizSubmitResponse) {
  submittedResult.value = result;
}

async function finishAttempt() {
  historyRevision.value += 1;
  attempt.value = null;
  submittedResult.value = null;
  await load();
}

function onSuggestionSaved(record: DailyPracticeSuggestionRecord) {
  if (!today.value) return;
  if (record.targetPracticeDate !== today.value.suggestion.targetPracticeDate) {
    void load(true);
    return;
  }
  today.value = {
    ...today.value,
    suggestion: {
      ...today.value.suggestion,
      available: false,
      current: record,
    },
  };
}

function onSuggestionConflict() {
  void load(true);
}

onMounted(() => void load());
onBeforeUnmount(() => {
  todayRequests.cancelLatest();
  practiceRequests.cancelLatest();
  clearPoll();
  clearRollover();
});
</script>

<template>
  <main class="page daily-page">
    <PageHeader
      title="每日一练"
      description="每日 4:00 开始更新。"
    >
      <template #breadcrumb>
        <RouterLink to="/">首页</RouterLink>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">每日一练</span>
      </template>
    </PageHeader>

    <section class="page-content daily-content">
      <QuizRunner
        v-if="attempt"
        :key="attempt.attemptId"
        :attempt-id="attempt.attemptId"
        :questions="attempt.questions"
        :initial-state="attempt"
        finish-label="返回今日练习"
        @submitted="onSubmitted"
        @restart="finishAttempt"
      />

      <template v-else>
        <SkeletonBlock v-if="loading && !loaded" :lines="8" />
        <ErrorState v-else-if="error && !today" :message="error" @retry="load()" />
        <template v-else-if="today">
          <section class="daily-status-band" aria-labelledby="today-status-title">
            <div class="status-copy">
              <p class="practice-date">练习日 {{ today.practiceDate }}</p>
              <h2 id="today-status-title">{{ dailyPracticeStatusLabels[today.status] }}</h2>
              <p class="status-meta">
                <Clock3 :size="15" aria-hidden="true" />
                下次更新 {{ formatDateTime(today.nextDayStartsAt) }}
                <template v-if="today.generatedAt"> · 本计划 {{ formatDateTime(today.generatedAt) }} 生成</template>
              </p>
            </div>
            <div class="status-actions">
              <StatusBadge
                :text="dailyPracticeStatusLabels[today.status]"
                :tone="dailyPracticeStatusTones[today.status] as ''"
              />
              <StatusBadge
                v-if="today.supplemental"
                text="今日补建"
                tone="warning"
              />
              <StatusBadge
                v-if="today.generationSource"
                :text="dailyPracticeGenerationLabels[today.generationSource]"
                :tone="today.generationSource === 'PRO_MAX' ? 'accent' : 'warning'"
              />
              <button
                v-if="canEnterPractice"
                type="button"
                class="button"
                :disabled="starting"
                @click="enterPractice"
              >
                <Play :size="16" aria-hidden="true" />
                {{ starting ? '正在准备…' : actionLabel }}
              </button>
              <button
                v-else-if="pollingStatuses.has(today.status)"
                type="button"
                class="button ghost"
                :disabled="loading"
                @click="load()"
              >
                <RefreshCw :size="16" aria-hidden="true" />
                刷新状态
              </button>
            </div>
          </section>

          <p v-if="error" class="alert error" role="alert">{{ error }}</p>
          <p v-if="today.status === 'SERVICE_PAUSED' || today.status === 'PAUSED'" class="alert warning">
            {{ today.service.reason || '每日一练暂时停止服务。' }}
            <template v-if="today.service.resumesAt">
              预计 {{ formatDateTime(today.service.resumesAt) }} 恢复。
            </template>
            <template v-if="today.attempt && !today.attempt.submittedAt">
              已开始的练习仍可继续和提交。
            </template>
          </p>
          <div v-else-if="today.status === 'INITIALIZING'" class="initialization-state" role="status">
            <strong>正在整理历史学习记录</strong>
            <p>
              已处理 {{ today.initialization?.appliedAttempts ?? 0 }} /
              {{ today.initialization?.totalAttempts ?? 0 }} 次答题
            </p>
            <div class="progress-track" aria-hidden="true">
              <div class="progress-bar" :style="{ width: `${initializationPercent}%` }" />
            </div>
          </div>
          <p v-else-if="today.status === 'NO_TEACHING_PROGRESS'" class="alert info">
            当前还没有可用于今日练习的已学主题，请等待课程进度更新。
          </p>
          <p v-else-if="today.status === 'TERM_COMPLETED'" class="alert info">
            本学期两门课程的考试均已结束，每日一练停止生成新计划。历史练习和错题记录仍可查看。
          </p>
          <p v-else-if="today.status === 'STALE'" class="alert warning" role="status">
            计划中的题目状态已经变化，服务端正在准备安全的新修订。本页会自动刷新。
          </p>
          <p v-else-if="pollingStatuses.has(today.status)" class="alert info" role="status">
            {{
              today.supplemental
                ? '今日任务已补建，正在生成计划。本页会自动刷新。'
                : '今日计划正在生成。本页会自动刷新。'
            }}
          </p>
          <ErrorState
            v-else-if="today.status === 'FAILED'"
            message="今日计划生成失败。刷新只会重新读取状态，不会直接重复调用模型。"
            retry-label="刷新状态"
            @retry="load()"
          />
          <p v-else-if="today.status === 'LIMITED_CONTENT'" class="alert warning">
            当前个性化题库不足 5 道，已保留所有可用题目和有效固定题。
          </p>
          <p v-else-if="today.status === 'DEGRADED_READY'" class="alert warning">
            今日计划使用回退策略生成，可以正常练习。
          </p>
          <p v-else-if="today.status === 'COMPLETED' && today.attempt" class="alert success">
            今日练习已完成，得分 {{ today.attempt.score }} / {{ today.attempt.total }}，完成于
            {{ formatDateTime(today.attempt.submittedAt) }}。
            <RouterLink to="/quiz?mode=wrong">查看错题</RouterLink>
          </p>

          <DailyCourseProgress
            v-if="today.curriculum?.courses.length"
            :courses="today.curriculum.courses"
            :practice-date="today.practiceDate"
          />

          <DailyLearningSummary
            v-if="today.summary && today.generationSource"
            :summary="today.summary"
            :generation-source="today.generationSource"
          />

          <DailyPlanPreview
            v-if="today.counts.total > 0"
            :personalized-items="today.personalizedItems"
            :fixed-items="today.fixedItems"
          />
          <EmptyState
            v-else-if="today.status === 'NO_CONTENT'"
            title="今日暂无可用练习题"
            hint="学习总结仍会保留；题库内容补充后会在后续练习日重新生成。若多个练习日持续无内容，请联系管理员检查教学进度与题库来源复审状态。"
          />

          <DailySuggestionForm
            :target-practice-date="today.suggestion.targetPracticeDate"
            :available="today.suggestion.available"
            :current="today.suggestion.current"
            :service-paused="today.status === 'SERVICE_PAUSED' || today.status === 'PAUSED'"
            @saved="onSuggestionSaved"
            @conflict="onSuggestionConflict"
          />
          <DailyPracticeHistory :key="historyRevision" />
        </template>
      </template>
    </section>
  </main>
</template>

<style scoped>
.daily-content {
  display: grid;
  gap: var(--space-8);
}

.daily-status-band {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--border);
}

.practice-date,
.status-copy h2,
.status-meta,
.initialization-state p {
  margin: 0;
}

.practice-date {
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.status-copy h2 {
  margin-top: 3px;
  font-size: 25px;
}

.status-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin-top: var(--space-2);
  color: var(--muted);
  font-size: 13px;
}

.status-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.initialization-state {
  display: grid;
  gap: var(--space-2);
  color: var(--ink-soft);
}

.initialization-state p {
  color: var(--muted);
  font-size: 13px;
}

.progress-track {
  width: 100%;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--surface-muted);
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  border-radius: inherit;
  background: var(--gradient-accent);
  transition: width 0.2s var(--ease-out);
}

@media (max-width: 700px) {
  .daily-status-band {
    align-items: flex-start;
    flex-direction: column;
  }

  .status-actions {
    justify-content: flex-start;
  }
}

@media (max-width: 560px) {
  .daily-content {
    width: calc(100% - 36px);
    gap: var(--space-6);
  }

  .status-actions,
  .status-actions .button {
    width: 100%;
  }
}
</style>
