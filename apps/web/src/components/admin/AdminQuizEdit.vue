<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Plus, Save, X } from 'lucide-vue-next';
import { api, formatError } from '../../lib/api';
import { questionTypeLabels } from '../../lib/labels';
import QuizChapterSelect from '../quiz/QuizChapterSelect.vue';
import AdminQuizImages from './AdminQuizImages.vue';
import type {
  GradingRubric,
  KnowledgeSubject,
  QuestionType,
  QuizQuestionEditorData,
  QuizQuestionWriteRequest,
  SubjectChapter,
} from '../../types';

interface OptionRow {
  id: string;
  text: string;
}

interface CriterionRow {
  description: string;
  points: number | null;
}

const props = defineProps<{ question: QuizQuestionEditorData }>();
const emit = defineEmits<{
  saved: [question: QuizQuestionEditorData];
  cancel: [];
}>();

const gradingTypes: QuestionType[] = [
  'SINGLE',
  'MULTIPLE',
  'TRUE_FALSE',
  'SHORT_ANSWER',
];
const gradingType = ref<QuestionType>(props.question.gradingType);
const typeLabel = ref(props.question.typeLabel);
const subjectId = ref(props.question.subjectId);
const chapterIds = ref([...props.question.chapterIds]);
const category = ref(props.question.category);
const prompt = ref(props.question.prompt);
const explanation = ref(props.question.explanation);
const options = ref<OptionRow[]>(props.question.options.map((option) => ({ ...option })));
const correctAnswer = ref([...props.question.correctAnswer]);
const referenceAnswers = ref(
  props.question.gradingType === 'SHORT_ANSWER'
    ? props.question.correctAnswer.join('\n')
    : '',
);
const criteria = ref<CriterionRow[]>(
  props.question.gradingRubric?.criteria.length
    ? props.question.gradingRubric.criteria.map((criterion) => ({ ...criterion }))
    : [{ description: '', points: null }],
);
const rubricNotes = ref(props.question.gradingRubric?.notes ?? '');
const subjects = ref<KnowledgeSubject[]>([]);
const chapters = ref<SubjectChapter[]>([]);
const loadingDirectory = ref(false);
const directoryError = ref('');
const busy = ref(false);
const imageBusy = ref(false);
const error = ref('');
let initialSubject = true;

const isShortAnswer = computed(() => gradingType.value === 'SHORT_ANSWER');
const chapterOptions = computed(() =>
  chapters.value.map((chapter) => ({
    id: chapter.id,
    label: chapter.name,
  })),
);

function defaultOptions(type: QuestionType): OptionRow[] {
  if (type === 'TRUE_FALSE') {
    return [
      { id: 'A', text: '正确' },
      { id: 'B', text: '错误' },
    ];
  }
  return [
    { id: 'A', text: '' },
    { id: 'B', text: '' },
    { id: 'C', text: '' },
    { id: 'D', text: '' },
  ];
}

watch(gradingType, (next, previous) => {
  if (next === 'SHORT_ANSWER') {
    referenceAnswers.value = correctAnswer.value.join('\n');
    return;
  }
  if (previous === 'SHORT_ANSWER' || next === 'TRUE_FALSE') {
    options.value = defaultOptions(next);
    correctAnswer.value = [];
  } else if (previous === 'TRUE_FALSE') {
    options.value = defaultOptions(next);
    correctAnswer.value = [];
  }
  if (typeLabel.value === questionTypeLabels[previous]) {
    typeLabel.value = questionTypeLabels[next];
  }
});

watch(subjectId, async (next) => {
  const keepExisting = initialSubject && next === props.question.subjectId;
  initialSubject = false;
  if (!keepExisting) chapterIds.value = [];
  chapters.value = [];
  directoryError.value = '';
  if (!next) return;
  loadingDirectory.value = true;
  try {
    chapters.value = await api<SubjectChapter[]>(`/subjects/${next}/chapters`);
    chapterIds.value = chapterIds.value.filter((id) =>
      chapters.value.some((chapter) => chapter.id === id),
    );
  } catch (caught) {
    directoryError.value = formatError(caught, '章节目录加载失败');
  } finally {
    loadingDirectory.value = false;
  }
}, { immediate: true });

