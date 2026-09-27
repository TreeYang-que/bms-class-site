<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Play, RotateCw, Trash2 } from 'lucide-vue-next';
import { ApiClientError, api, formatError } from '../../lib/api';
import { useQuizFilters } from '../../composables/useQuizFilters';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import QuizChapterSelect from './QuizChapterSelect.vue';
import type {
  QuizAbandonResponse,
  QuizActiveAttemptList,
  QuizAttemptLifecycle,
  QuizStartRequest,
  QuizStartResponse,
  QuizSubjectFilterGroup,
} from '../../types';

const emit = defineEmits<{ started: [payload: QuizStartResponse] }>();
const { confirm } = useConfirm();

const count = ref(10);
const busy = ref(false);
const error = ref('');
const drafts = ref<QuizAttemptLifecycle[]>([]);
const draftsError = ref('');
const abandonBusy = ref<Record<string, boolean>>({});
const activeRequests = useLatestRequest();
const draftsLoading = activeRequests.loading;

const {
  groups,
  loaded: filtersLoaded,
  loading: filtersLoading,
  error: filtersError,
  ensure: ensureFilters,
  reload: reloadFilters,
} = useQuizFilters();
const selectedSubjectId = ref('');
const selectedChapterIds = ref<string[]>([]);
const chapterMatch = ref<'ANY' | 'ALL'>('ANY');
const includeCrossChapter = ref(false);
const selectedTypeLabels = ref<string[]>([]);
const includePastPapers = ref(false);

const activeGroup = computed(
  () =>
    groups.value.find((group) => group.subjectId === selectedSubjectId.value) ??
    null,
);
const activeTypes = computed(() => activeGroup.value?.types ?? []);
const chapterOptions = computed(() =>
  (activeGroup.value?.chapters ?? []).map((chapter) => ({
    id: chapter.chapterId,
    label: chapter.chapter,
    count: chapter.total,
  })),
);
const activePastPaperCount = computed(
  () => activeGroup.value?.pastPaperCount ?? 0,
);

function eligibleCount(type: {
  randomEligibleCount: number;
  pastPaperCount: number;
}): number {
  return includePastPapers.value
    ? type.randomEligibleCount + type.pastPaperCount
    : type.randomEligibleCount;
}

onMounted(async () => {
  await Promise.all([ensureFilters(), loadActiveAttempts()]);
  pruneTypeLabels();
});

async function loadActiveAttempts() {
  draftsError.value = '';
  await activeRequests.runLatest(
    ({ signal }) =>
      api<QuizActiveAttemptList>('/quizzes/attempts/active', { signal }),
    {
      commit(data) {
        drafts.value = Array.isArray(data.items) ? data.items.slice(0, 5) : [];
      },
      onError(caught) {
        draftsError.value = formatError(caught, '答题草稿加载失败');
      },
    },
  );
}

function continueAttempt(attempt: QuizAttemptLifecycle) {
  emit('started', attempt);
}

function attemptStatusLabel(attempt: QuizAttemptLifecycle) {
  if (attempt.status === 'SCORING') return '评分中';
  if (attempt.status === 'SCORING_FAILED') return '评分失败';
  return '未完成';
}

function draftProgress(attempt: QuizAttemptLifecycle) {
  const answered = Object.values(attempt.answers).filter(
    (answer) => answer.length > 0 && answer.some((value) => value.trim()),
  ).length;
  return `${answered} / ${attempt.questions.length} 题已答`;
}

