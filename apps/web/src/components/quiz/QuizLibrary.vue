<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { CheckCheck, Play, X } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import PaginationControl from '../common/PaginationControl.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import QuizChapterSelect from './QuizChapterSelect.vue';
import QuizKeywordSearch from './QuizKeywordSearch.vue';
import QuizQuestionImages from './QuizQuestionImages.vue';
import { api, formatError } from '../../lib/api';
import { useQuizFilters } from '../../composables/useQuizFilters';
import type {
  QuizLibraryResponse,
  QuizQuestionSummary,
  QuizStartResponse,
} from '../../types';

const emit = defineEmits<{ started: [payload: QuizStartResponse] }>();

/** 自由组卷上限与后端一致 */
const MAX_SELECT = 100;

const { groups, error: filtersError, ensure: ensureFilters } = useQuizFilters();

const subjectId = ref('');
const chapterIds = ref<string[]>([]);
const chapterMatch = ref<'ANY' | 'ALL'>('ANY');
const includeCrossChapter = ref(false);
const typeLabel = ref('');
const pastPaper = ref<'ALL' | 'EXCLUDE' | 'ONLY'>('ALL');
const searchInput = ref('');
const search = ref('');
const page = ref(1);
const pageSize = ref(20);

const items = ref<QuizQuestionSummary[]>([]);
const total = ref(0);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref('');

/** 跨页保留选择，提交时保持选择顺序 */
const selected = ref<string[]>([]);
const starting = ref(false);
const startError = ref('');
const selectHint = ref('');

const activeGroup = computed(
  () =>
    groups.value.find((group) => group.subjectId === subjectId.value) ?? null,
);
const chapterOptions = computed(() => activeGroup.value?.chapters ?? []);
const chapterSelectOptions = computed(() =>
  chapterOptions.value.map((chapter) => ({
    id: chapter.chapterId,
    label: chapter.chapter,
    count: chapter.total,
  })),
);
const typeOptions = computed(() => activeGroup.value?.types ?? []);
const pageCount = computed(() =>
  Math.max(1, Math.ceil(total.value / pageSize.value)),
);
const selectedSet = computed(() => new Set(selected.value));
const currentPageIds = computed(() => items.value.map((item) => item.id));
const selectedOnPageCount = computed(
  () =>
    currentPageIds.value.filter((id) => selectedSet.value.has(id)).length,
);
const allCurrentPageSelected = computed(
  () =>
    currentPageIds.value.length > 0 &&
    selectedOnPageCount.value === currentPageIds.value.length,
);

/** 筛选数据刷新后，清理已不在当前学科下的章节和题型选择 */
watch(groups, () => {
  if (
    chapterIds.value.length &&
    chapterIds.value.some(
      (id) => !chapterOptions.value.some((option) => option.chapterId === id),
    )
  )
    chapterIds.value = [];
  if (
    typeLabel.value &&
    !typeOptions.value.some((type) => type.label === typeLabel.value)
  )
    typeLabel.value = '';
});

async function load() {
  loading.value = true;
  loadError.value = '';
  try {
    const params = new URLSearchParams();
    if (subjectId.value) params.set('subjectId', subjectId.value);
    if (chapterIds.value.length) {
      params.set('chapterIds', chapterIds.value.join(','));
      params.set('chapterMatch', chapterMatch.value);
    }
    if (includeCrossChapter.value) params.set('includeCrossChapter', 'true');
    if (typeLabel.value) params.set('typeLabel', typeLabel.value);
    if (pastPaper.value !== 'ALL') params.set('pastPaper', pastPaper.value);
    if (search.value) params.set('search', search.value);
    params.set('page', String(page.value));
    params.set('pageSize', String(pageSize.value));
    const data = await api<QuizLibraryResponse>(
      `/quizzes/questions?${params.toString()}`,
    );
    items.value = data.items;
    total.value = data.total;
    loaded.value = true;
  } catch (caught) {
    loadError.value = formatError(caught, '题库加载失败，请稍后重试');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void ensureFilters();
  void load();
});

/** 筛选变化回到第 1 页；跨页选择始终保留并持续显示数量 */
function applyFilters() {
  if (page.value === 1) void load();
  else page.value = 1;
}

function onSubjectChange() {
  chapterIds.value = [];
  chapterMatch.value = 'ANY';
  includeCrossChapter.value = false;
  typeLabel.value = '';
  applyFilters();
}

function onChapterChange() {
  typeLabel.value = '';
  applyFilters();
}

function applySearch() {
  search.value = searchInput.value.trim();
  applyFilters();
}