onMounted(async () => {
  loadingDirectory.value = true;
  try {
    subjects.value = await api<KnowledgeSubject[]>('/subjects');
  } catch (caught) {
    directoryError.value = formatError(caught, '学科目录加载失败');
  } finally {
    loadingDirectory.value = false;
  }
});

function nextOptionId() {
  const used = new Set(options.value.map((option) => option.id));
  for (let index = 0; index < 26; index += 1) {
    const id = String.fromCharCode(65 + index);
    if (!used.has(id)) return id;
  }
  return `O${options.value.length + 1}`;
}

function addOption() {
  options.value = [...options.value, { id: nextOptionId(), text: '' }];
}

function removeOption(id: string) {
  options.value = options.value.filter((option) => option.id !== id);
  correctAnswer.value = correctAnswer.value.filter((answer) => answer !== id);
}

function toggleAnswer(id: string, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  correctAnswer.value = gradingType.value === 'MULTIPLE'
    ? checked
      ? [...correctAnswer.value, id]
      : correctAnswer.value.filter((answer) => answer !== id)
    : checked
      ? [id]
      : [];
}

function addCriterion() {
  criteria.value = [...criteria.value, { description: '', points: null }];
}

function removeCriterion(index: number) {
  criteria.value = criteria.value.filter((_, itemIndex) => itemIndex !== index);
}

function validationError() {
  if (!subjectId.value) return '请选择学科';
  if (!chapterIds.value.length) return '请至少选择一个章节';
  if (!typeLabel.value.trim()) return '请输入显示题型标签';
  if (prompt.value.trim().length < 2) return '题干至少需要 2 个字符';
  if (isShortAnswer.value) {
    if (!referenceAnswers.value.split('\n').some((line) => line.trim())) {
      return '简答题至少需要一个参考答案';
    }
    const validCriteria = criteria.value.filter(
      (criterion) => criterion.description.trim() && criterion.points,
    );
    if (!validCriteria.length) return '简答题至少需要一个有效评分点';
    if (
      validCriteria.some(
        (criterion) =>
          !Number.isInteger(criterion.points) || (criterion.points ?? 0) < 1,
      )
    ) {
      return '评分点分值必须是大于 0 的整数';
    }
    return '';
  }
  if (options.value.length < 2) return '至少需要两个选项';
  if (options.value.some((option) => !option.text.trim())) return '选项内容不能为空';
  if (!correctAnswer.value.length) return '请选择正确答案';
  if (gradingType.value !== 'MULTIPLE' && correctAnswer.value.length !== 1) {
    return '单选题和判断题只能有一个正确答案';
  }
  return '';
}

function payload(): QuizQuestionWriteRequest {
  const body: QuizQuestionWriteRequest = {
    gradingType: gradingType.value,
    typeLabel: typeLabel.value.trim(),
    subjectId: subjectId.value,
    chapterIds: [...chapterIds.value],
    category: category.value,
    prompt: prompt.value.trim(),
    options: isShortAnswer.value
      ? []
      : options.value.map((option) => ({
          id: option.id,
          text: option.text.trim(),
        })),
    correctAnswer: isShortAnswer.value
      ? referenceAnswers.value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : [...correctAnswer.value],
    explanation: explanation.value.trim(),
  };
  if (isShortAnswer.value) {
    const gradingRubric: GradingRubric = {
      criteria: criteria.value
        .filter((criterion) => criterion.description.trim())
        .map((criterion) => ({
          description: criterion.description.trim(),
          points: criterion.points ?? 0,
        })),
    };
    if (rubricNotes.value.trim()) gradingRubric.notes = rubricNotes.value.trim();
    body.gradingRubric = gradingRubric;
  }
  return body;
}

