<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ArrowDown, ArrowUp, Save, X } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import PaginationControl from '../common/PaginationControl.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import QuizChapterSelect from '../quiz/QuizChapterSelect.vue';
import QuizKeywordSearch from '../quiz/QuizKeywordSearch.vue';
import { useConfirm } from '../../composables/useConfirm';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useQuizFilters } from '../../composables/useQuizFilters';
import { useToast } from '../../composables/useToast';
import {
  getFixedAssignment,
  getFixedQuestionCandidates,
  publishFixedAssignment,
  shanghaiPracticeDate,
} from '../../lib/dailyPractice';
import { formatError } from '../../lib/api';
import type {
  DailyPracticeFixedAssignment,
  DailyPracticeFixedQuestionCandidate,
} from '../../types';

const MAX_FIXED_QUESTIONS = 20;

const { confirm } = useConfirm();
const toast = useToast();
const { groups, error: filtersError, ensure: ensureFilters } = useQuizFilters();
const practiceDate = ref(shanghaiPracticeDate(1));
const assignment = ref<DailyPracticeFixedAssignment | null>(null);
const selected = ref<DailyPracticeFixedQuestionCandidate[]>([]);
const note = ref('');
const assignmentError = ref('');
const currentPracticeDate = ref(shanghaiPracticeDate());
const confirming = ref(false);
const assignmentRequests = useLatestRequest();
const candidateRequests = useLatestRequest();
const actionRequests = useLatestRequest();
const assignmentLoading = assignmentRequests.loading;
const candidatesLoading = candidateRequests.loading;
const saving = computed(() =>
  confirming.value || (
    practiceDate.value
      ? actionRequests.isBusy(`fixed-assignment:${practiceDate.value}`)
      : false
  ),
);

const subjectId = ref('');
const chapterIds = ref<string[]>([]);
const chapterMatch = ref<'ANY' | 'ALL'>('ANY');
const includeCrossChapter = ref(false);
const typeLabel = ref('');
const pastPaper = ref<'ALL' | 'EXCLUDE' | 'ONLY'>('ALL');
const searchInput = ref('');
const search = ref('');
const page = ref(1);
const pageSize = 10;
const candidates = ref<DailyPracticeFixedQuestionCandidate[]>([]);
const total = ref(0);
const candidatesLoaded = ref(false);
const candidatesError = ref('');
const committedFilterKey = ref('');
const retryPage = ref(1);

const activeGroup = computed(() =>
  groups.value.find((group) => group.subjectId === subjectId.value),
);
const chapterOptions = computed(() =>
  (activeGroup.value?.chapters ?? []).map((chapter) => ({
    id: chapter.chapterId,
    label: chapter.chapter,
    count: chapter.total,
  })),
);
const typeOptions = computed(() => activeGroup.value?.types ?? []);
const selectedIds = computed(() => new Set(selected.value.map((item) => item.id)));
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
const currentFilterKey = computed(() => JSON.stringify({
  practiceDate: practiceDate.value,
  subjectId: subjectId.value,
  chapterIds: [...chapterIds.value].sort(),
  chapterMatch: chapterMatch.value,
  includeCrossChapter: includeCrossChapter.value,
  typeLabel: typeLabel.value,
  pastPaper: pastPaper.value,
  search: search.value,
}));
const candidatesMatchFilters = computed(
  () => candidatesLoaded.value && committedFilterKey.value === currentFilterKey.value,
);
const dateLocked = computed(
  () => Boolean(practiceDate.value) && practiceDate.value <= currentPracticeDate.value,
);
const editorDisabled = computed(() => dateLocked.value || saving.value);
let lockRolloverTimer: number | undefined;

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

function scheduleLockRollover() {
  if (lockRolloverTimer !== undefined) window.clearTimeout(lockRolloverTimer);
  currentPracticeDate.value = shanghaiPracticeDate();
  const delay = Math.max(1_000, nextShanghaiRolloverAt() - Date.now() + 50);
  lockRolloverTimer = window.setTimeout(scheduleLockRollover, delay);
}

async function loadAssignment(targetDate = practiceDate.value) {
  if (!targetDate) return;
  assignmentError.value = '';
  await assignmentRequests.runLatest(
    ({ signal }) => getFixedAssignment(targetDate, { signal }),
    {
      commit(result) {
        if (practiceDate.value !== targetDate) return;
        assignment.value = result;
        selected.value = result
          ? [...result.questions].sort((a, b) => a.ordinal - b.ordinal)
          : [];
        note.value = result?.note ?? '';
      },
      onError(caught) {
        if (practiceDate.value === targetDate) {
          assignmentError.value = formatError(caught, '固定题配置加载失败');
        }
      },
    },
  );
}

