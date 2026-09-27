<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RefreshCw } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { usePaneVisibility } from '../../composables/usePaneVisibility';
import { getDailyCycle, shanghaiPracticeDate } from '../../lib/dailyPractice';
import { formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import {
  dailyPracticeGenerationLabels,
  dailyPracticeStatusLabels,
  dailyPracticeCycleStatusLabels,
} from '../../lib/labels';
import type { DailyPracticeCycleAggregate } from '../../types';

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const paneVisible = usePaneVisibility(() => props.active);

const currentPracticeDate = ref(shanghaiPracticeDate());
const practiceDate = ref(currentPracticeDate.value);
const followingCurrentDate = ref(true);
const cycle = ref<DailyPracticeCycleAggregate | null>(null);
const error = ref('');
const { loading, runLatest, cancelLatest } = useLatestRequest();
let pollTimer: number | undefined;
let rolloverTimer: number | undefined;

const poolDepleted = computed(() => {
  const pool = cycle.value?.pool;
  return Boolean(
    pool && (pool.candidateQuestionCount === 0 || pool.progressNodeCount === 0),
  );
});

function clearPoll() {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
}

function nextShanghaiRolloverAt(now = new Date()) {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const dayOffset = Number(parts.hour) >= 4 ? 1 : 0;
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day) + dayOffset,
    4,
  ) - 8 * 60 * 60 * 1_000;
}

function scheduleRollover() {
  if (rolloverTimer !== undefined) window.clearTimeout(rolloverTimer);
  const delay = Math.max(1_000, nextShanghaiRolloverAt() - Date.now() + 50);
  rolloverTimer = window.setTimeout(() => {
    const previousCurrentDate = currentPracticeDate.value;
    currentPracticeDate.value = shanghaiPracticeDate();
    if (followingCurrentDate.value && practiceDate.value === previousCurrentDate) {
      practiceDate.value = currentPracticeDate.value;
    }
    scheduleRollover();
  }, delay);
}

function onPracticeDateChanged() {
  followingCurrentDate.value = practiceDate.value === currentPracticeDate.value;
}

async function load() {
  if (!paneVisible.value) return;
  const targetDate = practiceDate.value;
  error.value = '';
  clearPoll();
  await runLatest(
    ({ signal }) => getDailyCycle(targetDate, { signal }),
    {
      commit(result) {
        if (practiceDate.value !== targetDate) return;
        cycle.value = result;
        if (paneVisible.value && result && (targetDate === currentPracticeDate.value || ['BUILDING', 'GENERATING'].includes(result.status))) {
          pollTimer = window.setTimeout(() => void load(), 10_000);
        }
      },
      onError(caught) {
        if (practiceDate.value !== targetDate) return;
        cycle.value = null;
        error.value = formatError(caught, '每日周期加载失败');
      },
    },
  );
}

watch(practiceDate, () => {
  if (paneVisible.value) void load();
});
watch(paneVisible, (visible) => {
  if (!visible) {
    clearPoll();
    cancelLatest();
    if (rolloverTimer !== undefined) window.clearTimeout(rolloverTimer);
    rolloverTimer = undefined;
    return;
  }
  currentPracticeDate.value = shanghaiPracticeDate();
  scheduleRollover();
  void load();
});
onMounted(() => {
  if (paneVisible.value) {
    scheduleRollover();
    void load();
  }
});
onBeforeUnmount(() => {
  clearPoll();
  cancelLatest();
  if (rolloverTimer !== undefined) window.clearTimeout(rolloverTimer);
});
</script>

