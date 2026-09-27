<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import PaginationControl from '../common/PaginationControl.vue';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useQuizFilters } from '../../composables/useQuizFilters';
import { api, formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import { labelOf, questionTypeLabels } from '../../lib/labels';
import { optionTexts } from '../../lib/quiz';
import type { ChapterMatch, QuizWrongResponse } from '../../types';
import QuizChapterSelect from './QuizChapterSelect.vue';
import QuizKeywordSearch from './QuizKeywordSearch.vue';

const page = ref(1);
const pageSize = 20;
const subjectId = ref('');
const chapterIds = ref<string[]>([]);
const chapterMatch = ref<ChapterMatch>('ANY');
const includeCrossChapter = ref(false);
const typeLabel = ref('');
const source = ref('');
const searchInput = ref('');
const search = ref('');

const { groups, error: filtersError, ensure: ensureFilters } = useQuizFilters();
const activeGroup = computed(
  () =>
    groups.value.find((group) => group.subjectId === subjectId.value) ?? null,
);
const typeOptions = computed(() => activeGroup.value?.types ?? []);
const chapterOptions = computed(() =>
  (activeGroup.value?.chapters ?? []).map((chapter) => ({
    id: chapter.chapterId,
    label: chapter.chapter,
    count: chapter.total,
  })),
);

function requestParams(targetPage = page.value) {
  const params = new URLSearchParams({
    page: String(targetPage),
    pageSize: String(pageSize),
  });
  if (subjectId.value) params.set('subjectId', subjectId.value);
  if (chapterIds.value.length) {
    params.set('chapterIds', chapterIds.value.join(','));
    params.set('chapterMatch', chapterMatch.value);
  }
  if (includeCrossChapter.value) params.set('includeCrossChapter', 'true');
  if (typeLabel.value) params.set('typeLabel', typeLabel.value);
  if (source.value) params.set('source', source.value);
  if (search.value) params.set('search', search.value);
  return params;
}

const data = ref<QuizWrongResponse | null>(null);
const loaded = ref(false);
const error = ref('');
const requests = useLatestRequest();
const loading = requests.loading;
let stablePage = page.value;
let stableFilterKey = '';
const preserveStableDataOnError = ref(false);
const items = computed(() => data.value?.items ?? []);
const pageCount = computed(() =>
  Math.max(1, Math.ceil((data.value?.total ?? 0) / pageSize)),
);

async function load(nextPage = page.value, navigate = false) {
  error.value = '';
  preserveStableDataOnError.value = false;
  if (navigate) page.value = nextPage;
  const baseParams = requestParams(nextPage);
  const filterParams = new URLSearchParams(baseParams);
  filterParams.delete('page');
  const requestedFilterKey = filterParams.toString();
  const fetchPage = (targetPage: number, signal: AbortSignal) => {
    const params = new URLSearchParams(baseParams);
    params.set('page', String(targetPage));
    return api<QuizWrongResponse>(`/quizzes/wrong?${params.toString()}`, {
      signal,
    });
  };
  const task = async ({ signal }: { signal: AbortSignal }) => {
    const result = await fetchPage(nextPage, signal);
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
    if (result.page <= lastPage) return result;
    const corrected = await fetchPage(lastPage, signal);
    const correctedLastPage = Math.max(1, Math.ceil(corrected.total / pageSize));
    if (corrected.page > correctedLastPage) {
      throw new Error('错题记录在加载期间发生变化，请重试');
    }
    return corrected;
  };
  const callbacks = {
    commit(result: QuizWrongResponse) {
      data.value = result;
      page.value = result.page;
      stablePage = result.page;
      stableFilterKey = requestedFilterKey;
      loaded.value = true;
    },
    onError(caught: unknown) {
      preserveStableDataOnError.value = loaded.value
        && requestedFilterKey === stableFilterKey;
      page.value = preserveStableDataOnError.value ? stablePage : nextPage;
      error.value = formatError(caught, '错题记录加载失败');
    },
  };
  await requests.runLatest(task, callbacks);
}

onMounted(() => {
  void ensureFilters();
  void load();
});

watch(groups, () => {
  const validChapterIds = new Set(
    activeGroup.value?.chapters.map((chapter) => chapter.chapterId) ?? [],
  );
  if (chapterIds.value.some((id) => !validChapterIds.has(id))) {
    chapterIds.value = [];
    chapterMatch.value = 'ANY';
  }
  if (
    typeLabel.value &&
    !typeOptions.value.some((type) => type.label === typeLabel.value)
  ) {
    typeLabel.value = '';
  }
});
function applyFilters() {
  void load(1, true);
}

function onSubjectChange() {
  chapterIds.value = [];
  chapterMatch.value = 'ANY';
  includeCrossChapter.value = false;
  typeLabel.value = '';
  applyFilters();
}

function onChapterChange() {
  applyFilters();
}

function applySearch() {
  search.value = searchInput.value.trim();
  applyFilters();
}
</script>

<template>
  <div class="wrong-list">
    <form
      class="wrong-filters"
      aria-label="错题筛选"
      @submit.prevent="applySearch"
    >
      <div class="field">
        <label for="wrong-subject">学科</label>
        <select
          id="wrong-subject"
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
        <label for="wrong-chapters">章节</label>
        <QuizChapterSelect
          id="wrong-chapters"
          v-model="chapterIds"
          v-model:match="chapterMatch"
          :options="chapterOptions"
          :disabled="loading || !subjectId"
          :placeholder="subjectId ? '全部章节' : '请先选择学科'"
          @change="onChapterChange"
        />
      </div>
      <div class="field">
        <label for="wrong-comprehensive">综合题</label>
        <select
          id="wrong-comprehensive"
          v-model="includeCrossChapter"
          :disabled="loading"
          @change="applyFilters"
        >
          <option :value="false">不加入综合题</option>
          <option :value="true">加入综合题</option>
        </select>
      </div>
      <div class="field">
        <label for="wrong-type">题型</label>
        <select
          id="wrong-type"
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
            {{ type.label }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="wrong-source">来源</label>
        <select
          id="wrong-source"
          v-model="source"
          :disabled="loading"
          @change="applyFilters"
        >
          <option value="">全部来源</option>
          <option value="AI">AI 生成</option>
          <option value="NON_AI">非 AI</option>
        </select>
      </div>
      <QuizKeywordSearch
        id="wrong-search-input"
        v-model="searchInput"
        :disabled="loading"
      />
    </form>
    <p v-if="filtersError" class="field-hint" role="status">
      {{ filtersError }}，学科、章节与题型筛选不可用，错题仍可浏览。
    </p>

    <p
      v-if="error && loaded && preserveStableDataOnError"
      class="alert error"
      role="alert"
    >
      {{ error }}
      <button type="button" class="button ghost" @click="load()">重试</button>
    </p>
    <SkeletonBlock v-if="loading && !loaded" :lines="5" />
    <ErrorState
      v-else-if="error && (!loaded || !preserveStableDataOnError)"
      :message="error"
      @retry="load()"
    />
    <EmptyState
      v-else-if="!items.length"
      title="暂无符合条件的错题"
      hint="答错的题目会汇总在这里，便于复习"
    />
    <template v-else>
      <p class="wrong-total" role="status">共 {{ data?.total ?? 0 }} 道错题</p>
      <article v-for="item in items" :key="item.id" class="wrong-item card">
        <div class="wrong-head">
          <StatusBadge :text="item.subject || '历史学科'" tone="muted" />
          <StatusBadge
            v-for="chapter in item.chapters ?? []"
            :key="chapter.id"
            :text="chapter.name"
            tone=""
          />
          <StatusBadge
            :text="item.typeLabel ?? labelOf(questionTypeLabels, item.type)"
            tone="accent"
          />
          <StatusBadge
            :text="item.origin === 'AI_GENERATED' ? 'AI 生成' : '非 AI'"
            tone="muted"
          />
          <StatusBadge v-if="item.retired" text="已退役" tone="warning" />
          <span class="meta">答错 {{ item.wrongCount }} 次</span>
          <span class="meta"
            >最近答错：{{ formatDateTime(item.lastWrongAt) }}</span
          >
        </div>
        <h3 class="wrong-prompt">{{ item.prompt }}</h3>
        <p v-if="item.retired" class="field-hint">此题保留历史记录，不参与新的练习。</p>
        <p
          v-if="item.type === 'SHORT_ANSWER' && item.lastScore !== undefined"
          class="wrong-score"
        >
          最近得分：{{ item.lastScore }} / {{ item.maxScore }}
        </p>
        <p
          v-if="
            item.type === 'SHORT_ANSWER' &&
            item.lastWrongAnswer !== undefined
          "
          class="wrong-user-answer"
        >
          <strong>最近错误答案：</strong>{{ item.lastWrongAnswer || '未作答' }}
        </p>
        <ul v-if="item.type !== 'SHORT_ANSWER'" class="wrong-options">
          <li
            v-for="option in item.options"
            :key="option.id"
            :class="{ correct: item.correctAnswer.includes(option.id) }"
          >
            {{ option.text }}
          </li>
        </ul>
        <p v-if="item.lastFeedback" class="wrong-feedback">
          {{ item.lastFeedback }}
        </p>
        <ul v-if="item.criterionScores?.length" class="wrong-criteria">
          <li
            v-for="criterion in item.criterionScores"
            :key="criterion.description"
          >
            {{ criterion.description }}：{{ criterion.awardedPoints }} /
            {{ criterion.maxPoints }} 分
          </li>
        </ul>
        <p class="wrong-answer">
          <strong>{{
            item.type === 'SHORT_ANSWER' ? '参考答案：' : '正确答案：'
          }}</strong>
          {{
            optionTexts(item, item.correctAnswer).join(
              item.type === 'SHORT_ANSWER' ? '；' : '、',
            )
          }}
        </p>
        <p v-if="item.explanation" class="wrong-explanation">
          {{ item.explanation }}
        </p>
      </article>
      <PaginationControl
        :page="page"
        :page-count="pageCount"
        @update:page="load($event, true)"
      />
    </template>
  </div>
</template>

<style scoped>
.wrong-list {
  display: grid;
  gap: var(--space-4);
}

.wrong-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-3) var(--space-4);
}

.wrong-filters .field {
  flex: 1 1 150px;
  min-width: 0;
}

.wrong-total {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.wrong-item {
  display: grid;
  gap: var(--space-3);
}

.wrong-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.wrong-prompt {
  margin: 0;
  font-size: 16px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.wrong-options {
  margin: 0;
  padding-left: var(--space-5);
  display: grid;
  gap: var(--space-1);
  color: var(--ink-soft);
}

.wrong-options .correct {
  color: var(--success);
  font-weight: 550;
}

.wrong-answer {
  margin: 0;
  color: var(--success);
  white-space: pre-wrap;
}

.wrong-score,
.wrong-user-answer,
.wrong-feedback {
  margin: 0;
  color: var(--ink-soft);
  line-height: 1.7;
}

.wrong-user-answer {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.wrong-criteria {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding-left: var(--space-5);
  color: var(--muted);
}

.wrong-explanation {
  margin: 0;
  color: var(--muted);
  line-height: 1.7;
}

@media (max-width: 560px) {
  .wrong-filters .field {
    flex-basis: 100% !important;
  }
}
</style>
