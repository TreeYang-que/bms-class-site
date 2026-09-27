<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RefreshCw, Save } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import PaginationControl from '../common/PaginationControl.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import BaseDialog from '../common/BaseDialog.vue';
import QuizQuestionImages from '../quiz/QuizQuestionImages.vue';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useToast } from '../../composables/useToast';
import { api, formatError } from '../../lib/api';
import { optionTexts } from '../../lib/quiz';
import { getPracticeCurriculum, getQuestionMappings, queueCourseQuestionMappings, retryQuestionMapping, updateQuestionMapping } from '../../lib/dailyPractice';
import type { PracticeCourseView, PracticeQuestionMappingView, QuizQuestionEditorData } from '../../types';

const toast = useToast();
const requests = useLatestRequest();
const courses = ref<PracticeCourseView[]>([]);
const courseId = ref('');
const status = ref('NEEDS_REVIEW');
const items = ref<PracticeQuestionMappingView[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const error = ref('');
const busy = ref(false);
const selected = ref<PracticeQuestionMappingView | null>(null);
const selectedTopics = ref<string[]>([]);
const detailRequests = useLatestRequest();
const questionDetail = ref<QuizQuestionEditorData | null>(null);
const detailError = ref('');
const topicSearch = ref('');
const reason = ref('');
const course = computed(() => courses.value.find((item) => item.id === courseId.value));
const filteredTopics = computed(() => course.value?.topics.filter((topic) => topic.title.toLocaleLowerCase().includes(topicSearch.value.trim().toLocaleLowerCase())) ?? []);
const statusLabels: Record<string, string> = { PENDING: '待匹配', PROCESSING: '正在匹配', READY: '已匹配', NEEDS_REVIEW: '需人工处理', STALE: '需重新匹配' };

async function loadCourses() {
  error.value = '';
  try {
    const result = await getPracticeCurriculum();
    courses.value = result.courses;
    if (!result.courses.some((item) => item.id === courseId.value)) courseId.value = result.courses[0]?.id ?? '';
    else await load();
  } catch (caught) { error.value = formatError(caught, '课程加载失败'); }
}

async function load(nextPage = page.value) {
  if (!courseId.value) return;
  error.value = '';
  selected.value = null;
  await requests.runLatest(({ signal }) => getQuestionMappings({ courseId: courseId.value, status: status.value || undefined, page: nextPage, pageSize }, { signal }), {
    commit(result) { items.value = result.items; total.value = result.total; page.value = result.page; },
    onError(caught) { error.value = formatError(caught, '题目匹配加载失败'); },
  });
}

async function edit(item: PracticeQuestionMappingView) {
  selected.value = item;
  selectedTopics.value = [...item.topicIds];
  reason.value = '';
  topicSearch.value = '';
  questionDetail.value = null;
  detailError.value = '';
  await detailRequests.runLatest(({ signal }) => api<QuizQuestionEditorData>(`/quizzes/questions/${encodeURIComponent(item.questionId)}`, { signal }), {
    commit(result) { questionDetail.value = result; },
    onError(caught) { detailError.value = formatError(caught, '完整题目加载失败'); },
  });
}

function closeEditor() {
  if (busy.value) return;
  detailRequests.cancelLatest();
  selected.value = null;
  questionDetail.value = null;
}

async function save() {
  const item = selected.value;
  if (!item || !questionDetail.value || !reason.value.trim() || !selectedTopics.value.length || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await updateQuestionMapping(item.questionId, { expectedRevision: item.revision, expectedContentRevision: questionDetail.value.contentRevision, topicIds: selectedTopics.value, reason: reason.value.trim() });
    toast.success('题目主题已校正');
    await loadCourses();
  } catch (caught) { error.value = formatError(caught, '校正失败，请刷新确认题目是否已变化'); }
  finally { busy.value = false; }
}

async function retry(item: PracticeQuestionMappingView) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await retryQuestionMapping(item.questionId, item.revision);
    toast.success('已加入重新匹配队列');
    await loadCourses();
  } catch (caught) { error.value = formatError(caught, '重试失败'); }
  finally { busy.value = false; }
}

async function queue() {
  if (!courseId.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await queueCourseQuestionMappings(courseId.value);
    toast.success('待处理题目已加入匹配队列');
    await loadCourses();
  } catch (caught) { error.value = formatError(caught, '匹配任务创建失败'); }
  finally { busy.value = false; }
}