async function loadCandidates(nextPage = page.value, navigate = false) {
  retryPage.value = nextPage;
  const filterKey = currentFilterKey.value;
  const filters = {
    practiceDate: practiceDate.value,
    subjectId: subjectId.value,
    chapterIds: [...chapterIds.value],
    chapterMatch: chapterMatch.value,
    includeCrossChapter: includeCrossChapter.value,
    typeLabel: typeLabel.value,
    pastPaper: pastPaper.value,
    search: search.value,
    page: nextPage,
    pageSize,
  };
  candidatesError.value = '';
  const task = async ({ signal }: { signal: AbortSignal }) => {
    const result = await getFixedQuestionCandidates(filters, { signal });
    const correctedPage = Math.max(1, Math.ceil(result.total / pageSize));
    if (result.total > 0 && !result.items.length && nextPage > correctedPage) {
      return getFixedQuestionCandidates(
        { ...filters, page: correctedPage },
        { signal },
      );
    }
    return result;
  };
  const callbacks = {
    commit(result: Awaited<ReturnType<typeof getFixedQuestionCandidates>>) {
      if (currentFilterKey.value !== filterKey) return;
      candidates.value = result.items;
      total.value = result.total;
      page.value = result.page;
      retryPage.value = result.page;
      committedFilterKey.value = filterKey;
      candidatesLoaded.value = true;
    },
    onError(caught: unknown) {
      candidatesError.value = formatError(caught, '固定题候选加载失败');
    },
  };
  if (navigate) await candidateRequests.runPage(page, nextPage, task, callbacks);
  else await candidateRequests.runLatest(task, callbacks);
}

function applyFilters() {
  void loadCandidates(1, true);
}

function changeSubject() {
  chapterIds.value = [];
  chapterMatch.value = 'ANY';
  includeCrossChapter.value = false;
  typeLabel.value = '';
  applyFilters();
}

function applySearch() {
  search.value = searchInput.value.trim();
  applyFilters();
}

function toggleCandidate(candidate: DailyPracticeFixedQuestionCandidate) {
  if (editorDisabled.value) return;
  if (!['MANUAL', 'CSV'].includes(candidate.origin)) {
    toast.error('固定题只能选择人工录入或 CSV 导入题目');
    return;
  }
  if (selectedIds.value.has(candidate.id)) {
    selected.value = selected.value.filter((item) => item.id !== candidate.id);
    return;
  }
  if (selected.value.length >= MAX_FIXED_QUESTIONS) {
    toast.error(`每个练习日最多设置 ${MAX_FIXED_QUESTIONS} 道固定题`);
    return;
  }
  selected.value = [...selected.value, candidate];
}

