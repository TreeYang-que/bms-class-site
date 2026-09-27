<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Eye, RefreshCw, Snowflake, X } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import PaginationControl from '../common/PaginationControl.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import { lockScroll, unlockScroll } from '../../composables/useScrollLock';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { usePaneVisibility } from '../../composables/usePaneVisibility';
import { useToast } from '../../composables/useToast';
import {
  getDailyCycle,
  getDailyCycles,
  refreezeDailyCycle,
  shanghaiPracticeDate,
} from '../../lib/dailyPractice';
import { ApiClientError, formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import {
  dailyPracticeCycleStatusLabels,
  dailyPracticeCycleStatusTones,
  questionTypeLabels,
} from '../../lib/labels';
import type {
  DailyPracticeCycleAggregate,
  DailyPracticeCycleSummary,
} from '../../types';

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const paneVisible = usePaneVisibility(() => props.active);

const { confirm } = useConfirm();
const toast = useToast();

const ranges = [
  { days: 7, label: '近7天' },
  { days: 14, label: '近14天' },
  { days: 30, label: '近30天' },
] as const;
const currentPracticeDate = ref(shanghaiPracticeDate());
const activeRangeDays = ref(14);
const rangeTo = ref(shanghaiPracticeDate());
const rangeFrom = ref(shanghaiPracticeDate(-13));

const items = ref<DailyPracticeCycleSummary[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loaded = ref(false);
const error = ref('');
const committedRangeKey = ref('');
const retryPage = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const currentRangeKey = computed(() => `${rangeFrom.value}:${rangeTo.value}`);
const listMatchesRange = computed(
  () => loaded.value && committedRangeKey.value === currentRangeKey.value,
);

const aggregate = ref<DailyPracticeCycleAggregate | null>(null);
const selectedDate = ref('');
const detailError = ref('');
const listRequests = useLatestRequest();
const detailRequests = useLatestRequest();
const pollRequests = useLatestRequest();
const actionRequests = useLatestRequest();
const loading = listRequests.loading;
const detailLoading = detailRequests.loading;
const refreezeBusy = computed(() =>
  selectedDate.value
    ? actionRequests.isBusy(`daily-cycle:${selectedDate.value}`)
    : false,
);
const detailPanel = ref<HTMLElement | null>(null);
const detailCloseButton = ref<HTMLButtonElement | null>(null);
let scrollLocked = false;
let detailTrigger: HTMLElement | null = null;
let refreezePollTimer: number | undefined;
let rolloverTimer: number | undefined;

const poolDepleted = computed(() => {
  const pool = aggregate.value?.pool;
  return Boolean(
    pool && (pool.progressNodeCount === 0 || pool.candidateQuestionCount === 0),
  );
});

const canRefreeze = computed(
  () =>
    Boolean(aggregate.value) &&
    aggregate.value?.practiceDate === currentPracticeDate.value,
);

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
    currentPracticeDate.value = shanghaiPracticeDate();
    scheduleRollover();
  }, delay);
}

function shortId(value: string | null | undefined) {
  if (!value) return '—';
  return value.length > 8 ? value.slice(0, 8) : value;
}

async function loadCycles(nextPage = page.value, navigate = false) {
  retryPage.value = nextPage;
  const rangeKey = currentRangeKey.value;
  const params = {
    from: rangeFrom.value,
    to: rangeTo.value,
    page: nextPage,
    pageSize,
  };
  error.value = '';
  const task = async ({ signal }: { signal: AbortSignal }) => {
    const result = await getDailyCycles(params, { signal });
    const correctedPage = Math.max(1, Math.ceil(result.total / pageSize));
    if (result.total > 0 && !result.items.length && nextPage > correctedPage) {
      return getDailyCycles({ ...params, page: correctedPage }, { signal });
    }
    return result;
  };
  const callbacks = {
    commit(result: Awaited<ReturnType<typeof getDailyCycles>>) {
      if (currentRangeKey.value !== rangeKey) return;
      items.value = result.items;
      total.value = result.total;
      page.value = result.page;
      retryPage.value = result.page;
      committedRangeKey.value = rangeKey;
      loaded.value = true;
    },
    onError(caught: unknown) {
      error.value = formatError(caught, '周期列表加载失败');
    },
  };
  if (navigate) await listRequests.runPage(page, nextPage, task, callbacks);
  else await listRequests.runLatest(task, callbacks);
}

