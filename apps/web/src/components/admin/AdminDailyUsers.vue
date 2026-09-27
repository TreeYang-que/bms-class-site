<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Eye, RefreshCw, RotateCw, Search, X } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import PaginationControl from '../common/PaginationControl.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import { lockScroll, unlockScroll } from '../../composables/useScrollLock';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useToast } from '../../composables/useToast';
import {
  getAdminDailyUser,
  getAdminDailyUsers,
  previewAdminDailyPlan,
  regenerateAdminDailyPlan,
  shanghaiPracticeDate,
  submitAdminDailySuggestion,
} from '../../lib/dailyPractice';
import { ApiClientError, formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import {
  accountStatusLabels,
  dailyPracticeGenerationLabels,
  dailyPracticeIntensityLabels,
  dailyPracticeStatusLabels,
  dailyPracticeSuggestionStatusLabels,
  roleLabels,
} from '../../lib/labels';
import type {
  AdminDailyPracticeUserDetail,
  AdminDailyPracticeUserSummary,
  DailyPracticeGenerationSource,
  DailyPracticeIntensity,
} from '../../types';

const { confirm } = useConfirm();
const toast = useToast();
const items = ref<AdminDailyPracticeUserSummary[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const loaded = ref(false);
const error = ref('');
const committedFilterKey = ref('');
const retryPage = ref(1);
const searchInput = ref('');
const search = ref('');
const planStatus = ref('');
const generationSource = ref<DailyPracticeGenerationSource | ''>('');
const completed = ref<'ALL' | 'true' | 'false'>('ALL');
const hasSuggestion = ref<'ALL' | 'true' | 'false'>('ALL');
const hasGap = ref<'ALL' | 'true' | 'false'>('ALL');

const detail = ref<AdminDailyPracticeUserDetail | null>(null);
const selectedUserId = ref('');
const detailError = ref('');
const listRequests = useLatestRequest();
const detailRequests = useLatestRequest();
const actionRequests = useLatestRequest();
const loading = listRequests.loading;
const detailLoading = detailRequests.loading;
const actionBusy = computed(() =>
  selectedUserId.value
    ? actionRequests.isBusy(`daily-user:${selectedUserId.value}`)
    : false,
);
const targetPracticeDate = ref(shanghaiPracticeDate(1));
const intensity = ref<DailyPracticeIntensity>('STANDARD');
const desiredQuestionCount = ref(7);
const suggestionNote = ref('');
const actionPracticeDate = ref(shanghaiPracticeDate());
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const currentFilterKey = computed(() => JSON.stringify({
  search: search.value,
  planStatus: planStatus.value,
  generationSource: generationSource.value,
  completed: completed.value,
  hasSuggestion: hasSuggestion.value,
  hasGap: hasGap.value,
}));
const listMatchesFilters = computed(
  () => loaded.value && committedFilterKey.value === currentFilterKey.value,
);
const regenerateLocked = computed(() => {
  const status = detail.value?.todayStatus;
  return actionPracticeDate.value === shanghaiPracticeDate()
    && (status === 'STARTED' || status === 'COMPLETED');
});
const detailPanel = ref<HTMLElement | null>(null);
const detailCloseButton = ref<HTMLButtonElement | null>(null);
let scrollLocked = false;
let detailTrigger: HTMLElement | null = null;

function optionalBoolean(value: 'ALL' | 'true' | 'false') {
  return value === 'ALL' ? undefined : value === 'true';
}

function shortIdentifier(value: string | null) {
  if (!value) return '—';
  return value.length > 20 ? `${value.slice(0, 11)}…${value.slice(-7)}` : value;
}

async function loadUsers(nextPage = page.value, navigate = false) {
  retryPage.value = nextPage;
  const filterKey = currentFilterKey.value;
  const filters = {
    search: search.value,
    planStatus: planStatus.value,
    generationSource: generationSource.value,
    completed: optionalBoolean(completed.value),
    hasSuggestion: optionalBoolean(hasSuggestion.value),
    hasGap: optionalBoolean(hasGap.value),
    page: nextPage,
    pageSize,
  };
  error.value = '';
  const callbacks = {
    commit(result: Awaited<ReturnType<typeof getAdminDailyUsers>>) {
      if (currentFilterKey.value !== filterKey) return;
      items.value = result.items;
      total.value = result.total;
      page.value = result.page;
      retryPage.value = result.page;
      committedFilterKey.value = filterKey;
      loaded.value = true;
    },
    onError(caught: unknown) {
      error.value = formatError(caught, '用户状态加载失败');
    },
  };
  const task = async ({ signal }: { signal: AbortSignal }) => {
    const result = await getAdminDailyUsers(filters, { signal });
    const correctedPage = Math.max(1, Math.ceil(result.total / pageSize));
    if (result.total > 0 && !result.items.length && nextPage > correctedPage) {
      return getAdminDailyUsers(
        { ...filters, page: correctedPage },
        { signal },
      );
    }
    return result;
  };
  if (navigate) {
    await listRequests.runPage(page, nextPage, task, callbacks);
  } else {
    await listRequests.runLatest(task, callbacks);
  }
}

function applyFilters() {
  search.value = searchInput.value.trim();
  void loadUsers(1, true);
}

async function openDetail(user: AdminDailyPracticeUserSummary) {
  selectedUserId.value = user.id;
  detail.value = null;
  detailError.value = '';
  const request = detailRequests.runLatest(
    ({ signal }) => getAdminDailyUser(user.id, { signal }),
    {
      commit(result) {
        if (selectedUserId.value === user.id) detail.value = result;
      },
      onError(caught) {
        if (selectedUserId.value === user.id) {
          detailError.value = formatError(caught, '用户详情加载失败');
        }
      },
    },
  );
  await nextTick();
  detailCloseButton.value?.focus();
  await request;
}

function openDetailFromEvent(user: AdminDailyPracticeUserSummary, event: MouseEvent) {
  detailTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  void openDetail(user);
}

function closeDetail() {
  const trigger = detailTrigger;
  detailTrigger = null;
  detailRequests.cancelLatest();
  detail.value = null;
  selectedUserId.value = '';
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
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !detailPanel.value?.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !detailPanel.value?.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

async function reloadDetail() {
  const userId = detail.value?.id || selectedUserId.value;
  if (!userId) return;
  detailError.value = '';
  await detailRequests.runLatest(
    ({ signal }) => getAdminDailyUser(userId, { signal }),
    {
      commit(result) {
        if (selectedUserId.value === userId) detail.value = result;
      },
      onError(caught) {
        if (selectedUserId.value === userId) {
          detailError.value = formatError(caught, '用户详情加载失败');
        }
      },
    },
  );
}

async function submitSuggestion() {
  const user = detail.value;
  if (!user || actionBusy.value) return;
  const ok = await confirm({
    title: '提交管理员建议',
    body: `建议将用于 ${user.displayName} 在 ${targetPracticeDate.value} 的计划。管理员建议不限制业务次数，但每次都会审计并受模型总预算约束。`,
    confirmText: '提交建议',
  });
  if (!ok || selectedUserId.value !== user.id) return;
  try {
    await actionRequests.runBusy(`daily-user:${user.id}`, async () => {
      await submitAdminDailySuggestion(user.id, {
        targetPracticeDate: targetPracticeDate.value,
        intensity: intensity.value,
        desiredQuestionCount: desiredQuestionCount.value,
        focusSubjectIds: [],
        focusChapterIds: [],
        ...(suggestionNote.value.trim() ? { note: suggestionNote.value.trim() } : {}),
      });
      if (selectedUserId.value !== user.id) return;
      suggestionNote.value = '';
      toast.success('管理员建议已提交');
      await reloadDetail();
    });
  } catch (caught) {
    toast.error(formatError(caught, '管理员建议提交失败'));
  }
}

async function runPlanAction(preview: boolean) {
  const user = detail.value;
  if (!user || actionBusy.value) return;
  if (!preview && regenerateLocked.value) {
    toast.error('所选当前练习日已经开始或完成，只能生成诊断预览');
    return;
  }
  const ok = await confirm({
    title: preview ? '生成诊断预览' : '重新生成用户计划',
    body: preview
      ? '预览不会替换已经开始的计划，但仍会消耗受控模型额度。'
      : '未开始计划将创建新修订，旧修订和审计历史会保留。',
    confirmText: preview ? '生成预览' : '重新生成',
    danger: !preview,
  });
  if (!ok || selectedUserId.value !== user.id) return;
  try {
    await actionRequests.runBusy(`daily-user:${user.id}`, async () => {
      if (preview) await previewAdminDailyPlan(user.id, actionPracticeDate.value);
      else await regenerateAdminDailyPlan(user.id, actionPracticeDate.value);
      if (selectedUserId.value !== user.id) return;
      toast.success(preview ? '诊断预览任务已创建' : '计划重新生成任务已创建');
      await reloadDetail();
    });
  } catch (caught) {
    if (
      caught instanceof ApiClientError
      && caught.status === 409
      && selectedUserId.value === user.id
    ) {
      await reloadDetail();
    }
    toast.error(formatError(caught, preview ? '诊断预览失败' : '重新生成失败'));
  }
}

watch([planStatus, generationSource, completed, hasSuggestion, hasGap], applyFilters);
watch(
  () => Boolean(detail.value || detailLoading.value || detailError.value),
  (open) => {
    if (open && !scrollLocked) {
      lockScroll();
      scrollLocked = true;
    } else if (!open && scrollLocked) {
      unlockScroll();
      scrollLocked = false;
    }
  },
);

onMounted(() => void loadUsers());
onBeforeUnmount(() => {
  if (scrollLocked) unlockScroll();
});
</script>

<template>
  <section class="users-section" aria-labelledby="daily-users-title">
    <header class="users-heading">
      <div>
        <p class="section-kicker">仅管理员</p>
        <h3 id="daily-users-title">用户状态</h3>
      </div>
      <button
        type="button"
        class="icon-button"
        title="刷新用户状态"
        aria-label="刷新用户状态"
        :disabled="loading"
        @click="loadUsers()"
      ><RefreshCw :size="16" aria-hidden="true" /></button>
    </header>

    <form class="user-filters" @submit.prevent="applyFilters">
      <div class="field search-field">
        <label for="daily-user-search">用户</label>
        <div class="search-row">
          <input id="daily-user-search" v-model="searchInput" type="search" placeholder="搜索显示名" />
          <button type="submit" class="button secondary"><Search :size="15" aria-hidden="true" />搜索</button>
        </div>
      </div>
      <div class="field">
        <label for="daily-user-status">计划状态</label>
        <select id="daily-user-status" v-model="planStatus">
          <option value="">全部</option>
          <option v-for="status in ['PENDING','PROCESSING','READY','LIMITED_CONTENT','NO_CONTENT','DEGRADED_READY','FAILED','PAUSED','STARTED','COMPLETED','STALE']" :key="status" :value="status">
            {{ dailyPracticeStatusLabels[status as keyof typeof dailyPracticeStatusLabels] }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="daily-user-source">生成来源</label>
        <select id="daily-user-source" v-model="generationSource">
          <option value="">全部</option>
          <option v-for="(label, value) in dailyPracticeGenerationLabels" :key="value" :value="value">{{ label }}</option>
        </select>
      </div>
      <div class="field">
        <label for="daily-user-completed">完成状态</label>
        <select id="daily-user-completed" v-model="completed">
          <option value="ALL">全部</option><option value="true">已完成</option><option value="false">未完成</option>
        </select>
      </div>
      <div class="field">
        <label for="daily-user-suggestion">建议状态</label>
        <select id="daily-user-suggestion" v-model="hasSuggestion">
          <option value="ALL">全部</option><option value="true">有建议</option><option value="false">无建议</option>
        </select>
      </div>
      <div class="field">
        <label for="daily-user-gap">内容缺口</label>
        <select id="daily-user-gap" v-model="hasGap">
          <option value="ALL">全部</option><option value="true">有缺口</option><option value="false">无缺口</option>
        </select>
      </div>
    </form>

    <p v-if="error && listMatchesFilters" class="alert error" role="alert">{{ error }}</p>
    <SkeletonBlock v-if="loading && !listMatchesFilters" :lines="6" />
    <ErrorState
      v-else-if="error && !listMatchesFilters"
      :message="error"
      @retry="loadUsers(retryPage, true)"
    />
    <EmptyState v-else-if="listMatchesFilters && !items.length" title="没有符合条件的用户" />
    <template v-else-if="listMatchesFilters">
      <div class="table-wrap user-table">
        <table>
          <thead><tr><th>用户</th><th>账号</th><th>初始化</th><th>今日状态</th><th>完成</th><th>总结更新</th><th>生成来源</th><th>建议</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="user in items" :key="user.id">
              <td data-label="用户"><strong>{{ user.displayName }}</strong><small>{{ roleLabels[user.role] }}</small></td>
              <td data-label="账号">{{ accountStatusLabels[user.status] }}</td>
              <td data-label="初始化">{{ user.initializationProgress }}%</td>
              <td data-label="今日状态">{{ user.todayStatus ? dailyPracticeStatusLabels[user.todayStatus] : '尚无计划' }}</td>
              <td data-label="完成">{{ user.completed ? '已完成' : '未完成' }}</td>
              <td data-label="总结更新">{{ user.summaryUpdatedAt ? formatDateTime(user.summaryUpdatedAt) : '尚无总结' }}</td>
              <td data-label="生成来源">{{ user.generationSource ? dailyPracticeGenerationLabels[user.generationSource] : '—' }}</td>
              <td data-label="建议">{{ user.suggestionStatus ? dailyPracticeSuggestionStatusLabels[user.suggestionStatus] : '无' }}</td>
              <td data-label="操作">
                <button type="button" class="action-link" @click="openDetailFromEvent(user, $event)">
                  <Eye :size="15" aria-hidden="true" />查看
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <PaginationControl :page="page" :page-count="pageCount" @update:page="loadUsers($event, true)" />
    </template>

    <div
      v-if="detail || detailLoading || detailError"
      class="detail-overlay"
      @mousedown.self="closeDetail"
      @keydown="onDetailKeydown"
    >
      <aside
        ref="detailPanel"
        class="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="daily-user-detail-title"
        tabindex="-1"
      >
        <header class="detail-heading">
          <div>
            <p class="section-kicker">用户详情</p>
            <h4 id="daily-user-detail-title">{{ detail?.displayName || '正在加载' }}</h4>
          </div>
          <button ref="detailCloseButton" type="button" class="icon-button" aria-label="关闭用户详情" title="关闭" @click="closeDetail">
            <X :size="18" aria-hidden="true" />
          </button>
        </header>
        <SkeletonBlock v-if="detailLoading" :lines="8" />
        <ErrorState v-else-if="detailError" :message="detailError" @retry="reloadDetail" />
        <template v-else-if="detail">
          <div class="detail-meta">
            <StatusBadge :text="roleLabels[detail.role]" tone="muted" />
            <StatusBadge :text="accountStatusLabels[detail.status]" tone="accent" />
            <StatusBadge :text="detail.completed ? '今日已完成' : '今日未完成'" :tone="detail.completed ? 'success' : 'muted'" />
            <span>画像修订 {{ detail.profileRevision }}</span>
            <span>总结更新 {{ detail.summaryUpdatedAt ? formatDateTime(detail.summaryUpdatedAt) : '尚无总结' }}</span>
          </div>
          <section v-if="detail.summary" class="detail-section">
            <h5>{{ detail.summary.headline }}</h5>
            <p>{{ detail.summary.overview }}</p>
          </section>
          <section class="detail-section state-columns">
            <div>
              <div class="list-heading">
                <h5>需巩固题目</h5>
                <small class="list-count">显示 {{ Math.min(detail.knowledgeStates.length, 10) }} / 共 {{ detail.knowledgeStatesTotal }}</small>
              </div>
              <ul><li v-for="state in detail.knowledgeStates.slice(0, 10)" :key="state.id">{{ state.subject }} · {{ state.label }}（{{ Math.round(state.masteryBps / 100) }}%）</li></ul>
            </div>
            <div>
              <div class="list-heading">
                <h5>章节状态</h5>
                <small class="list-count">显示 {{ Math.min(detail.chapterStates.length, 10) }} / 共 {{ detail.chapterStatesTotal }}</small>
              </div>
              <ul><li v-for="state in detail.chapterStates.slice(0, 10)" :key="state.id">{{ state.subject }} · {{ state.label }}（错题 {{ state.wrongCount }}）</li></ul>
            </div>
          </section>
          <section v-if="detail.todayPlan" class="detail-section today-plan-diagnostics">
            <header class="diagnostics-heading">
              <h5>今日计划诊断</h5>
              <StatusBadge :text="detail.todayPlan.practiceDate" tone="muted" />
            </header>
            <dl class="diagnostic-metrics">
              <div><dt>画像修订</dt><dd>{{ detail.todayPlan.profileRevision }}</dd></div>
              <div><dt>候选题</dt><dd>{{ detail.todayPlan.candidateQuestions.length }}</dd></div>
              <div><dt>个性化</dt><dd>{{ detail.todayPlan.personalizedItems.length }}</dd></div>
              <div><dt>固定题</dt><dd>{{ detail.todayPlan.fixedItems.length }}</dd></div>
            </dl>
            <dl class="diagnostic-hashes">
              <div><dt>教学进度</dt><dd><code :title="detail.todayPlan.progressSetHash">{{ shortIdentifier(detail.todayPlan.progressSetHash) }}</code></dd></div>
              <div><dt>候选快照</dt><dd><code :title="detail.todayPlan.candidateHash || undefined">{{ shortIdentifier(detail.todayPlan.candidateHash) }}</code></dd></div>
              <div><dt>模型输入</dt><dd><code :title="detail.todayPlan.inputHash || undefined">{{ shortIdentifier(detail.todayPlan.inputHash) }}</code></dd></div>
              <div><dt>模型输出</dt><dd><code :title="detail.todayPlan.outputHash || undefined">{{ shortIdentifier(detail.todayPlan.outputHash) }}</code></dd></div>
            </dl>

            <details v-if="detail.todayPlan.candidateQuestions.length" class="diagnostic-group">
              <summary>候选题（{{ detail.todayPlan.candidateQuestions.length }}）</summary>
              <ol class="diagnostic-list">
                <li v-for="candidate in detail.todayPlan.candidateQuestions" :key="candidate.questionId">
                  <div class="diagnostic-item-heading">
                    <strong>{{ candidate.questionAlias }} · {{ candidate.typeLabel }}</strong>
                    <small>优先级 {{ candidate.priorityScore }}</small>
                  </div>
                  <p>{{ candidate.promptExcerpt }}</p>
                  <small>
                    复习主题 {{ candidate.knowledgeAliases.join('、') || '—' }} ·
                    章节 {{ candidate.chapterAliases.join('、') || '—' }}
                  </small>
                </li>
              </ol>
            </details>

            <details v-if="detail.todayPlan.personalizedItems.length" class="diagnostic-group">
              <summary>最终个性化题（{{ detail.todayPlan.personalizedItems.length }}）</summary>
              <ol class="diagnostic-list">
                <li v-for="item in detail.todayPlan.personalizedItems" :key="item.questionId">
                  <div class="diagnostic-item-heading">
                    <strong>{{ item.ordinal }}. {{ item.typeLabel }} · {{ item.subject }}</strong>
                    <small>{{ item.chapters.map((chapter) => chapter.name).join('、') || '未标注章节' }}</small>
                  </div>
                  <p>{{ item.prompt }}</p>
                  <small>{{ item.reason }}</small>
                </li>
              </ol>
            </details>

            <details v-if="detail.todayPlan.fixedItems.length" class="diagnostic-group">
              <summary>最终固定题（{{ detail.todayPlan.fixedItems.length }}）</summary>
              <ol class="diagnostic-list">
                <li v-for="item in detail.todayPlan.fixedItems" :key="item.questionId">
                  <div class="diagnostic-item-heading">
                    <strong>{{ item.ordinal }}. {{ item.typeLabel }} · {{ item.subject }}</strong>
                    <small>{{ item.chapters.map((chapter) => chapter.name).join('、') || '未标注章节' }}</small>
                  </div>
                  <p>{{ item.prompt }}</p>
                </li>
              </ol>
            </details>

            <div v-if="detail.todayPlan.fixedAssignment" class="fixed-diagnostics">
              <div class="diagnostics-heading">
                <strong>冻结固定题</strong>
                <span>
                  有效 {{ detail.todayPlan.fixedAssignment.validCount }} ·
                  失效 {{ detail.todayPlan.fixedAssignment.invalidCount }}
                </span>
              </div>
              <p class="diagnostic-identifier">
                快照 <code :title="detail.todayPlan.fixedAssignment.hash">{{ shortIdentifier(detail.todayPlan.fixedAssignment.hash) }}</code>
              </p>
              <ol v-if="detail.todayPlan.fixedAssignment.questions.length" class="diagnostic-list">
                <li v-for="question in detail.todayPlan.fixedAssignment.questions" :key="question.questionId">
                  <div class="diagnostic-item-heading">
                    <strong>{{ question.ordinal }}. {{ question.typeLabel }} · {{ question.subject }}</strong>
                    <code :title="question.promptHash">{{ shortIdentifier(question.promptHash) }}</code>
                  </div>
                  <p>{{ question.promptExcerpt }}</p>
                </li>
              </ol>
              <p v-if="detail.todayPlan.fixedAssignment.invalidQuestionIds.length" class="invalid-question-ids">
                失效题 ID：
                <code
                  v-for="id in detail.todayPlan.fixedAssignment.invalidQuestionIds"
                  :key="id"
                  :title="id"
                >{{ shortIdentifier(id) }}</code>
              </p>
            </div>
          </section>
          <section class="detail-section">
            <div class="list-heading">
              <h5>计划修订</h5>
              <small class="list-count">显示 {{ detail.planRevisions.length }} / 共 {{ detail.planRevisionsTotal }}</small>
            </div>
            <ul class="plain-list"><li v-for="revision in detail.planRevisions" :key="revision.id">{{ revision.practiceDate }} · v{{ revision.revision }} · {{ revision.trigger }} · {{ dailyPracticeGenerationLabels[revision.generationSource] }}<strong v-if="revision.active">当前</strong></li></ul>
          </section>
          <section class="detail-section admin-action-section">
            <div class="list-heading">
              <h5>管理员建议</h5>
              <small class="list-count">显示 {{ detail.suggestions.length }} / 共 {{ detail.suggestionsTotal }}</small>
            </div>
            <div class="admin-suggestion-grid">
              <div class="field"><label for="admin-suggestion-date">目标练习日</label><input id="admin-suggestion-date" v-model="targetPracticeDate" type="date" /></div>
              <div class="field"><label for="admin-suggestion-intensity">强度</label><select id="admin-suggestion-intensity" v-model="intensity"><option v-for="(label, value) in dailyPracticeIntensityLabels" :key="value" :value="value">{{ label }}</option></select></div>
              <div class="field"><label for="admin-suggestion-count">个性化题量</label><select id="admin-suggestion-count" v-model.number="desiredQuestionCount"><option v-for="count in 6" :key="count + 4" :value="count + 4">{{ count + 4 }}</option></select></div>
              <div class="field note-field"><label for="admin-suggestion-note">建议内容</label><textarea id="admin-suggestion-note" v-model="suggestionNote" maxlength="300" rows="3" /></div>
            </div>
            <button type="button" class="button secondary" :disabled="actionBusy" @click="submitSuggestion">提交管理员建议</button>
            <ul class="plain-list"><li v-for="suggestion in detail.suggestions" :key="suggestion.id">{{ suggestion.targetPracticeDate }} · {{ dailyPracticeSuggestionStatusLabels[suggestion.status] }} · {{ formatDateTime(suggestion.createdAt) }}</li></ul>
          </section>
          <section class="detail-section plan-actions">
            <h5>计划测试</h5>
            <div class="field"><label for="admin-action-date">练习日</label><input id="admin-action-date" v-model="actionPracticeDate" type="date" /></div>
            <button type="button" class="button danger regenerate-button" :disabled="actionBusy || regenerateLocked" @click="runPlanAction(false)"><RotateCw :size="16" aria-hidden="true" />重新生成</button>
            <button type="button" class="button secondary preview-button" :disabled="actionBusy" @click="runPlanAction(true)"><Eye :size="16" aria-hidden="true" />诊断预览</button>
            <p v-if="regenerateLocked" class="field-hint">所选当前练习日已经开始或完成，重新生成已锁定；诊断预览仍可使用。</p>
          </section>
        </template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.users-section { display: grid; gap: var(--space-5); }
.users-heading, .detail-heading, .detail-meta, .plan-actions { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.users-heading h3, .section-kicker, .detail-heading h4, .detail-section h5, .detail-section p, .plain-list { margin: 0; }
.users-heading h3 { margin-top: 3px; font-size: 18px; }
.section-kicker { color: var(--accent-dark); font-size: 12px; font-weight: 650; }
.user-filters { display: flex; align-items: end; flex-wrap: wrap; gap: var(--space-3); }
.user-filters > .field { flex: 1 1 140px; }
.user-filters .search-field { flex-basis: 260px; }
.search-row { display: flex; gap: var(--space-2); }
.search-row input { min-width: 0; flex: 1; }
.user-table td:first-child { display: grid; gap: 2px; }
.user-table td small { color: var(--muted); }
.action-link { display: inline-flex; align-items: center; gap: var(--space-1); padding: 0; border: 0; color: var(--accent-dark); background: none; font: inherit; font-size: 13px; cursor: pointer; }
.detail-overlay { position: fixed; inset: 0; z-index: var(--z-dialog); display: flex; justify-content: flex-end; background: rgba(13, 23, 55, 0.38); }
.detail-panel { width: min(760px, 100%); height: 100%; display: grid; align-content: start; gap: var(--space-5); padding: var(--space-6); background: var(--surface); overflow-y: auto; box-shadow: var(--shadow-lift); }
.detail-heading { position: sticky; top: calc(-1 * var(--space-6)); z-index: 2; margin: calc(-1 * var(--space-6)) calc(-1 * var(--space-6)) 0; padding: var(--space-5) var(--space-6); border-bottom: 1px solid var(--border); background: var(--surface); }
.detail-heading h4 { margin-top: 3px; font-size: 20px; }
.detail-meta { justify-content: flex-start; flex-wrap: wrap; color: var(--muted); font-size: 13px; }
.detail-section { display: grid; gap: var(--space-3); padding-top: var(--space-4); border-top: 1px solid var(--border); }
.detail-section h5 { font-size: 15px; }
.detail-section p { color: var(--ink-soft); line-height: 1.7; }
.list-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
.list-count { color: var(--muted); white-space: nowrap; }
.state-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.state-columns ul, .plain-list { display: grid; gap: var(--space-2); padding-left: 20px; color: var(--ink-soft); font-size: 13px; line-height: 1.6; }
.plain-list strong { margin-left: var(--space-2); color: var(--accent-dark); }
.diagnostics-heading, .diagnostic-item-heading { min-width: 0; display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
.diagnostic-metrics, .diagnostic-hashes { display: grid; margin: 0; }
.diagnostic-metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-2); }
.diagnostic-metrics div { display: grid; gap: 2px; padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
.diagnostic-metrics dt, .diagnostic-hashes dt { color: var(--muted); font-size: 12px; }
.diagnostic-metrics dd, .diagnostic-hashes dd { min-width: 0; margin: 0; color: var(--ink-soft); font-size: 13px; }
.diagnostic-hashes { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2) var(--space-4); }
.diagnostic-hashes div { min-width: 0; display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: baseline; gap: var(--space-2); }
.diagnostic-hashes code, .diagnostic-item-heading code, .diagnostic-identifier code, .invalid-question-ids code { min-width: 0; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.diagnostic-group { border-top: 1px solid var(--border); }
.diagnostic-group summary { width: fit-content; padding-top: var(--space-3); color: var(--accent-dark); font-size: 13px; font-weight: 600; cursor: pointer; }
.diagnostic-list { display: grid; gap: 0; margin: var(--space-2) 0 0; padding: 0; list-style: none; }
.diagnostic-list li { min-width: 0; display: grid; gap: 3px; padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
.diagnostic-item-heading strong, .diagnostic-item-heading small { min-width: 0; overflow-wrap: anywhere; }
.diagnostic-item-heading strong { color: var(--ink-soft); font-size: 13px; }
.diagnostic-item-heading small, .diagnostic-list > li > small { color: var(--muted); font-size: 11px; }
.diagnostic-list p, .diagnostic-identifier, .invalid-question-ids { margin: 0; color: var(--ink-soft); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.fixed-diagnostics { display: grid; gap: var(--space-2); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.fixed-diagnostics .diagnostics-heading span { color: var(--muted); font-size: 12px; }
.invalid-question-ids { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.admin-suggestion-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
.admin-suggestion-grid .note-field { grid-column: 1 / -1; }
.plan-actions { justify-content: flex-start; flex-wrap: wrap; }
.plan-actions h5 { width: 100%; }
.plan-actions .field { min-width: 180px; }
@media (max-width: 560px) {
  .search-row, .state-columns, .admin-suggestion-grid, .diagnostic-metrics, .diagnostic-hashes { grid-template-columns: 1fr; }
  .search-row { flex-direction: column; }
  .search-row .button { width: 100%; }
  .user-table { overflow: visible; border: 0; box-shadow: none; }
  .user-table table, .user-table tbody { display: block; }
  .user-table thead { display: none; }
  .user-table tr { display: grid; gap: var(--space-2); padding: var(--space-4) 0; border-bottom: 1px solid var(--border); }
  .user-table td, .user-table td:first-child { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: var(--space-2); padding: 0; border: 0; white-space: normal; }
  .user-table td::before { content: attr(data-label); color: var(--muted); font-size: 12px; font-weight: 600; }
  .detail-panel { width: 100%; padding: 18px; }
  .detail-heading { top: -18px; margin: -18px -18px 0; padding: 14px 18px; }
  .admin-suggestion-grid .note-field { grid-column: 1; }
  .plan-actions { align-items: stretch; flex-direction: column; }
  .plan-actions .button { width: 100%; }
}
</style>