<template>
  <section class="runtime-section" aria-labelledby="daily-runtime-title">
    <header class="runtime-heading">
      <div>
        <p class="section-kicker">匿名聚合</p>
        <h3 id="daily-runtime-title">运行与缺口</h3>
      </div>
      <div class="runtime-controls">
        <div class="field">
          <label for="runtime-date">练习日</label>
          <input id="runtime-date" v-model="practiceDate" type="date" @change="onPracticeDateChanged" />
        </div>
        <button
          type="button"
          class="icon-button"
          title="刷新周期"
          aria-label="刷新周期"
          :disabled="loading"
          @click="load"
        ><RefreshCw :size="16" aria-hidden="true" /></button>
      </div>
    </header>
    <SkeletonBlock v-if="loading && !cycle" :lines="6" />
    <ErrorState v-else-if="error" :message="error" @retry="load" />
    <EmptyState v-else-if="!cycle" title="该练习日尚未建立周期" />
    <template v-else>
      <div class="cycle-summary">
        <div><span>周期状态</span><strong>{{ dailyPracticeCycleStatusLabels[cycle.status] }}</strong></div>
        <div><span>{{ cycle.progress?.scope === 'CURRENT_ACCESS' ? '当前开放用户' : '周期用户' }}</span><strong>{{ cycle.totalUsers }} 人</strong></div>
        <div><span>可用计划进度</span><strong>{{ cycle.progress ? `${cycle.progress.availableUsers} / ${cycle.totalUsers} 人（${cycle.progressPercent}%）` : '等待新版进度数据' }}</strong></div>
        <div><span>模型单次耗时 P50 / P95</span><strong>{{ cycle.latencyMs.p50 ?? '—' }} / {{ cycle.latencyMs.p95 ?? '—' }} ms</strong></div>
        <div><span>周期累计调用（含重试）</span><strong>{{ cycle.usage.calls }}</strong></div>
        <div><span>输入 / 输出 token</span><strong>{{ cycle.usage.inputTokens }} / {{ cycle.usage.outputTokens }}</strong></div>
      </div>
      <div v-if="cycle.progress" class="progress-detail" role="status" aria-live="polite">
        <p>已入队 {{ cycle.progress.enqueuedUsers }} 人，尚未入队 {{ cycle.progress.missingUsers }} 人。AI 计划可用 {{ cycle.progress.aiReadyUsers }} 人，规则回退可用 {{ cycle.progress.fallbackReadyUsers }} 人。</p>
        <p>等待调度 {{ cycle.statusCounts.PENDING ?? 0 }} 人 · 正在生成 {{ cycle.statusCounts.PROCESSING ?? 0 }} 人 · 等待重建 {{ cycle.statusCounts.STALE ?? 0 }} 人 · 生成失败 {{ cycle.statusCounts.FAILED ?? 0 }} 人 · 已暂停 {{ cycle.statusCounts.PAUSED ?? 0 }} 人 · 无可用题目 {{ cycle.statusCounts.NO_CONTENT ?? 0 }} 人。</p>
        <p v-if="cycle.progress.nextScheduledAt">下一批计划调度时间：{{ formatDateTime(cycle.progress.nextScheduledAt) }}（北京时间）。这是开始处理的时间，实际完成还需等待模型响应和校验。</p>
        <p v-if="cycle.progress.missingUsers" class="warn-text">尚未入队的用户没有生成任务，不是在等待模型。请核对内测名单与用户初始化状态；符合条件的用户进入每日一练页后会补建任务。</p>
        <p>可用计划包含已开始、已完成的练习；等待重建、失败、暂停和无题不计入可用进度。模型调用与耗时包含本周期此前调试及重建，并非当前用户全部完成所需时间。</p>
        <p>更新于 {{ formatDateTime(cycle.progress.checkedAt) }} · 当前练习日每 10 秒刷新</p>
      </div>
      <div v-if="cycle.progress" class="timeline" aria-label="可用计划进度与周期调度时间">
        <div class="timeline-labels">
          <span>{{ formatDateTime(cycle.baselineAt) }}</span>
          <span>{{ formatDateTime(cycle.deadlineAt) }}</span>
        </div>
        <div class="progress-track" aria-hidden="true">
          <div class="progress-bar" :style="{ width: `${cycle.progressPercent}%` }" />
        </div>
      </div>
      <section class="aggregate-section" aria-labelledby="status-count-title">
        <h4 id="status-count-title">计划状态</h4>
        <div class="badge-list">
          <StatusBadge
            v-for="(count, status) in cycle.statusCounts"
            :key="status"
            :text="`${dailyPracticeStatusLabels[status]} ${count} 人`"
            tone="muted"
          />
        </div>
      </section>
      <section class="aggregate-section" aria-labelledby="strategy-count-title">
        <h4 id="strategy-count-title">可用计划来源</h4>
        <div class="badge-list">
          <StatusBadge
            v-for="(count, source) in cycle.generationCounts"
            :key="source"
            :text="`${dailyPracticeGenerationLabels[source]} ${count}`"
            tone="accent"
          />
        </div>
      </section>
      <section v-if="cycle.pool" class="aggregate-section" aria-labelledby="pool-title">
        <h4 id="pool-title">候选题池</h4>
        <div class="pool-strip">
          <div><span>候选题</span><strong>{{ cycle.pool.candidateQuestionCount }}</strong></div>
          <div><span>快照节点</span><strong>{{ cycle.pool.progressNodeCount }}</strong></div>
          <div>
            <span>未解析节点</span>
            <strong :class="{ 'warn-text': cycle.pool.unresolvedProgressNodeCount > 0 }">
              {{ cycle.pool.unresolvedProgressNodeCount }}
            </strong>
          </div>
          <div><span>重映射节点</span><strong>{{ cycle.pool.remappedProgressNodeCount }}</strong></div>
        </div>
        <div v-if="poolDepleted" class="alert error pool-alert" role="alert">
          <p>今日没有符合已学范围的题目。请检查课程进度、题目主题匹配或补充题库内容。</p>
          <RouterLink
            class="button ghost pool-alert-link"
            :to="{ path: '/admin', query: { tab: 'daily', pane: 'cycles' } }"
          >前往周期管理</RouterLink>
        </div>
      </section>
      <section class="aggregate-section" aria-labelledby="gap-title">
        <h4 id="gap-title">候选缺口</h4>
        <p v-if="cycle.invalidFixedQuestionCount" class="alert warning">
          周期冻结时有 {{ cycle.invalidFixedQuestionCount }} 道固定题失效。
        </p>
        <EmptyState v-if="!cycle.gapSummary.length" title="当前没有候选缺口" />
        <div v-else class="table-wrap gap-table">
          <table>
            <thead><tr><th>学科</th><th>教学节点</th><th>合格题目</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="gap in cycle.gapSummary" :key="gap.subjectId">
                <td data-label="学科">{{ gap.subject }}</td>
                <td data-label="教学节点">{{ gap.nodeCount }}</td>
                <td data-label="合格题目">{{ gap.eligibleQuestionCount }}</td>
                <td data-label="操作">
                  <RouterLink
                    class="action-link"
                    :to="{ path: '/admin', query: { tab: 'daily', pane: 'mapping', subjectId: gap.subjectId } }"
                  >处理题目匹配</RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.runtime-section {
  display: grid;
  gap: var(--space-6);
}

