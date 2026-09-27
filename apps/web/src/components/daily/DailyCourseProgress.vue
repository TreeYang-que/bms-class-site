<script setup lang="ts">
import { computed } from 'vue';
import { CalendarDays } from 'lucide-vue-next';
import StatusBadge from '../common/StatusBadge.vue';
import type { PracticeCourseView } from '../../types';

const props = defineProps<{ courses: PracticeCourseView[]; practiceDate: string }>();
const statusLabels = { UPCOMING: '尚未开课', ACTIVE: '学习中', COMPLETED: '课程已结束', PAUSED: '已暂停' };
const summaries = computed(() => props.courses.map((course) => {
  const learned = course.topics.filter((topic) => topic.learned && !topic.paused);
  const recent = [...learned].sort((a, b) => b.availableOn.localeCompare(a.availableOn)).slice(0, 3);
  const upcoming = course.topics.filter((topic) => !topic.learned && !topic.paused)
    .sort((a, b) => a.availableOn.localeCompare(b.availableOn))[0];
  const daysToExam = Math.ceil((Date.parse(course.examDate + 'T00:00:00+08:00') - Date.parse(props.practiceDate + 'T00:00:00+08:00')) / 86_400_000);
  return { course, learned, recent, upcoming, daysToExam };
}));
</script>

<template>
  <section class="course-progress" aria-labelledby="daily-course-title">
    <header><p class="section-kicker">按教学进度选题</p><h2 id="daily-course-title">当前学习范围</h2></header>
    <div class="course-grid">
      <article v-for="{ course, learned, recent, upcoming, daysToExam } in summaries" :key="course.id">
        <div class="course-heading"><h3>{{ course.subject.name }}</h3><StatusBadge :text="statusLabels[course.status]" :tone="course.status === 'ACTIVE' ? 'accent' : 'muted'" /></div>
        <p class="course-meta"><CalendarDays :size="15" aria-hidden="true" />考试 {{ course.examDate }}<span v-if="course.status === 'ACTIVE' && daysToExam >= 0 && daysToExam <= 14"> · {{ daysToExam === 0 ? '今日考试' : `考前 ${daysToExam} 天` }}</span></p>
        <div class="progress-track" role="progressbar" :aria-label="course.subject.name + '教学进度'" :aria-valuenow="learned.length" :aria-valuemax="course.topics.length" :aria-valuemin="0"><span :style="{ width: `${course.topics.length ? learned.length / course.topics.length * 100 : 0}%` }" /></div>
        <p class="scope-count">{{ learned.length }} / {{ course.topics.length }} 个主题已学</p>
        <p v-if="recent.length" class="topic-copy">近期已学：{{ recent.map((topic) => topic.title).join('、') }}</p>
        <p v-if="upcoming && course.status === 'ACTIVE'" class="next-topic">下一主题：{{ upcoming.title }}（{{ upcoming.availableOn }} 起可练习）</p>
        <p v-if="course.status === 'COMPLETED'" class="next-topic">该课程已停止生成新练习，历史记录仍可查看。</p>
        <p v-else-if="course.status === 'PAUSED'" class="next-topic">课程暂时暂停选题。</p>
      </article>
    </div>
  </section>
</template>

<style scoped>
.course-progress { display: grid; gap: var(--space-4); }
.section-kicker, h2, h3, p { margin: 0; }
.section-kicker { font-size: 12px; color: var(--accent-dark); }
h2 { margin-top: 4px; font-size: 22px; }
.course-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
article { min-width: 0; display: grid; align-content: start; gap: var(--space-3); padding: var(--space-5); border: 1px solid var(--border); border-radius: var(--radius-m); }
.course-heading, .course-meta { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.course-heading { justify-content: space-between; }
h3 { font-size: 16px; }
.course-meta, .scope-count, .next-topic { font-size: 12px; line-height: 1.6; color: var(--muted); }
.topic-copy { font-size: 13px; color: var(--ink-soft); line-height: 1.7; }
.progress-track { height: 6px; overflow: hidden; border-radius: var(--radius-pill); background: var(--surface-muted); }
.progress-track span { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
@media (max-width: 700px) { .course-grid { grid-template-columns: 1fr; } }
</style>