function move(index: number, offset: -1 | 1) {
  if (editorDisabled.value) return;
  const nextIndex = index + offset;
  if (nextIndex < 0 || nextIndex >= selected.value.length) return;
  const next = [...selected.value];
  [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
  selected.value = next;
}

function remove(id: string) {
  if (editorDisabled.value) return;
  selected.value = selected.value.filter((item) => item.id !== id);
}

async function save() {
  if (saving.value) return;
  currentPracticeDate.value = shanghaiPracticeDate();
  const targetDate = practiceDate.value;
  if (!targetDate) {
    toast.error('请选择目标练习日');
    return;
  }
  if (targetDate <= currentPracticeDate.value) {
    toast.error('当日 04:00 周期已锁定，只能编辑下一练习日或更晚日期');
    return;
  }
  const questionIds = selected.value.map((item) => item.id);
  const expectedRevision = assignment.value?.revision ?? 0;
  const revisionNote = note.value.trim();
  confirming.value = true;
  let ok = false;
  try {
    ok = await confirm({
      title: questionIds.length ? '发布全班固定题' : '清空全班固定题',
      body: questionIds.length
        ? `${targetDate} 将按当前顺序追加 ${questionIds.length} 道非 AI 固定题。`
        : `${targetDate} 将发布零题修订，历史配置不会删除。`,
      confirmText: '发布修订',
      danger: !questionIds.length && Boolean(assignment.value?.questions.length),
    });
  } finally {
    confirming.value = false;
  }
  if (!ok || practiceDate.value !== targetDate) return;
  try {
    await actionRequests.runBusy(`fixed-assignment:${targetDate}`, async () => {
      assignmentRequests.cancelLatest();
      const result = await publishFixedAssignment({
        practiceDate: targetDate,
        expectedRevision,
        questionIds,
        ...(revisionNote ? { note: revisionNote } : {}),
      });
      if (practiceDate.value !== targetDate) return;
      assignment.value = result;
      selected.value = [...result.questions].sort((a, b) => a.ordinal - b.ordinal);
      note.value = result.note ?? '';
      toast.success('固定题修订已发布');
    });
  } catch (caught) {
    toast.error(formatError(caught, '固定题发布失败'));
    if (practiceDate.value === targetDate) await loadAssignment(targetDate);
  }
}

watch(practiceDate, (targetDate) => {
  assignment.value = null;
  selected.value = [];
  note.value = '';
  assignmentError.value = '';
  void loadAssignment(targetDate);
  void loadCandidates(1);
});

onMounted(() => {
  scheduleLockRollover();
  void ensureFilters();
  void Promise.all([loadAssignment(), loadCandidates()]);
});
onBeforeUnmount(() => {
  if (lockRolloverTimer !== undefined) window.clearTimeout(lockRolloverTimer);
});
</script>

<template>
  <section class="fixed-section" aria-labelledby="fixed-question-title">
    <header class="section-heading">
      <div>
        <p class="section-kicker">全班附加部分</p>
        <h3 id="fixed-question-title">固定题目</h3>
      </div>
      <div class="field date-field">
        <label for="fixed-practice-date">练习日</label>
        <input id="fixed-practice-date" v-model="practiceDate" type="date" :disabled="saving" />
      </div>
    </header>

    <p v-if="dateLocked" class="alert warning" role="status">
      该练习日的 04:00 周期已经锁定。可查看现有配置，但不能再修改固定题。
    </p>

    <SkeletonBlock v-if="assignmentLoading && !assignment" :lines="3" />
    <ErrorState v-else-if="assignmentError" :message="assignmentError" @retry="loadAssignment" />
    <p v-else-if="!assignment && !selected.length" class="alert info">
      该练习日未设置固定题。默认不会为任何用户追加题目。
    </p>

    <div class="fixed-layout">
      <section class="candidate-panel" aria-labelledby="fixed-candidates-title">
        <h4 id="fixed-candidates-title">选择题目</h4>
        <form class="candidate-filters" @submit.prevent="applySearch">
          <div class="field">
            <label for="fixed-subject">学科</label>
            <select id="fixed-subject" v-model="subjectId" @change="changeSubject">
              <option value="">全部学科</option>
              <option v-for="group in groups" :key="group.subjectId" :value="group.subjectId">
                {{ group.subject }}
              </option>
            </select>
          </div>
          <div class="field">
            <label for="fixed-chapters">章节</label>
            <QuizChapterSelect
              id="fixed-chapters"
              v-model="chapterIds"
              v-model:match="chapterMatch"
              :options="chapterOptions"
              :disabled="!subjectId"
              :placeholder="subjectId ? '全部章节' : '请先选择学科'"
              @change="applyFilters"
            />
          </div>
          <div class="field">
            <label for="fixed-type">题型</label>
            <select id="fixed-type" v-model="typeLabel" :disabled="!subjectId" @change="applyFilters">
              <option value="">全部题型</option>
              <option v-for="option in typeOptions" :key="option.label" :value="option.label">
                {{ option.label }}（{{ option.total }}）
              </option>
            </select>
          </div>
          <div class="field">
            <label for="fixed-paper">往年真题</label>
            <select id="fixed-paper" v-model="pastPaper" @change="applyFilters">
              <option value="ALL">全部</option>
              <option value="EXCLUDE">排除</option>
              <option value="ONLY">仅往年真题</option>
            </select>
          </div>
          <label class="cross-chapter-option">
            <input v-model="includeCrossChapter" type="checkbox" @change="applyFilters" />
            加入综合题
          </label>
          <QuizKeywordSearch id="fixed-search" v-model="searchInput" :disabled="candidatesLoading" />
        </form>
        <p class="field-hint">仅展示所选练习日已学范围内的两科题目。历史 AI 生成题已退役，不参与新的练习。</p>
        <p v-if="filtersError" class="alert warning">{{ filtersError }}</p>
        <p
          v-if="candidatesError && candidatesMatchFilters"
          class="alert error"
          role="alert"
        >
          {{ candidatesError }}
        </p>
        <SkeletonBlock v-if="candidatesLoading && !candidatesMatchFilters" :lines="5" />
        <ErrorState
          v-else-if="candidatesError && !candidatesMatchFilters"
          :message="candidatesError"
          @retry="loadCandidates(retryPage, true)"
        />
        <EmptyState
          v-else-if="candidatesMatchFilters && !candidates.length"
          title="所选日期没有符合已学范围的题目"
          hint="调整学科、章节、题型或关键词后重试"
        />
        <ul v-else-if="candidatesMatchFilters" class="candidate-list">
          <li v-for="candidate in candidates" :key="candidate.id">
            <label>
              <input
                type="checkbox"
                :checked="selectedIds.has(candidate.id)"
                :disabled="editorDisabled"
                @change="toggleCandidate(candidate)"
              />
              <span>
                <span class="candidate-tags">
                  <StatusBadge :text="candidate.origin" tone="muted" />
                  <StatusBadge :text="candidate.typeLabel" tone="accent" />
                  <StatusBadge :text="candidate.subject" />
                  <StatusBadge v-if="candidate.isPastPaper" text="往年真题" tone="warning" />
                </span>
                <strong>{{ candidate.prompt }}</strong>
                <small class="candidate-chapters">
                  {{ candidate.chapters.map((chapter) => chapter.name).join('、') || '未标注章节' }}
                </small>
              </span>
            </label>
          </li>
        </ul>
        <PaginationControl
          v-if="candidatesMatchFilters"
          :page="page"
          :page-count="pageCount"
          @update:page="loadCandidates($event, true)"
        />
      </section>

      <section class="selected-panel" aria-labelledby="selected-fixed-title">
        <header class="selected-heading">
          <h4 id="selected-fixed-title">已选顺序</h4>
          <strong>{{ selected.length }} / {{ MAX_FIXED_QUESTIONS }}</strong>
        </header>
        <EmptyState
          v-if="!selected.length"
          title="尚未选择固定题"
          hint="保存时会发布零题修订"
        />
        <ol v-else class="selected-list">
          <li v-for="(item, index) in selected" :key="item.id">
            <span class="selected-order">{{ index + 1 }}</span>
            <div class="selected-copy">
              <p>{{ item.prompt }}</p>
              <small>{{ item.subject }} · {{ item.chapters.map((chapter) => chapter.name).join('、') || '未标注章节' }}</small>
            </div>
            <div class="selected-actions">
              <button
                type="button"
                class="icon-button small"
                title="上移"
                aria-label="上移题目"
                :disabled="editorDisabled || index === 0"
                @click="move(index, -1)"
              ><ArrowUp :size="15" aria-hidden="true" /></button>
              <button
                type="button"
                class="icon-button small"
                title="下移"
                aria-label="下移题目"
                :disabled="editorDisabled || index === selected.length - 1"
                @click="move(index, 1)"
              ><ArrowDown :size="15" aria-hidden="true" /></button>
              <button
                type="button"
                class="icon-button small"
                title="移除"
                aria-label="移除题目"
                :disabled="editorDisabled"
                @click="remove(item.id)"
              ><X :size="15" aria-hidden="true" /></button>
            </div>
          </li>
        </ol>
        <div class="field">
          <label for="fixed-note">修订说明</label>
          <textarea id="fixed-note" v-model="note" maxlength="300" rows="3" :disabled="editorDisabled" />
        </div>
        <p class="field-hint">
          发布后每位用户仍有 5-10 道个性化题，并按当前顺序追加 {{ selected.length }} 道固定题。
        </p>
        <button type="button" class="button save-button" :disabled="saving || assignmentLoading || dateLocked" @click="save">
          <Save :size="16" aria-hidden="true" />
          {{ saving ? '正在发布…' : '发布固定题修订' }}
        </button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.fixed-section {
  display: grid;
  gap: var(--space-5);
  padding-top: var(--space-6);
  border-top: 1px solid var(--border);
}

.section-heading,
.selected-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
}