function savedTime(value: string | null) {
  if (!value) return '尚未保存';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

async function abandonAttempt(attempt: QuizAttemptLifecycle) {
  if (abandonBusy.value[attempt.attemptId]) return;
  const ok = await confirm({
    title: '放弃答题草稿',
    body: '放弃后不能继续作答，已保存的答案将不再出现在草稿列表中。',
    confirmText: '确认放弃',
    danger: true,
  });
  if (!ok) return;
  abandonBusy.value = { ...abandonBusy.value, [attempt.attemptId]: true };
  draftsError.value = '';
  try {
    await api<QuizAbandonResponse>(
      `/quizzes/attempts/${encodeURIComponent(attempt.attemptId)}/abandon`,
      { method: 'POST' },
    );
    drafts.value = drafts.value.filter(
      (item) => item.attemptId !== attempt.attemptId,
    );
  } catch (caught) {
    draftsError.value = formatError(caught, '放弃草稿失败，请稍后重试');
    if (caught instanceof ApiClientError && caught.status === 409) {
      await loadActiveAttempts();
    }
  } finally {
    abandonBusy.value = { ...abandonBusy.value, [attempt.attemptId]: false };
  }
}

/** 切换学科或章节后清理不属于当前范围的题型选择 */
function pruneTypeLabels() {
  const valid = new Set(activeTypes.value.map((type) => type.label));
  selectedTypeLabels.value = selectedTypeLabels.value.filter((label) =>
    valid.has(label),
  );
}

function onSubjectChange() {
  selectedChapterIds.value = [];
  chapterMatch.value = 'ANY';
  includeCrossChapter.value = false;
  includePastPapers.value = false;
  pruneTypeLabels();
}

function onChapterChange() {
  includePastPapers.value = false;
  pruneTypeLabels();
}

function toggleTypeLabel(label: string) {
  if (selectedTypeLabels.value.includes(label)) {
    selectedTypeLabels.value = selectedTypeLabels.value.filter(
      (value) => value !== label,
    );
  } else {
    selectedTypeLabels.value = [...selectedTypeLabels.value, label];
  }
}

async function start() {
  busy.value = true;
  error.value = '';
  try {
    const payload: QuizStartRequest = { count: count.value };
    if (selectedSubjectId.value) payload.subjectId = selectedSubjectId.value;
    if (selectedChapterIds.value.length) {
      payload.chapterIds = [...selectedChapterIds.value];
      payload.chapterMatch = chapterMatch.value;
    }
    if (includeCrossChapter.value) payload.includeCrossChapter = true;
    if (selectedTypeLabels.value.length)
      payload.typeLabels = [...selectedTypeLabels.value];
    if (includePastPapers.value) payload.includePastPapers = true;
    const data = await api<QuizStartResponse>('/quizzes/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    emit('started', data);
  } catch (caught) {
    error.value = formatError(caught, '抽题失败，请稍后重试');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="quiz-start">
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <section
      v-if="draftsLoading || draftsError || drafts.length"
      class="draft-section"
      aria-labelledby="quiz-drafts-title"
    >
      <div class="draft-heading">
        <div>
          <h2 id="quiz-drafts-title">继续答题</h2>
          <p>最多保留 5 个未完成练习。</p>
        </div>
        <button
          v-if="draftsError"
          type="button"
          class="button ghost retry-button"
          :disabled="draftsLoading"
          @click="loadActiveAttempts"
        >
          <RotateCw :size="15" aria-hidden="true" />
          重试
        </button>
      </div>
      <p v-if="draftsLoading" class="field-hint">正在加载答题草稿…</p>
      <p v-if="draftsError" class="alert error" role="alert">
        {{ draftsError }}
      </p>
      <ul v-if="drafts.length" class="draft-list">
        <li v-for="item in drafts" :key="item.attemptId" class="draft-item">
          <div class="draft-summary">
            <strong>{{ attemptStatusLabel(item) }}</strong>
            <span>{{ draftProgress(item) }}</span>
            <small>保存于 {{ savedTime(item.savedAt) }}</small>
          </div>
          <div class="draft-actions">
            <button
              type="button"
              class="button secondary"
              :disabled="Boolean(abandonBusy[item.attemptId])"
              @click="continueAttempt(item)"
            >
              <Play :size="16" aria-hidden="true" />
              继续
            </button>
            <button
              type="button"
              class="button ghost danger-action"
              :disabled="
                Boolean(abandonBusy[item.attemptId]) || item.status === 'SCORING'
              "
              :title="item.status === 'SCORING' ? '评分进行中，不能放弃' : ''"
              @click="abandonAttempt(item)"
            >
              <Trash2 :size="16" aria-hidden="true" />
              {{ abandonBusy[item.attemptId] ? '正在放弃…' : '放弃' }}
            </button>
          </div>
        </li>
      </ul>
    </section>
    <div class="filter-fields">
      <div class="field">
        <label for="quiz-subject">学科</label>
        <select
          id="quiz-subject"
          v-model="selectedSubjectId"
          :disabled="busy || filtersLoading"
          @change="onSubjectChange"
        >
          <option value="">全部学科</option>
          <option
            v-for="group in groups"
            :key="group.subjectId"
            :value="group.subjectId"
          >
            {{ group.subject }}
          </option>
        </select>
      </div>
      <div class="field count-field">
        <label for="question-count">题目数量</label>
        <input
          id="question-count"
          v-model.number="count"
          type="number"
          min="1"
          max="100"
          :disabled="busy"
        />
      </div>
      <div class="field">
        <label for="quiz-chapters">章节</label>
        <QuizChapterSelect
          id="quiz-chapters"
          v-model="selectedChapterIds"
          v-model:match="chapterMatch"
          :options="chapterOptions"
          :disabled="busy || filtersLoading || !selectedSubjectId"
          :placeholder="selectedSubjectId ? '全部章节' : '请先选择学科'"
          @change="onChapterChange"
        />
      </div>
      <div class="field">
        <label for="quiz-comprehensive">综合题</label>
        <select
          id="quiz-comprehensive"
          v-model="includeCrossChapter"
          :disabled="busy || filtersLoading"
        >
          <option :value="false">不加入综合题</option>
          <option :value="true">加入综合题</option>
        </select>
      </div>
    </div>

    <fieldset v-if="activeGroup" class="type-fieldset">
      <legend>题型（可多选，不选则为全部题型）</legend>
      <div class="type-chips" role="group" aria-label="题型选择">
        <button
          v-for="type in activeTypes"
          :key="type.label"
          type="button"
          class="type-chip"
          :class="{ active: selectedTypeLabels.includes(type.label) }"
          :aria-pressed="selectedTypeLabels.includes(type.label)"
          :disabled="busy || eligibleCount(type) === 0"
          :title="
            eligibleCount(type) === 0 ? '该题型在当前条件下暂无可抽题目' : ''
          "
          @click="toggleTypeLabel(type.label)"
        >
          <span class="type-chip-label">{{ type.label }}</span>
          <span class="type-chip-count">{{ eligibleCount(type) }} 题</span>
        </button>
      </div>
      <p
        v-if="activeTypes.every((type) => eligibleCount(type) === 0)"
        class="field-hint"
      >
        当前范围没有可随机抽取的题目。
      </p>
    </fieldset>
    <p
      v-else-if="filtersLoaded && !groups.length && !filtersLoading"
      class="field-hint"
    >
      题库暂无可用题目，仍可尝试直接抽题。
    </p>

    <label
      v-if="activeGroup && activePastPaperCount > 0"
      class="past-paper-toggle"
    >
      <input
        v-model="includePastPapers"
        type="checkbox"
        :disabled="busy || filtersLoading"
      />
      <span>包含往年真题（当前范围共 {{ activePastPaperCount }} 道）</span>
    </label>

    <p v-if="filtersError" class="alert error filters-alert" role="alert">
      <span class="filters-alert-text"
        >{{ filtersError }}，可直接按默认条件抽题</span
      >
      <button
        type="button"
        class="button ghost retry-button"
        :disabled="filtersLoading"
        @click="reloadFilters"
      >
        <RotateCw :size="15" aria-hidden="true" />
        重试
      </button>
    </p>
    <p class="field-hint">
      随机抽题默认不含往年真题；客观题自动判分，简答题按评分标准逐项判分。
    </p>
    <button
      type="button"
      class="button"
      :disabled="busy || !count || count < 1 || count > 100"
      @click="start"
    >
      <Play :size="17" aria-hidden="true" />
      {{ busy ? '正在抽题…' : '开始抽题' }}
    </button>
  </div>
</template>

<style scoped>
.quiz-start {
  display: grid;
  gap: var(--space-5);
  max-width: 640px;
}

.draft-section {
  display: grid;
  gap: var(--space-3);
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--border);
}

.draft-heading,
.draft-item,
.draft-actions {
  display: flex;
  align-items: center;
}

.draft-heading,
.draft-item {
  justify-content: space-between;
  gap: var(--space-3);
}

.draft-heading h2,
.draft-heading p {
  margin: 0;
}

.draft-heading h2 {
  font-size: 17px;
}

.draft-heading p {
  margin-top: 2px;
  color: var(--muted);
  font-size: 13px;
}

.draft-list {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.draft-item {
  min-width: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
}

.draft-summary {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.draft-summary span,
.draft-summary small {
  color: var(--muted);
  font-size: 13px;
}

.draft-actions {
  flex: none;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.draft-actions .button {
  min-height: 36px;
  padding: 7px 12px;
}

.danger-action {
  color: var(--danger);
  border-color: var(--danger-border);
}

.filter-fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.filter-fields .field {
  flex: 1 1 150px;
  min-width: 0;
}

.count-field {
  max-width: 160px;
}

.type-fieldset {
  margin: 0;
  padding: var(--space-3) var(--space-4) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
}

.type-fieldset legend {
  padding: 0 var(--space-2);
  color: var(--ink-soft);
  font-size: 14px;
  font-weight: 600;
}

.type-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.type-chip {
  display: inline-flex;
  align-items: baseline;
  gap: var(--space-2);
  min-height: 38px;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background 0.16s var(--ease-out),
    border-color 0.16s var(--ease-out),
    color 0.16s var(--ease-out);
}

.type-chip:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--primary);
}

.type-chip.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-dark);
}

.type-chip:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.type-chip-label {
  overflow-wrap: anywhere;
}

.type-chip-count {
  color: var(--muted);
  font-size: 12px;
}

.type-chip.active .type-chip-count {
  color: var(--accent-dark);
}

.past-paper-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-soft);
  font-size: 14px;
  cursor: pointer;
}

.past-paper-toggle input {
  accent-color: var(--accent);
}

.filters-alert {
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  row-gap: var(--space-2);
}

.filters-alert-text {
  min-width: 0;
}

.retry-button {
  flex: none;
  min-height: 34px;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--danger);
  border-color: var(--danger);
}

.retry-button:hover {
  background: var(--danger-bg);
}

@media (max-width: 560px) {
  .draft-heading,
  .draft-item {
    align-items: stretch;
    flex-direction: column;
  }

  .draft-actions .button {
    flex: 1;
    justify-content: center;
  }
}
</style>
