<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Activity, CalendarClock, ListChecks, Settings2, Users } from 'lucide-vue-next';
import AdminDailyCycles from './AdminDailyCycles.vue';
import AdminDailyFixedQuestions from './AdminDailyFixedQuestions.vue';
import AdminDailyRuntime from './AdminDailyRuntime.vue';
import AdminDailyService from './AdminDailyService.vue';
import AdminDailyUsers from './AdminDailyUsers.vue';
import AdminTeachingProgress from './AdminTeachingProgress.vue';
import AdminQuestionMappings from './AdminQuestionMappings.vue';
import AdminDailyTestUsers from './AdminDailyTestUsers.vue';
import { nextTabIndex } from '../../lib/tabs';
import { useAuthStore } from '../../stores/auth';

const auth = useAuthStore();
const allPanes = [
  { id: 'configuration', label: '服务、教学进度与固定题', icon: Settings2, adminOnly: false },
  { id: 'mapping', label: '题目主题匹配', icon: ListChecks, adminOnly: false },
  { id: 'cycles', label: '周期管理', icon: CalendarClock, adminOnly: false },
  { id: 'users', label: '用户状态', icon: Users, adminOnly: true },
  { id: 'test-users', label: '内部测试', icon: Users, adminOnly: true },
  { id: 'runtime', label: '运行与缺口', icon: Activity, adminOnly: false },
] as const;
type PaneId = (typeof allPanes)[number]['id'];

const props = withDefaults(defineProps<{
  initialPane?: PaneId;
  active?: boolean;
}>(), {
  initialPane: 'configuration',
  active: true,
});

const panes = computed(() => allPanes.filter((pane) => !pane.adminOnly || auth.isAdmin));
const active = ref<PaneId>(
  ['users', 'test-users'].includes(props.initialPane) && !auth.isAdmin ? 'configuration' : props.initialPane,
);
const visited = ref(new Set<PaneId>([active.value]));
const buttons = ref<HTMLButtonElement[]>([]);

function switchPane(id: PaneId) {
  if (['users', 'test-users'].includes(id) && !auth.isAdmin) return;
  active.value = id;
  visited.value.add(id);
}

watch(
  () => props.initialPane,
  (pane) => switchPane(pane),
);

function onKeydown(event: KeyboardEvent, index: number) {
  const next = nextTabIndex(index, panes.value.length, event.key);
  if (next === null || next === index) return;
  event.preventDefault();
  const pane = panes.value[next]!;
  switchPane(pane.id);
  buttons.value[next]?.focus();
}
</script>

<template>
  <div class="daily-admin-root">
    <nav class="daily-workspace-tabs" role="tablist" aria-label="每日一练管理视图">
      <button
        v-for="(pane, index) in panes"
        :key="pane.id"
        ref="buttons"
        type="button"
        role="tab"
        :aria-selected="active === pane.id"
        :tabindex="active === pane.id ? 0 : -1"
        :class="{ active: active === pane.id }"
        @click="switchPane(pane.id)"
        @keydown="onKeydown($event, index)"
      >
        <component :is="pane.icon" :size="16" aria-hidden="true" />
        {{ pane.label }}
      </button>
    </nav>

    <div v-if="visited.has('configuration')" v-show="active === 'configuration'" class="configuration-pane">
      <AdminDailyService />
      <AdminTeachingProgress />
      <AdminDailyFixedQuestions />
    </div>
    <AdminQuestionMappings v-if="active === 'mapping'" />
    <AdminDailyTestUsers v-if="auth.isAdmin && active === 'test-users'" />
    <AdminDailyCycles
      v-if="visited.has('cycles')"
      v-show="active === 'cycles'"
      :active="props.active && active === 'cycles'"
    />
    <AdminDailyUsers
      v-if="auth.isAdmin && visited.has('users')"
      v-show="active === 'users'"
    />
    <AdminDailyRuntime
      v-if="visited.has('runtime')"
      v-show="active === 'runtime'"
      :active="props.active && active === 'runtime'"
    />
  </div>
</template>

<style scoped>
.daily-admin-root,
.configuration-pane {
  min-width: 0;
  display: grid;
  gap: var(--space-8);
}

.daily-workspace-tabs {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}

.daily-workspace-tabs button {
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

.daily-workspace-tabs button:hover {
  color: var(--ink);
  background: var(--surface-muted);
}

.daily-workspace-tabs button.active {
  color: var(--primary);
  background: var(--primary-soft);
}

@media (max-width: 560px) {
  .daily-admin-root,
  .configuration-pane {
    gap: var(--space-6);
  }

  .daily-workspace-tabs button {
    max-width: 210px;
    white-space: normal;
    text-align: left;
  }
}
</style>