watch([courseId, status], () => { page.value = 1; void load(1); });
onMounted(() => void loadCourses());
</script>

<template>
  <section class="mapping-section" aria-labelledby="mapping-title">
    <header class="mapping-heading"><div><p class="section-kicker">题库范围</p><h3 id="mapping-title">题目主题匹配</h3><p class="muted-note">AI 自动识别题目涉及的课程主题，正常匹配直接生效。只有全部主题已学的题目才进入每日一练。</p></div><button type="button" class="icon-button" aria-label="刷新题目匹配" :disabled="requests.loading.value || busy" @click="loadCourses"><RefreshCw :size="17" aria-hidden="true" /></button></header>
    <ErrorState v-if="error" :message="error" @retry="loadCourses" />
    <EmptyState v-if="!courses.length && !error" title="请先初始化课程进度" />
    <template v-if="courses.length">
      <div class="mapping-controls"><div class="field"><label for="mapping-course">课程</label><select id="mapping-course" v-model="courseId" :disabled="busy"><option v-for="item in courses" :key="item.id" :value="item.id">{{ item.subject.name }}</option></select></div><div class="field"><label for="mapping-status">匹配状态</label><select id="mapping-status" v-model="status" :disabled="busy"><option value="">全部状态</option><option v-for="(label, value) in statusLabels" :key="value" :value="value">{{ label }}</option></select></div><button type="button" class="button secondary" :disabled="busy || !courseId" @click="queue">{{ busy ? '处理中…' : '匹配待处理题目' }}</button></div>
      <div v-if="course" class="mapping-counts"><StatusBadge v-for="(count, key) in course.mappingCounts" :key="key" :text="statusLabels[key] + ' ' + count" :tone="key === 'NEEDS_REVIEW' || key === 'STALE' ? 'warning' : 'muted'" /></div>
      <SkeletonBlock v-if="requests.loading.value" :lines="5" />
      <EmptyState v-else-if="!items.length" title="该状态下暂无题目" />
      <ul v-else class="mapping-list"><li v-for="item in items" :key="item.questionId"><div class="mapping-copy"><div class="mapping-tags"><StatusBadge :text="item.stale ? '需重新匹配' : statusLabels[item.status] ?? item.status" :tone="!item.stale && item.status === 'READY' ? 'success' : 'warning'" /><StatusBadge v-if="item.manual" text="人工校正" /><span>{{ item.question.typeLabel }}</span></div><p class="question-prompt">{{ item.question.prompt }}</p><p class="muted-note">{{ item.topicIds.map((id) => course?.topics.find((topic) => topic.id === id)?.title ?? '已失效主题').join('、') || '尚未确定主题' }}</p><p v-if="item.reason" class="mapping-reason">{{ item.reason }}</p></div><div class="mapping-actions"><button type="button" class="button ghost" :disabled="busy" @click="edit(item)">校正主题</button><button type="button" class="button ghost" :disabled="busy || item.status === 'PROCESSING'" @click="retry(item)">重新匹配</button></div></li></ul>
      <PaginationControl :page="page" :page-count="Math.max(1, Math.ceil(total / pageSize))" @update:page="load" />
      <BaseDialog :open="selected !== null" title="校正题目主题" :width="920" :dismissable="!busy" @close="closeEditor">
        <SkeletonBlock v-if="detailRequests.loading.value" :lines="7" />
        <ErrorState v-else-if="detailError" :message="detailError" @retry="selected && edit(selected)" />
        <form v-else-if="selected && course && questionDetail" id="mapping-editor-form" class="mapping-editor" @submit.prevent="save">
          <section class="question-detail" aria-label="完整题目与答案">
            <StatusBadge :text="questionDetail.typeLabel" />
            <p class="question-prompt">{{ questionDetail.prompt }}</p>
            <QuizQuestionImages :images="questionDetail.images ?? []" :alt-context="questionDetail.prompt" />
            <ul v-if="questionDetail.options.length" class="question-options"><li v-for="option in questionDetail.options" :key="option.id">{{ option.id }}. {{ option.text }}</li></ul>
            <h4>正确答案</h4>
            <p class="answer-copy">{{ questionDetail.gradingType === 'SHORT_ANSWER' ? questionDetail.correctAnswer.join('\n') : optionTexts(questionDetail, questionDetail.correctAnswer).join('；') }}</p>
            <template v-if="questionDetail.gradingRubric"><h4>评分细则</h4><ul><li v-for="(criterion, index) in questionDetail.gradingRubric.criteria" :key="index">{{ criterion.description }}（{{ criterion.points }} 分）</li></ul><p v-if="questionDetail.gradingRubric.notes">{{ questionDetail.gradingRubric.notes }}</p></template>
            <h4>解析</h4><p class="answer-copy">{{ questionDetail.explanation || '暂无解析' }}</p>
          </section>
          <h4>匹配课程主题</h4>
          <p class="muted-note">请勾选解题必需的全部主题，包括尚未授课的主题。已选 {{ selectedTopics.length }} 项；搜索不会清除选择。</p>
          <div class="field"><label for="mapping-topic-search">搜索主题</label><input id="mapping-topic-search" v-model="topicSearch" type="search" placeholder="输入主题名称" :disabled="busy" /></div>
          <fieldset :disabled="busy"><legend class="sr-only">课程主题</legend><label v-for="topic in filteredTopics" :key="topic.id"><input v-model="selectedTopics" type="checkbox" :value="topic.id" /><span>{{ topic.title }}<small>{{ topic.paused ? '暂停' : topic.learned ? '已学' : topic.availableOn + ' 起可练习' }}</small></span></label></fieldset>
          <p v-if="!filteredTopics.length" class="muted-note">没有符合搜索条件的主题。</p>
          <div class="field"><label for="mapping-reason">校正原因</label><textarea id="mapping-reason" v-model="reason" rows="2" maxlength="500" required :disabled="busy" /></div>
          <p v-if="error" role="alert">{{ error }}</p>
        </form>
        <template #footer><button type="button" class="button ghost" :disabled="busy" @click="closeEditor">取消</button><button type="submit" form="mapping-editor-form" class="button" :disabled="busy || !questionDetail || !reason.trim() || !selectedTopics.length"><Save :size="16" aria-hidden="true" />保存校正</button></template>
      </BaseDialog>
    </template>
  </section>
