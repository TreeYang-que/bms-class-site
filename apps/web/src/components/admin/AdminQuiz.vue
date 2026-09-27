<script setup lang="ts">
import {
  FileSpreadsheet,
  ListChecks,
  ListPlus,
  Plus,
  RefreshCw,
  Tags,
  X,
} from "lucide-vue-next";
import { onMounted, ref, watch } from "vue";
import { api, formatError } from "../../lib/api";
import { useKnowledgeSubjects } from "../../composables/useKnowledgeSubjects";
import type {
  QuizPaperListResponse,
  QuizPaperSummary,
  SubjectChapter,
} from "../../types";
import AdminQuizCreate from "./AdminQuizCreate.vue";
import AdminQuizImport from "./AdminQuizImport.vue";
import AdminQuizManage from "./AdminQuizManage.vue";
type QuizPane = "manage" | "create" | "import" | "taxonomy";

const props = withDefaults(defineProps<{
  initialPane?: QuizPane;
  initialSubjectId?: string;
  active?: boolean;
}>(), {
  initialPane: "manage",
  initialSubjectId: "",
  active: true,
});

const activePane = ref<QuizPane>(props.initialPane);
const papers = ref<QuizPaperSummary[]>([]);
const papersError = ref("");
const manageRef = ref<InstanceType<typeof AdminQuizManage> | null>(null);
const chapterSubjectId = ref("");
const chapters = ref<SubjectChapter[]>([]);
const chaptersLoading = ref(false);
const chaptersError = ref("");
const chapterName = ref("");
const chapterSlug = ref("");
const chapterBusy = ref(false);
const chapterMessage = ref("");

const {
  subjects,
  subjectsLoading,
  subjectsError: subjectsLoadError,
  subjectPanelOpen,
  subjectName,
  subjectSlug,
  subjectBusy,
  subjectError,
  subjectMessage,
  loadSubjects,
  createSubject,
} = useKnowledgeSubjects({
  onCreated(created) {
    chapterSubjectId.value = created.id;
  },
});

watch(
  () => subjects.value.map((subject) => subject.id),
  (ids) => {
    if (!ids.includes(chapterSubjectId.value)) {
      chapterSubjectId.value = ids[0] ?? "";
    }
  },
  { immediate: true },
);

watch([chapterSubjectId, activePane], ([, pane]) => {
  if (pane === "taxonomy") void loadChapters();
});

watch(
  () => props.initialPane,
  (pane) => {
    activePane.value = pane;
  },
);

async function loadChapters() {
  chapters.value = [];
  chaptersError.value = "";
  chapterMessage.value = "";
  if (!chapterSubjectId.value) return;
  chaptersLoading.value = true;
  try {
    chapters.value = await api<SubjectChapter[]>(
      `/subjects/${chapterSubjectId.value}/chapters?includeInactive=true`,
    );
  } catch (caught) {
    chaptersError.value = formatError(caught, "章节列表加载失败");
  } finally {
    chaptersLoading.value = false;
  }
}

async function createChapter() {
  const name = chapterName.value.trim();
  const slug = chapterSlug.value.trim();
  chaptersError.value = "";
  chapterMessage.value = "";
  if (!chapterSubjectId.value || !name || !slug) {
    chaptersError.value = "请选择学科并填写章节名称和 slug";
    return;
  }
  chapterBusy.value = true;
  try {
    const chapter = await api<SubjectChapter>(
      `/subjects/${chapterSubjectId.value}/chapters`,
      {
        method: "POST",
        body: JSON.stringify({ name, slug }),
      },
    );
    chapterName.value = "";
    chapterSlug.value = "";
    chapterMessage.value = `已创建章节“${chapter.name}”`;
    await loadChapters();
  } catch (caught) {
    chaptersError.value = formatError(caught, "章节创建失败");
  } finally {
    chapterBusy.value = false;
  }
}

async function toggleChapter(chapter: SubjectChapter) {
  chaptersError.value = "";
  try {
    await api(`/subjects/${chapter.subjectId}/chapters/${chapter.id}`, {
      method: "PATCH",
      body: JSON.stringify({ active: !chapter.active }),
    });
    await loadChapters();
    refreshManage();
  } catch (caught) {
    chaptersError.value = formatError(caught, "章节状态更新失败");
  }
}

