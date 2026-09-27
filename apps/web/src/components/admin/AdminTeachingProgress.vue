<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { CalendarDays, History, RefreshCw, Save } from 'lucide-vue-next';
import EmptyState from '../common/EmptyState.vue';
import ErrorState from '../common/ErrorState.vue';
import SkeletonBlock from '../common/SkeletonBlock.vue';
import StatusBadge from '../common/StatusBadge.vue';
import { useAuthStore } from '../../stores/auth';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useToast } from '../../composables/useToast';
import { formatError } from '../../lib/api';
import { formatDateTime } from '../../lib/formatters';
import { getPracticeCurriculum, getPracticeCourseHistory, initializePracticeCurriculum, updatePracticeCourse, type PracticeCourseHistoryEntry } from '../../lib/dailyPractice';
import type { PracticeCourseTopic, PracticeCourseView } from '../../types';

const auth = useAuthStore();
const toast = useToast();
const requests = useLatestRequest();
const historyRequests = useLatestRequest();
const courses = ref<PracticeCourseView[]>([]);
const initialized = ref(false);
const practiceDate = ref('');
const selectedId = ref('');
const error = ref('');
const busy = ref(false);
const examDate = ref('');
const enabled = ref(true);
const topics = ref<PracticeCourseTopic[]>([]);
const reason = ref('');
const history = ref<PracticeCourseHistoryEntry[]>([]);
const historyOpen = ref(false);
const historyError = ref('');
const course = computed(() => courses.value.find((item) => item.id === selectedId.value));
const statusLabels = { UPCOMING: '尚未开课', ACTIVE: '学习中', COMPLETED: '课程已结束', PAUSED: '已暂停' };

function selectCourse(id: string) {
  selectedId.value = id;
  const value = courses.value.find((item) => item.id === id);
  examDate.value = value?.examDate ?? '';
  enabled.value = value?.enabled ?? true;
  topics.value = value?.topics.map(({ id: topicId, title, sessionDates, sourceRefs, paused, taughtOnOverride }) => ({
    id: topicId, title, sessionDates: [...sessionDates], sourceRefs: [...sourceRefs], paused, taughtOnOverride,
  })) ?? [];
  reason.value = '';
  historyRequests.cancelLatest();
  history.value = [];
  historyOpen.value = false;
  historyError.value = '';
}

async function load() {
  error.value = '';
  await requests.runLatest(({ signal }) => getPracticeCurriculum({ signal }), {
    commit(result) {
      courses.value = result.courses;
      initialized.value = result.initialized;
      practiceDate.value = result.practiceDate;
      selectCourse(result.courses.some((item) => item.id === selectedId.value) ? selectedId.value : result.courses[0]?.id ?? '');
    },
    onError(caught) { error.value = formatError(caught, '课程进度加载失败'); },
  });
}

async function initialize() {
  busy.value = true;
  error.value = '';
  try {
    await initializePracticeCurriculum();
    await load();
    toast.success('两门课程的教学进度已初始化');
  } catch (caught) { error.value = formatError(caught, '教学进度初始化失败'); }
  finally { busy.value = false; }
}

async function save() {
  if (!course.value || !reason.value.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await updatePracticeCourse(course.value.id, {
      expectedRevision: course.value.revision, examDate: examDate.value,
      enabled: enabled.value, topics: topics.value, reason: reason.value.trim(),
    });
    await load();
    toast.success('课程进度已更新，修改已记入历史');
  } catch (caught) { error.value = formatError(caught, '保存失败，请检查是否已有新的修订'); }
  finally { busy.value = false; }
}

async function loadHistory() {
  if (!course.value) return;
  const id = course.value.id;
  historyOpen.value = true;
  historyError.value = '';
  await historyRequests.runLatest(({ signal }) => getPracticeCourseHistory(id, { signal }), {
    commit(result) { if (selectedId.value === id) history.value = result.items; },
    onError(caught) { historyError.value = formatError(caught, '修订历史加载失败'); },
  });
}