</template>

<style scoped>
.mapping-section { display: grid; gap: var(--space-5); min-width: 0; }
.mapping-heading, .mapping-controls, .mapping-counts, .mapping-tags, .mapping-actions, .editor-actions { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
.mapping-heading { justify-content: space-between; align-items: flex-start; }
.mapping-heading h3, .section-kicker, .mapping-editor h4, .question-prompt { margin: 0; }
.mapping-heading h3 { margin-top: 4px; font-size: 21px; }
.section-kicker { font-size: 12px; color: var(--accent-dark); }
.muted-note, .mapping-reason, .mapping-tags { font-size: 13px; color: var(--muted); line-height: 1.6; }
.mapping-controls { align-items: flex-end; }
.mapping-controls .field { min-width: 170px; flex: 1; }
.mapping-list { list-style: none; padding: 0; margin: 0; }
.mapping-list > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-4); padding: var(--space-5) 0; border-bottom: 1px solid var(--border); }
.mapping-copy { display: grid; gap: var(--space-2); }
.mapping-copy p { margin: 0; }
.question-prompt { line-height: 1.7; overflow-wrap: anywhere; }
.mapping-actions { align-content: flex-start; }
.mapping-editor { display: grid; gap: var(--space-4); padding: 0; }
.mapping-editor fieldset { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); margin: 0; padding: 0; border: 0; }
.mapping-editor fieldset label { display: flex; align-items: flex-start; gap: 9px; font-size: 13px; }
.mapping-editor input[type=checkbox] { width: 17px; height: 17px; flex: none; accent-color: var(--accent); }
.mapping-editor fieldset span { display: grid; gap: 4px; }
.mapping-editor small { color: var(--muted); }
.question-detail { display: grid; gap: var(--space-3); padding-bottom: var(--space-4); border-bottom: 1px solid var(--border); }
.question-detail h4, .question-detail p, .question-detail ul { margin: 0; }
.answer-copy, .question-prompt { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.question-options { display: grid; gap: var(--space-2); list-style: none; padding-left: 0; }
.editor-actions { justify-content: flex-end; }
@media (max-width: 700px) { .mapping-list > li { grid-template-columns: 1fr; } .mapping-editor fieldset { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .mapping-controls { flex-direction: column; align-items: stretch; } .mapping-controls .field { width: 100%; } .mapping-editor { padding: var(--space-3); } }
</style>