async function loadPapers() {
  papersError.value = "";
  try {
    const data = await api<QuizPaperListResponse>("/quizzes/papers");
    papers.value = data.items;
  } catch (caught) {
    papersError.value = formatError(caught, "已有试卷列表加载失败");
  }
}

function refreshManage() {
  void manageRef.value?.reload();
}

function importCompleted() {
  void loadPapers();
  refreshManage();
}

onMounted(() => {
  void loadPapers();
  void loadSubjects();
});
</script>

<template>
  <div class="quiz-admin-root">
    <nav class="quiz-workspace-tabs" role="tablist" aria-label="题库管理视图">
      <button
        type="button"
        role="tab"
        :aria-selected="activePane === 'manage'"
        :class="{ active: activePane === 'manage' }"
        @click="activePane = 'manage'"
      >
        <ListChecks :size="16" aria-hidden="true" />
        题目管理
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activePane === 'create'"
        :class="{ active: activePane === 'create' }"
        @click="activePane = 'create'"
      >
        <ListPlus :size="16" aria-hidden="true" />
        单题录入
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activePane === 'import'"
        :class="{ active: activePane === 'import' }"
        @click="activePane = 'import'"
      >
        <FileSpreadsheet :size="16" aria-hidden="true" />
        批量导入
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activePane === 'taxonomy'"
        :class="{ active: activePane === 'taxonomy' }"
        @click="activePane = 'taxonomy'"
      >
        <Tags :size="16" aria-hidden="true" />
        学科章节
      </button>
    </nav>
    <div class="quiz-admin">
      <AdminQuizCreate
        v-if="activePane === 'create'"
        class="quiz-create-pane"
        :subjects="subjects"
        :subjects-loading="subjectsLoading"
        @created="refreshManage"
      />

      <div class="quiz-side">
        <section
          v-if="activePane === 'taxonomy'"
          aria-label="题库学科管理"
          class="subject-section"
        >
          <header class="section-header">
            <div class="section-heading">
              <span class="section-icon subject-icon" aria-hidden="true">
                <Tags :size="18" />
              </span>
              <div>
                <h3 class="section-title">学科管理</h3>
                <p class="subject-count">
                  当前 {{ subjects.length }} 个启用学科
                </p>
              </div>
            </div>
            <button
              type="button"
              class="icon-button"
              :aria-expanded="subjectPanelOpen"
              :aria-label="subjectPanelOpen ? '收起学科创建表单' : '新建学科'"
              :title="subjectPanelOpen ? '收起' : '新建学科'"
              @click="subjectPanelOpen = !subjectPanelOpen"
            >
              <X v-if="subjectPanelOpen" :size="17" aria-hidden="true" />
              <Plus v-else :size="17" aria-hidden="true" />
            </button>
          </header>

          <p
            v-if="subjectsLoadError"
            class="alert error subject-feedback"
            role="alert"
          >
            <span>{{ subjectsLoadError }}</span>
            <button
              type="button"
              class="icon-button small subject-retry"
              aria-label="重新加载学科"
              title="重新加载学科"
              :disabled="subjectsLoading"
              @click="loadSubjects"
            >
              <RefreshCw :size="15" aria-hidden="true" />
            </button>
          </p>

          <ul
            v-if="subjects.length"
            class="subject-directory"
            aria-label="已有学科"
          >
            <li v-for="subject in subjects" :key="subject.id">
              <strong>{{ subject.name }}</strong>
              <code>{{ subject.slug }}</code>
            </li>
          </ul>

          <form
            v-if="subjectPanelOpen"
            class="subject-form"
            aria-label="新建题库学科"
            @submit.prevent="createSubject"
          >
            <div class="field">
              <label for="quiz-subject-name">学科名称</label>
              <input
                id="quiz-subject-name"
                v-model="subjectName"
                required
                minlength="2"
                maxlength="100"
                :disabled="subjectBusy"
              />
            </div>
            <div class="field">
              <label for="quiz-subject-slug">slug</label>
              <input
                id="quiz-subject-slug"
                v-model="subjectSlug"
                required
                minlength="2"
                maxlength="100"
                :disabled="subjectBusy"
              />
            </div>
            <button
              class="button subject-submit"
              type="submit"
              :disabled="subjectBusy"
            >
              {{ subjectBusy ? "正在创建…" : "创建学科" }}
            </button>
            <p
              v-if="subjectError"
              class="alert error subject-feedback"
              role="alert"
            >
              {{ subjectError }}
            </p>
            <p
              v-else-if="subjectMessage"
              class="alert success subject-feedback"
              role="status"
            >
              {{ subjectMessage }}
            </p>
          </form>

          <div class="chapter-manager">
            <div class="field">
              <label for="chapter-subject">章节所属学科</label>
              <select
                id="chapter-subject"
                v-model="chapterSubjectId"
                :disabled="subjectsLoading || !subjects.length"
              >
                <option disabled value="">请选择学科</option>
                <option
                  v-for="item in subjects"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.name }}
                </option>
              </select>
            </div>

            <form class="chapter-form" @submit.prevent="createChapter">
              <div class="field">
                <label for="chapter-name">章节名称</label>
                <input
                  id="chapter-name"
                  v-model="chapterName"
                  maxlength="100"
                  :disabled="chapterBusy"
                />
              </div>
              <div class="field">
                <label for="chapter-slug">slug</label>
                <input
                  id="chapter-slug"
                  v-model="chapterSlug"
                  maxlength="100"
                  :disabled="chapterBusy"
                />
              </div>
              <button
                type="submit"
                class="button secondary"
                :disabled="chapterBusy || !chapterSubjectId"
              >
                <Plus :size="15" aria-hidden="true" />
                {{ chapterBusy ? "正在创建…" : "新建章节" }}
              </button>
            </form>

            <p v-if="chaptersLoading" class="subject-count" role="status">
              正在加载章节…
            </p>
            <p
              v-if="chaptersError"
              class="alert error subject-feedback"
              role="alert"
            >
              {{ chaptersError }}
            </p>
            <p
              v-else-if="chapterMessage"
              class="alert success subject-feedback"
              role="status"
            >
              {{ chapterMessage }}
            </p>
            <ul v-if="chapters.length" class="chapter-list">
              <li v-for="chapter in chapters" :key="chapter.id">
                <span>
                  {{ chapter.name }}
                  <small>{{ chapter.active ? "启用" : "停用" }}</small>
                </span>
                <button
                  type="button"
                  class="button ghost chapter-toggle"
                  :disabled="chapterBusy"
                  @click="toggleChapter(chapter)"
                >
                  {{ chapter.active ? "停用" : "重新启用" }}
                </button>
              </li>
            </ul>
          </div>
        </section>

        <AdminQuizImport
          v-if="activePane === 'import'"
          :subjects="subjects"
          :papers="papers"
          :papers-error="papersError"
          :active="active"
          @completed="importCompleted"
        />
      </div>
    </div>
    <AdminQuizManage
      v-if="activePane === 'manage'"
      ref="manageRef"
      @deleted="loadPapers"
    />
  </div>