.section-heading h3,
.section-kicker,
.candidate-panel h4,
.selected-panel h4,
.candidate-list,
.selected-list,
.selected-list p {
  margin: 0;
}

.section-heading h3 {
  margin-top: 3px;
  font-size: 18px;
}

.section-kicker {
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.date-field {
  width: min(220px, 100%);
}

.fixed-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.65fr);
  gap: var(--space-6);
  align-items: start;
}

.candidate-panel,
.selected-panel {
  min-width: 0;
  display: grid;
  gap: var(--space-4);
}

.candidate-filters {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
}

.cross-chapter-option {
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-soft);
  font-size: 13px;
}

.cross-chapter-option input,
.candidate-list input {
  width: 18px;
  height: 18px;
  flex: none;
  accent-color: var(--accent);
}

.candidate-list,
.selected-list {
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border);
}

.candidate-list li,
.selected-list li {
  min-width: 0;
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}

.candidate-list label {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  cursor: pointer;
}

.candidate-list label > span {
  min-width: 0;
  display: grid;
  gap: var(--space-2);
}

.candidate-list strong {
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.candidate-chapters,
.selected-copy small {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.candidate-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.selected-list li {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
}

.selected-order {
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 650;
}

.selected-copy,
.selected-list p {
  min-width: 0;
}

.selected-copy {
  display: grid;
  gap: 2px;
}

.selected-list p {
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.selected-actions {
  display: flex;
  gap: var(--space-1);
}

.save-button {
  width: 100%;
}

@media (max-width: 900px) {
  .fixed-layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .section-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .date-field {
    width: 100%;
  }

  .candidate-filters {
    grid-template-columns: 1fr;
  }

  .selected-list li {
    grid-template-columns: 24px minmax(0, 1fr);
  }

  .selected-actions {
    grid-column: 2;
    flex-wrap: wrap;
  }
}
</style>