.progress-detail {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.progress-detail p { margin: 0 0 var(--space-2); }

.runtime-heading,
.runtime-controls,
.timeline-labels {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.runtime-heading h3,
.section-kicker,
.aggregate-section h4 {
  margin: 0;
}

.runtime-heading h3 {
  margin-top: 3px;
  font-size: 18px;
}

.section-kicker {
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.runtime-controls .field {
  width: 190px;
}

.cycle-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border-block: 1px solid var(--border);
}

.cycle-summary div {
  min-width: 0;
  display: grid;
  gap: var(--space-1);
  padding: var(--space-4);
  border-right: 1px solid var(--border);
}

.cycle-summary div:nth-child(3n) {
  border-right: 0;
}

.cycle-summary span,
.timeline-labels {
  color: var(--muted);
  font-size: 12px;
}

.cycle-summary strong {
  overflow-wrap: anywhere;
}

.timeline {
  display: grid;
  gap: var(--space-2);
}

.progress-track {
  height: 10px;
  border-radius: var(--radius-pill);
  background: var(--surface-muted);
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  border-radius: inherit;
  background: var(--gradient-accent);
}

.aggregate-section {
  display: grid;
  gap: var(--space-3);
}

.pool-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-block: 1px solid var(--border);
}

.pool-strip div {
  min-width: 0;
  display: grid;
  gap: var(--space-1);
  padding: var(--space-4);
  border-right: 1px solid var(--border);
}

.pool-strip div:last-child {
  border-right: 0;
}

.pool-strip span {
  color: var(--muted);
  font-size: 12px;
}

.pool-strip strong {
  overflow-wrap: anywhere;
}

.warn-text {
  color: var(--warning);
}

.pool-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: 0;
}

.pool-alert p {
  margin: 0;
  line-height: 1.7;
}

.pool-alert-link {
  flex: none;
  color: var(--danger);
  text-decoration: none;
}

.badge-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.action-link {
  color: var(--accent-dark);
  font-size: 13px;
  font-weight: 600;
}

@media (max-width: 700px) {
  .cycle-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .cycle-summary div:nth-child(3n) {
    border-right: 1px solid var(--border);
  }

  .cycle-summary div:nth-child(2n) {
    border-right: 0;
  }
}

@media (max-width: 560px) {
  .runtime-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .pool-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .pool-strip div:nth-child(2n) {
    border-right: 0;
  }

  .runtime-controls .field {
    min-width: 0;
    width: 100%;
  }

  .cycle-summary {
    grid-template-columns: 1fr;
  }

  .cycle-summary div,
  .cycle-summary div:nth-child(3n),
  .cycle-summary div:nth-child(2n) {
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }

  .gap-table {
    overflow: visible;
    border: 0;
    box-shadow: none;
  }

  .gap-table table,
  .gap-table tbody {
    display: block;
  }

  .gap-table thead {
    display: none;
  }

  .gap-table tr {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-4) 0;
    border-bottom: 1px solid var(--border);
  }

  .gap-table td {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    gap: var(--space-2);
    padding: 0;
    border: 0;
    white-space: normal;
  }

  .gap-table td::before {
    content: attr(data-label);
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }
}
</style>