</template>

<style scoped>
.quiz-admin-root {
  display: grid;
  gap: var(--space-5);
}

.quiz-workspace-tabs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding-bottom: var(--space-2);
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
}

.quiz-workspace-tabs button {
  min-height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  flex: none;
  padding: 8px 14px;
  border: 0;
  border-radius: var(--radius-s);
  color: var(--ink-soft);
  background: transparent;
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.quiz-workspace-tabs button:hover {
  color: var(--ink);
  background: var(--surface-muted);
}

.quiz-workspace-tabs button.active {
  color: var(--primary);
  background: var(--primary-soft);
}

.quiz-admin {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
}

.quiz-side {
  display: contents;
}

.quiz-create-pane,
.quiz-section,
.subject-section {
  min-width: 0;
}

.quiz-section,
.subject-section {
  display: grid;
  gap: var(--space-5);
  padding: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  box-shadow: var(--shadow-s);
}

.subject-section {
  gap: var(--space-4);
}

.subject-icon {
  border-color: #c9d2ec;
  color: var(--primary);
  background: var(--primary-soft);
}

.subject-count {
  margin: 2px 0 0;
  color: var(--muted);
  font-size: 12px;
}

.subject-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}

.subject-submit,
.subject-feedback {
  grid-column: 1 / -1;
}

.subject-directory {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border);
}

.subject-directory li {
  display: grid;
  grid-template-columns: minmax(120px, 0.55fr) minmax(0, 1fr);
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}