function selectRange(days: number) {
  if (days === activeRangeDays.value && loaded.value) return;
  activeRangeDays.value = days;
  rangeTo.value = shanghaiPracticeDate();
  rangeFrom.value = shanghaiPracticeDate(-(days - 1));
  void loadCycles(1, true);
}

function clearRefreezePoll() {
  if (refreezePollTimer !== undefined) window.clearTimeout(refreezePollTimer);
  refreezePollTimer = undefined;
}

function scheduleRefreezePoll() {
  clearRefreezePoll();
  if (paneVisible.value)
    refreezePollTimer = window.setTimeout(() => void pollRefreeze(), 5_000);
}

async function pollRefreeze() {
  if (!paneVisible.value) return;
  const practiceDate = selectedDate.value;
  if (!practiceDate) return;
  await pollRequests.runLatest(
    ({ signal }) => getDailyCycle(practiceDate, { signal }),
    {
      commit(result) {
        if (selectedDate.value !== practiceDate) return;
        if (result) aggregate.value = result;
        if (result?.refreezeRequestedAt) {
          if (result.practiceDate === shanghaiPracticeDate()) {
            scheduleRefreezePoll();
          }
          return;
        }
        toast.success('重新冻结已完成');
        void loadCycles();
      },
      // 轮询失败不打断抽屉：停止轮询，用户可手动刷新重试。
      onError() {},
    },
  );
}

async function openDetail(cycle: DailyPracticeCycleSummary) {
  selectedDate.value = cycle.practiceDate;
  clearRefreezePoll();
  pollRequests.cancelLatest();
  aggregate.value = null;
  detailError.value = '';
  await nextTick();
  detailCloseButton.value?.focus();
  await detailRequests.runLatest(
    ({ signal }) => getDailyCycle(cycle.practiceDate, { signal }),
    {
      commit(result) {
        if (selectedDate.value !== cycle.practiceDate) return;
        if (!result) detailError.value = '该练习日的周期不存在或已被清理';
        else {
          aggregate.value = result;
          if (
            result.refreezeRequestedAt &&
            result.practiceDate === shanghaiPracticeDate()
          ) {
            scheduleRefreezePoll();
          }
        }
      },
      onError(caught) {
        if (selectedDate.value === cycle.practiceDate) {
          detailError.value = formatError(caught, '周期详情加载失败');
        }
      },
    },
  );
}

function openDetailFromEvent(cycle: DailyPracticeCycleSummary, event: MouseEvent) {
  detailTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  void openDetail(cycle);
}

function closeDetail() {
  const trigger = detailTrigger;
  detailTrigger = null;
  detailRequests.cancelLatest();
  pollRequests.cancelLatest();
  clearRefreezePoll();
  aggregate.value = null;
  selectedDate.value = '';
  detailError.value = '';
  void nextTick(() => trigger?.focus());
}

function dialogFocusableElements() {
  const panel = detailPanel.value;
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
  )).filter((element) => {
    const closedDetails = element.closest('details:not([open])');
    return !closedDetails || element.tagName === 'SUMMARY';
  });
}

function onDetailKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDetail();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = dialogFocusableElements();
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    detailPanel.value?.focus();
    return;
  }
  const activeElement = document.activeElement;
  if (event.shiftKey && (activeElement === first || !detailPanel.value?.contains(activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeElement === last || !detailPanel.value?.contains(activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

async function reloadDetail() {
  const practiceDate = aggregate.value?.practiceDate || selectedDate.value;
  if (!practiceDate) return;
  clearRefreezePoll();
  pollRequests.cancelLatest();
  detailError.value = '';
  await detailRequests.runLatest(
    ({ signal }) => getDailyCycle(practiceDate, { signal }),
    {
      commit(result) {
        if (selectedDate.value !== practiceDate) return;
        if (!result) {
          aggregate.value = null;
          detailError.value = '该练习日的周期不存在或已被清理';
        } else {
          aggregate.value = result;
          if (
            result.refreezeRequestedAt &&
            result.practiceDate === shanghaiPracticeDate()
          ) {
            scheduleRefreezePoll();
          }
        }
      },
      onError(caught) {
        if (selectedDate.value === practiceDate) {
          detailError.value = formatError(caught, '周期详情加载失败');
        }
      },
    },
  );
}

async function requestRefreeze() {
  const current = aggregate.value;
  if (!current || refreezeBusy.value || !canRefreeze.value) return;
  const ok = await confirm({
    title: '重新冻结周期',
    body: '将按当前教学进度与题库状态重新冻结该练习日，并重建所有未开始的计划；已开始或已完成练习的用户不受影响。执行由后台 Worker 在数秒内完成。',
    confirmText: '重新冻结',
    danger: true,
  });
  if (!ok || selectedDate.value !== current.practiceDate) return;
  try {
    await actionRequests.runBusy(`daily-cycle:${current.practiceDate}`, async () => {
      const result = await refreezeDailyCycle(current.practiceDate);
      if (selectedDate.value !== current.practiceDate) return;
      aggregate.value = {
        ...current,
        status: result.status,
        refreezeRequestedAt: result.refreezeRequestedAt,
      };
      toast.success(
        result.alreadyRequested
          ? '该练习日已在重新冻结排队中，无需重复提交'
          : `已提交重新冻结，重建 ${result.rebuildableDayCount} 个未开始计划`,
      );
      scheduleRefreezePoll();
      void loadCycles();
    });
  } catch (caught) {
    if (
      caught instanceof ApiClientError
      && caught.status === 409
      && selectedDate.value === current.practiceDate
    ) {
      currentPracticeDate.value = shanghaiPracticeDate();
      await reloadDetail();
    }
    toast.error(formatError(caught, '重新冻结提交失败'));
  }
}

watch(
  [
    () => Boolean(aggregate.value || detailLoading.value || detailError.value),
    paneVisible,
  ],
  ([open, visible]) => {
    if (open && visible && !scrollLocked) {
      lockScroll();
      scrollLocked = true;
    } else if ((!open || !visible) && scrollLocked) {
      unlockScroll();
      scrollLocked = false;
    }
  },
);

watch(paneVisible, (visible) => {
  if (!visible) {
    clearRefreezePoll();
    listRequests.cancelLatest();
    detailRequests.cancelLatest();
    pollRequests.cancelLatest();
    if (rolloverTimer !== undefined) window.clearTimeout(rolloverTimer);
    rolloverTimer = undefined;
    return;
  }
  currentPracticeDate.value = shanghaiPracticeDate();
  scheduleRollover();
  void loadCycles();
  if (selectedDate.value) void reloadDetail();
});

onMounted(() => {
  if (paneVisible.value) {
    scheduleRollover();
    void loadCycles();
  }
});
onBeforeUnmount(() => {
  clearRefreezePoll();
  if (rolloverTimer !== undefined) window.clearTimeout(rolloverTimer);
  if (scrollLocked) unlockScroll();
});
</script>

<template>
  <section class="cycles-section" aria-labelledby="daily-cycles-title">
    <header class="cycles-heading">
      <div>
        <p class="section-kicker">冻结与重建</p>
        <h3 id="daily-cycles-title">周期管理</h3>
      </div>
      <button
        type="button"
        class="icon-button"
        title="刷新周期列表"
        aria-label="刷新周期列表"
        :disabled="loading"
        @click="loadCycles()"
      ><RefreshCw :size="16" aria-hidden="true" /></button>
    </header>

    <div class="cycles-toolbar">
      <div class="range-shortcuts" role="group" aria-label="快捷时间范围">
        <button
          v-for="range in ranges"
          :key="range.days"
          type="button"
          class="button"
          :class="activeRangeDays === range.days ? 'secondary' : 'ghost'"
          @click="selectRange(range.days)"
        >{{ range.label }}</button>
      </div>
      <span class="range-label">{{ rangeFrom }} ~ {{ rangeTo }}</span>
    </div>

    <p v-if="error && listMatchesRange" class="alert error" role="alert">{{ error }}</p>
    <SkeletonBlock v-if="loading && !listMatchesRange" :lines="6" />
    <ErrorState
      v-else-if="error && !listMatchesRange"
      :message="error"
      @retry="loadCycles(retryPage, true)"
    />
    <EmptyState v-else-if="listMatchesRange && !items.length" title="该范围内暂无周期" />
    <template v-else-if="listMatchesRange">
      <div class="table-wrap cycles-table">
        <table>
          <thead><tr><th>练习日</th><th>状态</th><th>建批记录</th><th>候选题</th><th>未解析节点</th><th>重映射</th><th>无效固定题</th><th>缺口</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="cycle in items" :key="cycle.practiceDate">
              <td data-label="练习日"><strong>{{ cycle.practiceDate }}</strong></td>
              <td data-label="状态">
                <StatusBadge
                  :text="dailyPracticeCycleStatusLabels[cycle.status]"
                  :tone="dailyPracticeCycleStatusTones[cycle.status] as ''"
                />
                <StatusBadge v-if="cycle.refreezeRequestedAt" text="重新冻结排队中" tone="accent" />
              </td>
              <td data-label="建批记录">任务 {{ cycle.createdDays }} 条 · 当时纳入 {{ cycle.activeUsers }} 人</td>
              <td data-label="候选题">{{ cycle.pool.candidateQuestionCount }}</td>
              <td data-label="未解析节点" :class="{ 'warn-text': cycle.pool.unresolvedProgressNodeCount > 0 }">
                {{ cycle.pool.unresolvedProgressNodeCount }}
              </td>
              <td data-label="重映射">{{ cycle.pool.remappedProgressNodeCount }}</td>
              <td data-label="无效固定题">{{ cycle.pool.invalidFixedQuestionCount }}</td>
              <td data-label="缺口">{{ cycle.pool.gapCount }}</td>
              <td data-label="操作">
                <button type="button" class="action-link" @click="openDetailFromEvent(cycle, $event)">
                  <Eye :size="15" aria-hidden="true" />详情
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="section-kicker">建批记录为调度时的快照，不表示当前名单覆盖率。实时可用人数与未入队人数请查看详情或“运行与缺口”。</p>
      <PaginationControl :page="page" :page-count="pageCount" @update:page="loadCycles($event, true)" />
    </template>

    <div
      v-if="aggregate || detailLoading || detailError"
      class="detail-overlay"
      @mousedown.self="closeDetail"
      @keydown="onDetailKeydown"
    >
      <aside
        ref="detailPanel"
        class="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="daily-cycle-detail-title"
        tabindex="-1"
      >
        <header class="detail-heading">
          <div>
            <p class="section-kicker">周期详情</p>
            <h4 id="daily-cycle-detail-title">{{ aggregate?.practiceDate || selectedDate || '正在加载' }}</h4>
          </div>
          <button ref="detailCloseButton" type="button" class="icon-button" aria-label="关闭周期详情" title="关闭" @click="closeDetail">
            <X :size="18" aria-hidden="true" />
          </button>
        </header>
        <SkeletonBlock v-if="detailLoading" :lines="8" />
        <ErrorState v-else-if="detailError" :message="detailError" @retry="reloadDetail" />
        <template v-else-if="aggregate">
          <div class="detail-meta">
            <StatusBadge
              :text="dailyPracticeCycleStatusLabels[aggregate.status]"
              :tone="dailyPracticeCycleStatusTones[aggregate.status] as ''"
            />
            <StatusBadge v-if="aggregate.refreezeRequestedAt" text="重新冻结排队中" tone="accent" />
            <span>基线 {{ formatDateTime(aggregate.baselineAt) }}</span>
            <span>截止 {{ formatDateTime(aggregate.deadlineAt) }}</span>
            <span>
              进度快照
              <code :title="aggregate.progressSetHash">{{ aggregate.progressSetHash.slice(0, 12) }}</code>
            </span>
            <span>重新冻结请求 {{ aggregate.refreezeRequestedAt ? formatDateTime(aggregate.refreezeRequestedAt) : '—' }}</span>
          </div>

          <p v-if="aggregate.progress">
            {{ aggregate.progress.scope === 'CURRENT_ACCESS' ? '当前开放用户' : '周期用户' }} {{ aggregate.totalUsers }} 人：
            可用计划 {{ aggregate.progress.availableUsers }} 人（AI {{ aggregate.progress.aiReadyUsers }} 人，规则回退 {{ aggregate.progress.fallbackReadyUsers }} 人），
            尚未入队 {{ aggregate.progress.missingUsers }} 人；等待调度 {{ aggregate.statusCounts.PENDING ?? 0 }} 人，
            正在生成 {{ aggregate.statusCounts.PROCESSING ?? 0 }} 人，等待重建 {{ aggregate.statusCounts.STALE ?? 0 }} 人。
            可用进度 {{ aggregate.progressPercent }}%，失败、暂停和等待重建不计入。
          </p>
          <section class="detail-section" aria-labelledby="cycle-pool-title">
            <h5 id="cycle-pool-title">池诊断</h5>
            <dl class="pool-metrics">
              <div><dt>快照教学节点</dt><dd>{{ aggregate.pool.progressNodeCount }}</dd></div>
              <div><dt>候选题</dt><dd>{{ aggregate.pool.candidateQuestionCount }}</dd></div>
              <div>
                <dt>未解析节点</dt>
                <dd :class="{ 'warn-text': aggregate.pool.unresolvedProgressNodeCount > 0 }">
                  {{ aggregate.pool.unresolvedProgressNodeCount }}
                </dd>
              </div>
              <div><dt>重映射节点</dt><dd>{{ aggregate.pool.remappedProgressNodeCount }}</dd></div>
              <div><dt>无效固定题</dt><dd>{{ aggregate.invalidFixedQuestionCount }}</dd></div>
            </dl>
            <div class="badge-list">
              <StatusBadge
                v-for="(count, type) in aggregate.pool.candidateTypeCounts"
                :key="type"
                :text="`${questionTypeLabels[type]} ${count}`"
                tone="muted"
              />
            </div>
          </section>

          <div v-if="poolDepleted" class="alert error">
            <p>
              该练习日没有符合已学范围的题目。
              请先检查课程进度，并在<RouterLink class="alert-link" :to="{ path: '/admin', query: { tab: 'daily', pane: 'mapping' } }">题目主题匹配</RouterLink>处理异常，
              然后使用下方的「重新冻结并重建未完成计划」刷新本周期。
            </p>
          </div>

          <section class="detail-section" aria-labelledby="cycle-gap-title">
            <h5 id="cycle-gap-title">候选缺口</h5>
            <p v-if="!aggregate.gapSummary.length" class="muted-note">当前没有候选缺口。</p>
            <div v-else class="table-wrap gap-table">
              <table>
                <thead><tr><th>学科</th><th>教学节点</th><th>合格题目</th></tr></thead>
                <tbody>
                  <tr v-for="gap in aggregate.gapSummary" :key="gap.subjectId">
                    <td data-label="学科">{{ gap.subject }}</td>
                    <td data-label="教学节点">{{ gap.nodeCount }}</td>
                    <td data-label="合格题目">{{ gap.eligibleQuestionCount }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section v-if="aggregate.pool.remappedNodes.length" class="detail-section" aria-labelledby="cycle-remapped-title">
            <h5 id="cycle-remapped-title">已重映射的教学节点</h5>
            <div class="table-wrap remapped-table">
              <table>
                <thead><tr><th>标题</th><th>面包屑</th><th>原文档 → 现文档</th><th>首次讲授日</th></tr></thead>
                <tbody>
                  <tr v-for="node in aggregate.pool.remappedNodes" :key="`${node.subjectId}-${node.documentId}-${node.title}`">
                    <td data-label="标题">{{ node.title }}</td>
                    <td data-label="面包屑">{{ node.breadcrumb }}</td>
                    <td data-label="原文档 → 现文档">
                      <code :title="node.remappedFromDocumentId">{{ shortId(node.remappedFromDocumentId) }}</code>
                      →
                      <code :title="node.documentId">{{ shortId(node.documentId) }}</code>
                    </td>
                    <td data-label="首次讲授日">{{ node.firstTaughtDate }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="aggregate.pool.remappedProgressNodeCount > aggregate.pool.remappedNodes.length" class="muted-note">
              仅展示最近 {{ aggregate.pool.remappedNodes.length }} 条，共 {{ aggregate.pool.remappedProgressNodeCount }} 个节点已重映射。
            </p>
          </section>

          <section class="detail-section cycle-actions" aria-labelledby="cycle-actions-title">
            <h5 id="cycle-actions-title">操作</h5>
            <button
              type="button"
              class="button danger refreeze-button"
              :disabled="refreezeBusy || Boolean(aggregate.refreezeRequestedAt) || !canRefreeze"
              @click="requestRefreeze"
            >
              <Snowflake :size="16" aria-hidden="true" />
              {{ aggregate.refreezeRequestedAt ? '重新冻结排队中…' : canRefreeze ? '重新冻结并重建未完成计划' : '仅当前练习日可重新冻结' }}
            </button>
            <p v-if="canRefreeze" class="field-hint">
              重新冻结按当前教学进度与题库状态刷新该练习日，并重建所有未开始的计划；已开始或已完成练习的用户不受影响。
            </p>
            <p v-else class="field-hint">
              仅当前练习日可请求重新冻结；历史周期如需修复，请联系管理员处理。
            </p>
          </section>
        </template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.cycles-section { display: grid; gap: var(--space-5); }
.cycles-heading, .detail-heading, .detail-meta { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.cycles-heading h3, .section-kicker, .detail-heading h4, .detail-section h5 { margin: 0; }
.cycles-heading h3 { margin-top: 3px; font-size: 18px; }
.section-kicker { color: var(--accent-dark); font-size: 12px; font-weight: 650; }
.cycles-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-3); }
.range-shortcuts { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.range-shortcuts .button { min-height: 38px; padding: 6px 14px; font-size: 13px; }
.range-label { color: var(--muted); font-size: 12px; }
.cycles-table td[data-label="状态"] { display: grid; gap: var(--space-1); justify-items: start; }
.warn-text { color: var(--warning); font-weight: 600; }
.action-link { display: inline-flex; align-items: center; gap: var(--space-1); padding: 0; border: 0; color: var(--accent-dark); background: none; font: inherit; font-size: 13px; cursor: pointer; }
.detail-overlay { position: fixed; inset: 0; z-index: var(--z-dialog); display: flex; justify-content: flex-end; background: rgba(13, 23, 55, 0.38); }
.detail-panel { width: min(760px, 100%); height: 100%; display: grid; align-content: start; gap: var(--space-5); padding: var(--space-6); background: var(--surface); overflow-y: auto; box-shadow: var(--shadow-lift); }
.detail-heading { position: sticky; top: calc(-1 * var(--space-6)); z-index: 2; margin: calc(-1 * var(--space-6)) calc(-1 * var(--space-6)) 0; padding: var(--space-5) var(--space-6); border-bottom: 1px solid var(--border); background: var(--surface); }
.detail-heading h4 { margin-top: 3px; font-size: 20px; }
.detail-meta { justify-content: flex-start; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
.detail-meta code { color: var(--muted); font-size: 11px; }
.detail-section { display: grid; gap: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--border); }
.detail-section h5 { font-size: 15px; }
.pool-metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--space-2); margin: 0; }
.pool-metrics div { display: grid; gap: 2px; padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
.pool-metrics dt { color: var(--muted); font-size: 12px; }
.pool-metrics dd { min-width: 0; margin: 0; color: var(--ink-soft); font-size: 13px; }
.badge-list { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.alert { margin: 0; }
.alert p { margin: 0; line-height: 1.7; }
.alert-link { color: inherit; font-weight: 600; text-decoration: underline; }
.muted-note { margin: 0; color: var(--muted); font-size: 13px; }
.remapped-table code { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.cycle-actions { justify-items: start; }
.cycle-actions .field-hint { max-width: 520px; line-height: 1.6; }
@media (max-width: 700px) {
  .pool-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .cycles-table, .gap-table, .remapped-table { overflow: visible; border: 0; box-shadow: none; }
  .cycles-table table, .cycles-table tbody,
  .gap-table table, .gap-table tbody,
  .remapped-table table, .remapped-table tbody { display: block; }
  .cycles-table thead, .gap-table thead, .remapped-table thead { display: none; }
  .cycles-table tr, .gap-table tr, .remapped-table tr { display: grid; gap: var(--space-2); padding: var(--space-4) 0; border-bottom: 1px solid var(--border); }
  .cycles-table td, .gap-table td, .remapped-table td,
  .cycles-table td[data-label="状态"] { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: var(--space-2); justify-items: start; padding: 0; border: 0; white-space: normal; }
  .cycles-table td::before, .gap-table td::before, .remapped-table td::before { content: attr(data-label); color: var(--muted); font-size: 12px; font-weight: 600; }
  .pool-metrics { grid-template-columns: 1fr; }
  .detail-panel { width: 100%; padding: 18px; }
  .detail-heading { top: -18px; margin: -18px -18px 0; padding: 14px 18px; }
}
</style>