function effectiveDate(topic: PracticeCourseTopic) {
  return topic.taughtOnOverride || [...topic.sessionDates].sort().at(-1) || '';
}

function availableDate(topic: PracticeCourseTopic) {
  const value = effectiveDate(topic);
  if (!value) return '待安排';
  const next = new Date(value + 'T00:00:00+08:00');
  next.setUTCDate(next.getUTCDate() + 1);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(next);
}

onMounted(() => void load());
</script>

<template>
  <section class="teaching-section" aria-labelledby="teaching-title">
    <header class="section-heading">
      <div>
        <p class="section-kicker">{{ course?.termKey ?? '课程学期' }}</p>
        <h3 id="teaching-title">课程与教学进度</h3>
        <p class="muted-note">同一主题最后一次理论课结束的次日进入练习，考试次日起停止该课程的新计划。</p>
      </div>
      <button type="button" class="icon-button" aria-label="刷新教学进度" :disabled="requests.loading.value || busy" @click="load"><RefreshCw :size="17" aria-hidden="true" /></button>
    </header>
    <SkeletonBlock v-if="requests.loading.value && !courses.length" :lines="5" />
    <ErrorState v-if="error" :message="error" @retry="load" />
    <div v-if="!requests.loading.value && !initialized && !error" class="initialization-panel">
      <EmptyState title="尚未建立本学期课程进度" hint="将载入医学分子细胞遗传基础、人体形态与功能总论的理论课安排，并与已有题库学科关联。" />
      <button v-if="auth.isAdmin" type="button" class="button" :disabled="busy" @click="initialize">{{ busy ? '正在初始化…' : '初始化两门课程' }}</button>
      <p v-else class="muted-note">请管理员完成一次初始化。</p>
    </div>
    <template v-if="courses.length">
      <div class="course-selector" aria-label="课程选择">
        <button v-for="item in courses" :key="item.id" type="button" :class="{ selected: selectedId === item.id }" :aria-pressed="selectedId === item.id" :disabled="busy" @click="selectCourse(item.id)">
          <CalendarDays :size="18" aria-hidden="true" />
          <span><strong>{{ item.subject.name }}</strong><small>{{ statusLabels[item.status] }} · {{ item.topics.filter((topic) => topic.learned).length }} / {{ item.topics.length }} 个主题已学</small></span>
        </button>
      </div>
      <form v-if="course" class="course-form" @submit.prevent="save">
        <div class="course-meta"><span>练习日 {{ practiceDate }}</span><span>修订 {{ course.revision }}</span><span>已学范围可用 {{ course.eligibleQuestionCount }} 题</span></div>
        <div class="course-settings">
          <div class="field"><label for="course-exam-date">考试日期</label><input id="course-exam-date" v-model="examDate" type="date" :min="course.startDate" required :disabled="busy" /></div>
          <label class="checkbox-label"><input v-model="enabled" type="checkbox" :disabled="busy" />启用本课程</label>
          <button type="button" class="button ghost" :disabled="busy" @click="loadHistory"><History :size="16" aria-hidden="true" />修订历史</button>
        </div>
        <ol class="topic-timeline">
          <li v-for="topic in topics" :key="topic.id" :class="{ paused: topic.paused }">
            <div class="topic-copy">
              <strong>{{ topic.title }}</strong>
              <small>课表 {{ topic.sessionDates.join('、') }}</small>
              <span class="topic-state"><StatusBadge :text="topic.paused ? '暂停' : availableDate(topic) <= practiceDate ? '已学' : '待学'" :tone="topic.paused ? 'warning' : availableDate(topic) <= practiceDate ? 'success' : 'muted'" />{{ availableDate(topic) }} 起可练习</span>
            </div>
            <div class="topic-controls">
              <div class="field"><label :for="'topic-date-' + topic.id">最后授课日修正</label><input :id="'topic-date-' + topic.id" :value="topic.taughtOnOverride ?? ''" type="date" :disabled="busy" @input="topic.taughtOnOverride = ($event.target as HTMLInputElement).value || null" /></div>
              <label class="checkbox-label"><input v-model="topic.paused" type="checkbox" :disabled="busy" />暂停主题</label>
            </div>
          </li>
        </ol>
        <div class="field"><label for="course-change-reason">修改原因</label><textarea id="course-change-reason" v-model="reason" maxlength="500" rows="2" required :disabled="busy" placeholder="例如：本周课程调整，授课延后" /></div>
        <div class="form-actions"><p class="muted-note">留空授课日修正可恢复原课表安排。已完成的练习保留原始记录。</p><button type="submit" class="button" :disabled="busy || !reason.trim()"><Save :size="16" aria-hidden="true" />{{ busy ? '正在保存…' : '保存课程修订' }}</button></div>
      </form>
      <section v-if="historyOpen" class="revision-history" aria-label="课程修订历史">
        <h4>修订历史</h4>
        <SkeletonBlock v-if="historyRequests.loading.value" :lines="3" />
        <ErrorState v-else-if="historyError" :message="historyError" @retry="loadHistory" />
        <EmptyState v-else-if="!history.length" title="暂无修订记录" />
        <details v-for="entry in history" :key="entry.id"><summary>修订 {{ entry.revision }} · {{ formatDateTime(entry.createdAt) }} · {{ entry.reason }}</summary><p>考试日期 {{ entry.snapshot.examDate }} · {{ entry.snapshot.enabled ? '启用' : '暂停' }}</p><ul><li v-for="topic in entry.snapshot.topics" :key="topic.id">{{ topic.title }}：{{ effectiveDate(topic) }}{{ topic.paused ? '（暂停）' : '' }}</li></ul></details>
      </section>
    </template>
  </section>