async function submit() {
  if (imageBusy.value) return;
  error.value = validationError();
  if (error.value || busy.value) return;
  busy.value = true;
  try {
    const updated = await api<QuizQuestionEditorData>(
      `/quizzes/questions/${props.question.id}`,
      { method: 'PATCH', body: JSON.stringify(payload()) },
    );
    emit('saved', updated);
  } catch (caught) {
    error.value = formatError(caught, '题目更新失败');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="edit-form" aria-label="编辑题目" @submit.prevent="submit">
    <header class="edit-heading">
      <div>
        <h4>编辑题目</h4>
        <p>修改会影响后续练习，既有答题快照保持不变。</p>
      </div>
      <button type="button" class="icon-button" title="关闭编辑" aria-label="关闭编辑" :disabled="imageBusy || busy" @click="emit('cancel')">
        <X :size="16" aria-hidden="true" />
      </button>
    </header>

    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
    <p v-if="directoryError" class="alert error" role="alert">{{ directoryError }}</p>

    <div class="edit-grid">
      <div class="field">
        <label :for="`edit-grading-${question.id}`">判分类型</label>
        <select :id="`edit-grading-${question.id}`" v-model="gradingType" :disabled="busy">
          <option v-for="type in gradingTypes" :key="type" :value="type">{{ questionTypeLabels[type] }}</option>
        </select>
      </div>
      <div class="field">
        <label :for="`edit-label-${question.id}`">显示题型标签</label>
        <input :id="`edit-label-${question.id}`" v-model="typeLabel" maxlength="100" :disabled="busy" />
      </div>
      <div class="field">
        <label :for="`edit-subject-${question.id}`">学科</label>
        <select :id="`edit-subject-${question.id}`" v-model="subjectId" :disabled="busy || loadingDirectory">
          <option v-for="subject in subjects" :key="subject.id" :value="subject.id">{{ subject.name }}</option>
        </select>
      </div>
      <div class="field">
        <label :for="`edit-category-${question.id}`">分类</label>
        <select :id="`edit-category-${question.id}`" v-model="category" :disabled="busy">
          <option value="STANDARD">标准题</option>
          <option value="KNOWLEDGE_RECALL">知识背诵题</option>
        </select>
      </div>
    </div>

    <div class="field chapter-field">
      <label :for="`edit-chapters-${question.id}`">章节（可多选）</label>
      <QuizChapterSelect
        :id="`edit-chapters-${question.id}`"
        v-model="chapterIds"
        :options="chapterOptions"
        :disabled="busy || loadingDirectory || !subjectId || !chapters.length"
        :placeholder="
          loadingDirectory
            ? '正在加载目录…'
            : chapters.length
              ? '请选择章节'
              : '该学科暂无启用章节'
        "
        :show-match="false"
      />
    </div>

    <div class="field">
      <label :for="`edit-prompt-${question.id}`">题干</label>
      <textarea :id="`edit-prompt-${question.id}`" v-model="prompt" rows="4" maxlength="10000" :disabled="busy"></textarea>
    </div>

    <fieldset v-if="!isShortAnswer" class="answer-editor">
      <legend>选项与正确答案</legend>
      <div v-for="option in options" :key="option.id" class="option-row">
        <input
          :type="gradingType === 'MULTIPLE' ? 'checkbox' : 'radio'"
          :name="`edit-answer-${question.id}`"
          :checked="correctAnswer.includes(option.id)"
          :aria-label="`选项 ${option.id} 为正确答案`"
          :disabled="busy"
          @change="toggleAnswer(option.id, $event)"
        />
        <span>{{ option.id }}</span>
        <input v-model="option.text" :aria-label="`选项 ${option.id} 内容`" maxlength="2000" :disabled="busy" />
        <button type="button" class="icon-button" :aria-label="`删除选项 ${option.id}`" :disabled="busy || options.length <= 2" @click="removeOption(option.id)">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>
      <button type="button" class="button ghost compact-button" :disabled="busy" @click="addOption">
        <Plus :size="14" aria-hidden="true" />
        添加选项
      </button>
    </fieldset>

    <template v-else>
      <div class="field">
        <label :for="`edit-reference-${question.id}`">参考答案（每行一个）</label>
        <textarea :id="`edit-reference-${question.id}`" v-model="referenceAnswers" rows="3" :disabled="busy"></textarea>
      </div>
      <fieldset class="answer-editor">
        <legend>评分标准</legend>
        <div v-for="(criterion, index) in criteria" :key="index" class="criterion-row">
          <input v-model="criterion.description" :aria-label="`评分点 ${index + 1} 描述`" maxlength="1000" :disabled="busy" />
          <input v-model.number="criterion.points" type="number" min="1" max="100" :aria-label="`评分点 ${index + 1} 分值`" :disabled="busy" />
          <button type="button" class="icon-button" :aria-label="`删除评分点 ${index + 1}`" :disabled="busy || criteria.length <= 1" @click="removeCriterion(index)">
            <X :size="14" aria-hidden="true" />
          </button>
        </div>
        <button type="button" class="button ghost compact-button" :disabled="busy" @click="addCriterion">
          <Plus :size="14" aria-hidden="true" />
          添加评分点
        </button>
        <div class="field">
          <label :for="`edit-rubric-notes-${question.id}`">评分备注（可选）</label>
          <input :id="`edit-rubric-notes-${question.id}`" v-model="rubricNotes" maxlength="2000" :disabled="busy" />
        </div>
      </fieldset>
    </template>

    <div class="field">
      <label :for="`edit-explanation-${question.id}`">解析（可选）</label>
      <textarea :id="`edit-explanation-${question.id}`" v-model="explanation" rows="3" maxlength="10000" :disabled="busy"></textarea>
    </div>

    <AdminQuizImages :key="question.id" :question-id="question.id" :images="question.images ?? []" @busy="imageBusy = $event" />

    <footer class="edit-actions">
      <button type="button" class="button ghost" :disabled="busy || imageBusy" @click="emit('cancel')">取消</button>
      <button type="submit" class="button" :disabled="busy || imageBusy || loadingDirectory">
        <Save :size="15" aria-hidden="true" />
        {{ busy ? '正在保存…' : '保存修改' }}
      </button>
    </footer>
  </form>
</template>

<style scoped>
.edit-form {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-s);
  background: var(--surface-tint);
}

.edit-heading,
.edit-actions,
.option-row,
.criterion-row {
  display: flex;
  align-items: center;
}

.edit-heading {
  justify-content: space-between;
  gap: var(--space-3);
}

.edit-heading h4,
.edit-heading p {
  margin: 0;
}

.edit-heading h4 {
  font-size: 15px;
}

.edit-heading p {
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
}

.edit-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-3);
}

.edit-grid .field {
  min-width: 0;
}

.answer-editor {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-3);
  margin: 0;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
}

.answer-editor legend {
  padding: 0 var(--space-1);
  color: var(--ink-soft);
  font-size: 13px;
  font-weight: 600;
}

.option-row > input:first-child {
  accent-color: var(--accent);
}

.answer-editor {
  display: grid;
}

.option-row,
.criterion-row {
  gap: var(--space-2);
}

.option-row > input:nth-of-type(2),
.criterion-row > input:first-child {
  min-width: 0;
  flex: 1;
}

.criterion-row > input[type='number'] {
  width: 84px;
  flex: none;
}

.compact-button {
  width: fit-content;
  min-height: 32px;
  padding: 4px 10px;
}

.edit-actions {
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}

@media (max-width: 900px) {
  .edit-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .edit-grid {
    grid-template-columns: 1fr;
  }

  .option-row,
  .criterion-row {
    align-items: stretch;
    flex-wrap: wrap;
  }

  .option-row > input:nth-of-type(2),
  .criterion-row > input:first-child {
    flex-basis: calc(100% - 72px);
  }

  .edit-actions .button {
    flex: 1;
  }
}
</style>
