<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { FileText, Play } from "lucide-vue-next";
import EmptyState from "../common/EmptyState.vue";
import ErrorState from "../common/ErrorState.vue";
import SkeletonBlock from "../common/SkeletonBlock.vue";
import StatusBadge from "../common/StatusBadge.vue";
import { api, formatError } from "../../lib/api";
import { useQuizFilters } from "../../composables/useQuizFilters";
import type {
  QuizPaperListResponse,
  QuizPaperSummary,
  QuizStartResponse,
} from "../../types";

const emit = defineEmits<{ started: [payload: QuizStartResponse] }>();

const { groups, ensure: ensureFilters } = useQuizFilters();
const subjectId = ref("");
const papers = ref<QuizPaperSummary[]>([]);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref("");
const startingId = ref("");
const startError = ref("");

const subjects = computed(() =>
  groups.value.map((group) => ({ id: group.subjectId, name: group.subject })),
);

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const params = new URLSearchParams();
    if (subjectId.value) params.set("subjectId", subjectId.value);
    const suffix = params.size ? `?${params.toString()}` : "";
    const data = await api<QuizPaperListResponse>(`/quizzes/papers${suffix}`);
    papers.value = data.items;
    loaded.value = true;
  } catch (caught) {
    loadError.value = formatError(caught, "往年真题加载失败，请稍后重试");
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  // 学科筛选失败不影响按全部学科浏览试卷（错误状态由共享缓存保留）
  void ensureFilters();
  void load();
});

function onSubjectChange() {
  void load();
}

async function startPaper(paper: QuizPaperSummary) {
  if (startingId.value || paper.questionCount < 1) return;
  startingId.value = paper.id;
  startError.value = "";
  try {
    const data = await api<QuizStartResponse>(
      `/quizzes/papers/${paper.id}/start`,
      { method: "POST" },
    );
    emit("started", data);
  } catch (caught) {
    startError.value = formatError(caught, "无法开始整套测试，请稍后重试");
  } finally {
    startingId.value = "";
  }
}
</script>

<template>
  <div class="quiz-papers">
    <div class="field paper-subject-field">
      <label for="papers-subject">学科</label>
      <select
        id="papers-subject"
        v-model="subjectId"
        :disabled="loading"
        @change="onSubjectChange"
      >
        <option value="">全部学科</option>
        <option v-for="item in subjects" :key="item.id" :value="item.id">
          {{ item.name }}
        </option>
      </select>
    </div>

    <p v-if="startError" class="alert error" role="alert">{{ startError }}</p>
    <SkeletonBlock v-if="loading" :lines="4" />
    <ErrorState v-else-if="loadError" :message="loadError" @retry="load" />
    <EmptyState
      v-else-if="loaded && !papers.length"
      title="暂无往年真题试卷"
      :hint="subjectId ? '该学科还没有往年真题，可切换其他学科查看' : '还没有导入任何往年真题试卷'"
    />
    <ul v-else class="paper-list">
      <li v-for="paper in papers" :key="paper.id" class="paper-item">
        <div class="paper-icon" aria-hidden="true">
          <FileText :size="20" />
        </div>
        <div class="paper-body">
          <h3 class="paper-title">
            {{ paper.title }}
            <span v-if="paper.year" class="paper-year">{{ paper.year }} 年</span>
          </h3>
          <p class="paper-meta">
            {{ paper.subject }} · 共 {{ paper.questionCount }} 题
            <template v-if="paper.retiredQuestionCount">可练习 · {{ paper.retiredQuestionCount }} 题已退役</template>
          </p>
          <div v-if="paper.typeLabels?.length" class="paper-types">
            <StatusBadge
              v-for="label in paper.typeLabels"
              :key="label"
              :text="label"
              tone="muted"
            />
          </div>
        </div>
        <button
          type="button"
          class="button paper-start"
          :disabled="Boolean(startingId) || paper.questionCount < 1"
          @click="startPaper(paper)"
        >
          <Play :size="15" aria-hidden="true" />
          {{ startingId === paper.id ? "正在准备…" : "整套测试" }}
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.quiz-papers {
  display: grid;
  gap: var(--space-4);
}

.paper-subject-field {
  max-width: 240px;
}

.paper-list {
  display: grid;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.paper-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-l);
  background: var(--surface);
}

.paper-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: var(--radius-m);
  background: var(--accent-soft);
  color: var(--accent-dark);
}

.paper-body {
  display: grid;
  gap: var(--space-1);
  min-width: 0;
  flex: 1;
}

.paper-title {
  margin: 0;
  font-size: 16px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.paper-year {
  margin-left: var(--space-2);
  color: var(--muted);
  font-size: 13px;
  font-weight: 400;
}

.paper-meta {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.paper-types {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.paper-start {
  flex: none;
}

@media (max-width: 560px) {
  .paper-item {
    flex-wrap: wrap;
  }

  .paper-start {
    width: 100%;
    justify-content: center;
  }
}
</style>