watch(page, () => void load());
watch(pageSize, () => {
  if (page.value === 1) void load();
  else page.value = 1;
});

function toggleSelect(id: string) {
  selectHint.value = '';
  if (selectedSet.value.has(id)) {
    selected.value = selected.value.filter((value) => value !== id);
    return;
  }
  if (selected.value.length >= MAX_SELECT) {
    selectHint.value = `每次练习最多选择 ${MAX_SELECT} 道题，请先开始或清空当前选择`;
    return;
  }
  selected.value = [...selected.value, id];
}

function toggleCurrentPageSelection() {
  selectHint.value = '';
  if (allCurrentPageSelected.value) {
    const pageIds = new Set(currentPageIds.value);
    selected.value = selected.value.filter((id) => !pageIds.has(id));
    return;
  }

  const unselectedIds = currentPageIds.value.filter(
    (id) => !selectedSet.value.has(id),
  );
  const remaining = MAX_SELECT - selected.value.length;
  const additions = unselectedIds.slice(0, Math.max(0, remaining));
  if (additions.length) selected.value = [...selected.value, ...additions];

  const skipped = unselectedIds.length - additions.length;
  if (skipped > 0) {
    selectHint.value = `已达到 ${MAX_SELECT} 道上限，本页还有 ${skipped} 道题未选择`;
  }
}

function clearSelection() {
  selected.value = [];
  selectHint.value = '';
}

