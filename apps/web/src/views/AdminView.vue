<script setup lang="ts">
import { computed, inject, provide, ref, watch } from 'vue';
import { routeLocationKey } from 'vue-router';
import {
  CalendarCheck2,
  BadgeCheck,
  FileText,
  Images,
  KeyRound,
  Library,
  ListChecks,
  Megaphone,
  ScrollText,
  Users,
} from 'lucide-vue-next';
import PageHeader from '../components/layout/PageHeader.vue';
import AdminMembers from '../components/admin/AdminMembers.vue';
import AdminInvites from '../components/admin/AdminInvites.vue';
import AdminNews from '../components/admin/AdminNews.vue';
import AdminAlbums from '../components/admin/AdminAlbums.vue';
import AdminKnowledge from '../components/admin/AdminKnowledge.vue';
import AdminQuiz from '../components/admin/AdminQuiz.vue';
import AdminAuditLogs from '../components/admin/AdminAuditLogs.vue';
import AdminDailyPractice from '../components/admin/AdminDailyPractice.vue';
import AdminCreditHours from '../components/admin/AdminCreditHours.vue';
import AdminAnnouncements from '../components/admin/AdminAnnouncements.vue';
import { adminTabGuardKey, type AdminTabGuard } from '../lib/adminTabGuard';
import { nextTabIndex } from '../lib/tabs';
import { useAuthStore } from '../stores/auth';

const auth = useAuthStore();

const allTabs = [
  { id: 'members', label: '成员', icon: Users, admin: true },
  { id: 'invites', label: '邀请码', icon: KeyRound, admin: true },
  { id: 'news', label: '动态', icon: FileText, admin: false },
  { id: 'announcements', label: '公告', icon: Megaphone, admin: true },
  { id: 'albums', label: '相册', icon: Images, admin: false },
  { id: 'knowledge', label: '知识库', icon: Library, admin: false },
  { id: 'quiz', label: '题库', icon: ListChecks, admin: false },
  { id: 'daily', label: '每日一练', icon: CalendarCheck2, admin: false },
  { id: 'credit-hours', label: '学时管理', icon: BadgeCheck, admin: true },
  { id: 'audit', label: '审计日志', icon: ScrollText, admin: true },
] as const;

type TabId = (typeof allTabs)[number]['id'];

const tabs = computed(() =>
  allTabs.filter((tab) => !tab.admin || auth.isAdmin),
);
const route = inject(routeLocationKey, null);
function requestedTab(): TabId | null {
  const value = route?.query.tab;
  return typeof value === 'string' && tabs.value.some((tab) => tab.id === value)
    ? (value as TabId)
    : null;
}

const active = ref<TabId>(requestedTab() ?? (auth.isAdmin ? 'members' : 'news'));
const dailyPane = computed(() => {
  const value = route?.query.pane;
  return value === 'configuration' || value === 'mapping' || value === 'cycles' || value === 'users' || value === 'runtime'
    ? value
    : undefined;
});
const quizSubjectId = computed(() =>
  typeof route?.query.subjectId === 'string' ? route.query.subjectId : undefined,
);
// 已访问 Tab 集合：面板懒挂载，避免进入后台即并发全部面板的首次查询；
// 挂载后保持存活（配合 v-show）以保留各 Tab 的表单与列表状态
const visited = ref(new Set<TabId>([active.value]));
const tabButtons = ref<HTMLButtonElement[]>([]);

// 子面板可注册离开守卫（如动态编辑的未保存保护），切换 Tab 前需先放行
const tabGuards = new Map<string, AdminTabGuard>();
provide(adminTabGuardKey, {
  register: (tabId, guard) => {
    tabGuards.set(tabId, guard);
  },
  unregister: (tabId) => {
    tabGuards.delete(tabId);
  },
});

const switching = ref(false);
async function switchTab(id: TabId) {
  if (id === active.value || switching.value) return;
  switching.value = true;
  try {
    const guard = tabGuards.get(active.value);
    if (guard && !(await guard())) return;
    active.value = id;
    visited.value.add(id);
  } finally {
    switching.value = false;
  }
}

/** WAI-ARIA tabs：←/→/Home/End 切换并移动焦点；被离开守卫拦下时焦点留在原 Tab */
async function onTablistKeydown(event: KeyboardEvent, index: number) {
  const next = nextTabIndex(index, tabs.value.length, event.key);
  if (next === null || next === index) return;
  event.preventDefault();
  await switchTab(tabs.value[next]!.id);
  if (active.value === tabs.value[next]!.id) tabButtons.value[next]?.focus();
}

watch(
  () => route?.query.tab,
  () => {
    const next = requestedTab();
    if (next) void switchTab(next);
  },
);
</script>

<template>
  <main class="page">
    <PageHeader
      title="管理后台"
      description="成员审核、内容发布和资料维护操作均记录审计日志。"
    >
      <template #breadcrumb>
        <RouterLink to="/">首页</RouterLink>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">管理后台</span>
      </template>
    </PageHeader>

    <section class="page-content">
      <div class="tabs" role="tablist" aria-label="管理功能">
        <button
          v-for="(tab, index) in tabs"
          :key="tab.id"
          ref="tabButtons"
          type="button"
          role="tab"
          :aria-selected="active === tab.id"
          :tabindex="active === tab.id ? 0 : -1"
          @click="switchTab(tab.id)"
          @keydown="onTablistKeydown($event, index)"
        >
          <component
            :is="tab.icon"
            :size="15"
            aria-hidden="true"
            class="tab-icon"
          />
          {{ tab.label }}
        </button>
      </div>

      <!-- v-show 保留已访问 Tab 的表单与结果状态；v-if 实现首次激活才挂载 -->
      <AdminMembers
        v-if="auth.isAdmin && visited.has('members')"
        v-show="active === 'members'"
      />
      <AdminInvites
        v-if="auth.isAdmin && visited.has('invites')"
        v-show="active === 'invites'"
      />
      <AdminNews v-if="visited.has('news')" v-show="active === 'news'" />
      <AdminAnnouncements v-if="auth.isAdmin && active === 'announcements'" />
      <AdminAlbums v-if="visited.has('albums')" v-show="active === 'albums'" />
      <AdminKnowledge
        v-if="visited.has('knowledge')"
        v-show="active === 'knowledge'"
        :active="active === 'knowledge'"
      />
      <AdminQuiz
        v-if="visited.has('quiz')"
        v-show="active === 'quiz'"
        :initial-subject-id="quizSubjectId"
        :active="active === 'quiz'"
      />
      <AdminDailyPractice
        v-if="visited.has('daily')"
        v-show="active === 'daily'"
        :initial-pane="dailyPane"
        :active="active === 'daily'"
      />
      <div
        v-if="auth.isAdmin && visited.has('credit-hours')"
        v-show="active === 'credit-hours'"
        class="admin-tab-panel"
      >
        <AdminCreditHours />
      </div>
      <AdminAuditLogs
        v-if="auth.isAdmin && visited.has('audit')"
        v-show="active === 'audit'"
      />
    </section>
  </main>
</template>

<style scoped>
.tab-icon {
  vertical-align: -2px;
  margin-right: var(--space-1);
}

.admin-tab-panel {
  min-width: 0;
}

@media (max-width: 900px) {
  .tabs {
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 2px;
  }
}
</style>