.subject-directory strong,
.subject-directory code {
  min-width: 0;
  overflow-wrap: anywhere;
}

.subject-directory code {
  color: var(--muted);
  font-size: 12px;
}

.chapter-manager {
  display: grid;
  gap: var(--space-3);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
}

.chapter-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
  align-items: end;
  gap: var(--space-3);
}

.chapter-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--border);
}

.chapter-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--border);
}

.chapter-list li > span {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  overflow-wrap: anywhere;
}

.chapter-list small {
  flex: none;
  color: var(--muted);
}

.chapter-toggle {
  flex: none;
  min-height: 32px;
  padding: 4px 10px;
}

.subject-retry {
  margin-left: auto;
}

.section-header,
.section-heading {
  display: flex;
  align-items: center;
}

.section-header {
  min-height: 36px;
  justify-content: space-between;
  gap: var(--space-3);
}

.section-heading {
  min-width: 0;
  gap: var(--space-3);
}

.section-icon {
  width: 36px;
  height: 36px;
  flex: none;
  display: inline-grid;
  place-items: center;
  border: 1px solid #b3dade;
  border-radius: var(--radius-s);
  color: var(--accent-dark);
  background: var(--accent-soft);
}

.section-title {
  margin: 0;
  font-size: 17px;
}

.section-meta {
  flex: none;
  color: var(--muted);
  font-size: 12px;
}

.quiz-form {
  display: grid;
  gap: var(--space-4);
}

.auto-create-option {
  min-height: 36px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink-soft);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.auto-create-option input {
  width: 18px;
  height: 18px;
  flex: none;
  accent-color: var(--accent);
}

.mode-fieldset {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  border: 0;
}

.mode-option {
  min-width: 0;
  min-height: 72px;
  display: grid;
  align-content: center;
  justify-items: center;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  color: var(--ink-soft);
  background: var(--surface-tint);
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
  cursor: pointer;
  transition:
    border-color 0.16s var(--ease-out),
    color 0.16s var(--ease-out),
    background 0.16s var(--ease-out),
    box-shadow 0.16s var(--ease-out);
}

.mode-option:hover {
  border-color: var(--border-strong);
  color: var(--primary);
}

.mode-option.active {
  border-color: #9bcbd0;
  color: var(--accent-dark);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px rgba(15, 138, 150, 0.08);
}

.mode-option:has(input:disabled),
.file-picker.disabled {
  opacity: 0.58;
  cursor: not-allowed;
}

.mode-option:has(input:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.field-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(96px, 0.42fr);
  gap: var(--space-4);
}

.field-row .field {
  min-width: 0;
}

.field-label {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--ink-soft);
}

.file-picker {
  min-height: 76px;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-s);
  color: var(--muted);
  background: var(--surface-tint);
  cursor: pointer;
  transition:
    border-color 0.16s var(--ease-out),
    color 0.16s var(--ease-out),
    background 0.16s var(--ease-out);
}

.file-picker:hover,
.file-picker.selected {
  border-color: var(--accent);
  color: var(--accent-dark);
  background: var(--accent-soft);
}

.file-field:has(input:focus-visible) .file-picker {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.file-picker-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.file-picker-copy strong,
.file-picker-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-picker-copy strong {
  color: var(--ink-soft);
  font-size: 13px;
}

.file-picker-copy small {
  color: var(--muted);
  font-size: 12px;
}

.csv-guide {
  border-top: 1px solid var(--border);
  padding-top: var(--space-3);
}

.csv-guide summary {
  width: fit-content;
  color: var(--accent-dark);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.csv-guide .field-hint {
  margin-top: var(--space-2);
  overflow-wrap: anywhere;
}

.quiz-form > .button {
  width: 100%;
}

@media (min-width: 981px) {
  .quiz-side {
    position: sticky;
    top: calc(var(--header-height) + var(--space-5));
  }
}

@media (max-width: 980px) {
  .quiz-admin {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .quiz-section {
    padding: var(--space-4);
  }

  .mode-fieldset,
  .field-row,
  .subject-form,
  .chapter-form {
    grid-template-columns: 1fr;
  }

  .mode-option {
    min-height: 48px;
    grid-template-columns: 20px 1fr;
    justify-items: start;
    text-align: left;
  }

  .subject-directory li {
    grid-template-columns: 1fr;
    gap: var(--space-1);
  }
}
</style>