async function startSelected() {
  if (!selected.value.length || starting.value) return;
  starting.value = true;
  startError.value = '';
  try {
    const data = await api<QuizStartResponse>('/quizzes/start', {
      method: 'POST',
      body: JSON.stringify({ questionIds: [...selected.value] }),
    });
    emit('started', data);
  } catch (caught) {
    startError.value = formatError(caught, '组卷失败，请稍后重试');
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <div class="quiz-library">
    <form
      class="library-filters"
      aria-label="题库筛选"
      @submit.prevent="applySearch"
    >
      <div class="field">
        <label for="library-subject">学科</label>
        <select
          id="library-subject"
          v-model="subjectId"
          :disabled="loading"
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
      <div class="field">
        <label for="library-chapters">章节</label>
        <QuizChapterSelect
          id="library-chapters"
          v-model="chapterIds"
          v-model:match="chapterMatch"
          :options="chapterSelectOptions"
          :disabled="loading || !subjectId"
          :placeholder="subjectId ? '全部章节' : '请先选择学科'"
          @change="onChapterChange"
        />
      </div>
      <div class="field">
        <label for="library-comprehensive">综合题</label>
        <select
          id="library-comprehensive"
          v-model="includeCrossChapter"
          :disabled="loading"
          @change="applyFilters"
        >
          <option :value="false">不加入综合题</option>
          <option :value="true">加入综合题</option>
        </select>
      </div>
      <div class="field">
        <label for="library-type">题型</label>
        <select
          id="library-type"
          v-model="typeLabel"
          :disabled="loading || !subjectId"
          @change="applyFilters"
        >
          <option value="">
            {{ subjectId ? '全部题型' : '请先选择学科' }}
          </option>
          <option
            v-for="type in typeOptions"
            :key="type.label"
            :value="type.label"
          >
            {{ type.label }}（{{ type.total }}）
          </option>
        </select>
      </div>
      <div class="field">
        <label for="library-past-paper">往年真题</label>
        <select
          id="library-past-paper"
          v-model="pastPaper"
          :disabled="loading"
          @change="applyFilters"
        >
          <option value="ALL">全部题目</option>
          <option value="EXCLUDE">排除往年真题</option>
          <option value="ONLY">仅往年真题</option>
        </select>
      </div>
      <QuizKeywordSearch
        id="library-search-input"
        v-model="searchInput"
        :disabled="loading"
      />
    </form>
    <p v-if="filtersError" class="field-hint" role="status">
      {{ filtersError }}，学科、章节与题型筛选不可用，列表仍可浏览。
    </p>

    <SkeletonBlock v-if="loading" :lines="6" />
    <ErrorState v-else-if="loadError" :message="loadError" @retry="load" />
    <EmptyState
      v-else-if="loaded && !items.length"
      title="没有符合条件的题目"
      hint="调整学科、章节、题型或关键词后重试"
    />
    <template v-else>
      <div class="library-summary">
        <p class="library-total" role="status">共 {{ total }} 道题目</p>
        <button
          type="button"
          class="button ghost page-selection-button"
          :disabled="loading || !items.length"
          :aria-pressed="allCurrentPageSelected"
          @click="toggleCurrentPageSelection"
        >
          <CheckCheck :size="16" aria-hidden="true" />
          {{ allCurrentPageSelected ? '取消本页选择' : '全选本页' }}
          <span v-if="selectedOnPageCount">（{{ selectedOnPageCount }}）</span>
        </button>
      </div>
      <ul class="question-list">
        <li v-for="question in items" :key="question.id" class="question-item">
          <label class="question-select">
            <input
              type="checkbox"
              :checked="selectedSet.has(question.id)"
              :aria-label="`选择题目：${question.prompt.slice(0, 30)}`"
              @change="toggleSelect(question.id)"
            />
          </label>
          <article class="question-body">
            <div class="question-tags">
              <StatusBadge :text="question.subject" tone="muted" />
              <StatusBadge
                v-for="chapter in question.chapters"
                :key="chapter.id"
                :text="chapter.name"
                tone=""
              />
              <StatusBadge :text="question.typeLabel" tone="accent" />
              <StatusBadge
                v-if="question.isPastPaper"
                :text="
                  question.pastPaper
                    ? `往年真题 · ${question.pastPaper.title}${
                        question.pastPaper.year
                          ? `（${question.pastPaper.year}）`
                          : ''
                      }`
                    : '往年真题'
                "
                tone="warning"
              />
            </div>
            <p class="question-prompt">{{ question.prompt }}</p>
            <QuizQuestionImages
              v-if="question.images.length"
              :images="question.images"
              :alt-context="question.prompt"
            />
            <ul v-if="question.options.length" class="question-options">
              <li v-for="option in question.options" :key="option.id">
                <strong>{{ option.id }}.</strong> {{ option.text }}
              </li>
            </ul>
          </article>
        </li>
      </ul>
      <PaginationControl
        :page="page"
        :page-count="pageCount"
        @update:page="page = $event"
      />
      <div class="field page-size-field">
        <label for="library-page-size">每页数量</label>
        <select
          id="library-page-size"
          v-model.number="pageSize"
          :disabled="loading"
        >
          <option :value="10">10 / 页</option>
          <option :value="20">20 / 页</option>
          <option :value="50">50 / 页</option>
        </select>
      </div>
    </template>

    <div class="selection-bar" role="region" aria-label="自由组卷">
      <p class="selection-count" role="status">
        已选 <strong>{{ selected.length }}</strong> / {{ MAX_SELECT }} 题
        <span v-if="selected.length" class="selection-note">（跨页保留）</span>
      </p>
      <p v-if="selectHint" class="selection-hint" role="alert">
        {{ selectHint }}
      </p>
      <p v-if="startError" class="alert error" role="alert">{{ startError }}</p>
      <div class="selection-actions">
        <button
          type="button"
          class="button ghost"
          :disabled="!selected.length || starting"
          @click="clearSelection"
        >
          <X :size="15" aria-hidden="true" />
          清空选择
        </button>
        <button
          type="button"
          class="button"
          :disabled="!selected.length || starting"
          @click="startSelected"
        >
          <Play :size="16" aria-hidden="true" />
          {{ starting ? '正在组卷…' : `开始所选练习（${selected.length}）` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.quiz-library {
  display: grid;
  gap: var(--space-4);
}

.library-filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3) var(--space-4);
  align-items: flex-end;
}

.library-filters .field {
  flex: 1 1 150px;
  min-width: 0;
}

.library-total {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.library-summary {
  display: flex;
  align-items: center;
  min-height: 36px;
  gap: var(--space-3);
}

.page-selection-button {
  margin-left: auto;
  flex: 0 0 auto;
}

.question-list {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.question-item {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-l);
  background: var(--surface);
}

.question-select {
  padding-top: 2px;
}

.question-select input {
  width: 18px;
  height: 18px;
  accent-color: var(--accent);
  cursor: pointer;
}

.question-body {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  flex: 1;
}

.question-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.question-prompt {
  margin: 0;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.question-options {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--ink-soft);
}

.question-options li {
  overflow-wrap: anywhere;
}

.page-size-field {
  max-width: 140px;
}

.selection-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-s);
}

.selection-count {
  margin: 0;
  color: var(--ink-soft);
}

.selection-note {
  color: var(--muted);
  font-size: 12px;
}

.selection-hint {
  margin: 0;
  color: var(--warning);
  font-size: 13px;
}

.selection-actions {
  display: flex;
  gap: var(--space-3);
  margin-left: auto;
  flex-wrap: wrap;
}

@media (max-width: 560px) {
  .selection-actions {
    margin-left: 0;
    width: 100%;
  }

  .selection-actions .button {
    flex: 1;
    justify-content: center;
  }
}
</style>