</template>

<style scoped>
.teaching-section, .course-form, .revision-history { display: grid; gap: var(--space-4); min-width: 0; }
.section-heading, .form-actions, .course-settings { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
.section-heading h3, .section-kicker, .revision-history h4 { margin: 0; }
.section-heading h3 { margin-top: 4px; font-size: 21px; }
.section-kicker { color: var(--accent-dark); font-size: 12px; }
.muted-note, .course-meta { color: var(--muted); font-size: 13px; line-height: 1.65; }
.course-selector { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
.course-selector button { display: flex; align-items: center; gap: var(--space-3); min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-m); background: var(--surface); color: var(--ink); padding: var(--space-4); font: inherit; text-align: left; cursor: pointer; }
.course-selector button.selected { border-color: var(--accent); background: var(--accent-soft); }
.course-selector span { display: grid; gap: 6px; }
.course-selector small { color: var(--muted); }
.course-meta { display: flex; flex-wrap: wrap; gap: var(--space-4); }
.course-settings { justify-content: flex-start; padding: var(--space-3) 0; }
.course-settings .field { min-width: 180px; }
.checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 13px; white-space: nowrap; }
.checkbox-label input { width: 17px; height: 17px; accent-color: var(--accent); }
.topic-timeline { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--border); }
.topic-timeline > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-4); padding: var(--space-4) 0; border-bottom: 1px solid var(--border); }
.topic-copy { display: grid; gap: 7px; min-width: 0; overflow-wrap: anywhere; }
.topic-copy small { color: var(--muted); }
.topic-state { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--ink-soft); }
.topic-controls { display: flex; align-items: center; gap: var(--space-3); }
.topic-controls .field { width: 160px; }
.paused .topic-copy strong { color: var(--muted); }
.initialization-panel { display: grid; justify-items: start; gap: var(--space-3); }
.revision-history { padding-top: var(--space-4); border-top: 1px solid var(--border); }
.revision-history summary { cursor: pointer; font-size: 13px; line-height: 1.8; }
.revision-history li { font-size: 13px; line-height: 1.8; }
@media (max-width: 700px) { .course-selector { grid-template-columns: 1fr; } .topic-timeline > li { grid-template-columns: 1fr; } .topic-controls { justify-content: space-between; } }
@media (max-width: 560px) { .form-actions .button { width: 100%; } .course-settings { align-items: flex-end; } }
</style>
