<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, formatError } from '../../lib/api';
import { getAdminDailyUsers } from '../../lib/dailyPractice';
import { useLatestRequest } from '../../composables/useLatestRequest';
import { useToast } from '../../composables/useToast';
import PaginationControl from '../common/PaginationControl.vue';
import ErrorState from '../common/ErrorState.vue';
import type { AdminDailyPracticeUserSummary } from '../../types';

interface TestAccess { globalEnabled: boolean; revision: number; userIds: string[] }
const settings = ref<TestAccess | null>(null);
const users = ref<AdminDailyPracticeUserSummary[]>([]);
const search = ref('');
const page = ref(1);
const total = ref(0);
const busy = ref(false);
const error = ref('');
const requests = useLatestRequest();
const toast = useToast();

async function load(nextPage = 1) {
  error.value = '';
  await requests.runLatest(async ({ signal }) => {
    const [access, result] = await Promise.all([
      api<TestAccess>('/admin/daily-practice/test-access', { signal }),
      getAdminDailyUsers({ search: search.value.trim(), page: nextPage, pageSize: 20 }, { signal }),
    ]);
    return { access, result };
  }, {
    commit({ access, result }) { settings.value = access; users.value = result.items; total.value = result.total; page.value = result.page; },
    onError(caught) { error.value = formatError(caught, '内部测试用户加载失败'); },
  });
}

async function toggle(user: AdminDailyPracticeUserSummary) {
  if (!settings.value || settings.value.globalEnabled || busy.value) return;
  busy.value = true;
  error.value = '';
  const enabled = !settings.value.userIds.includes(user.id);
  try {
    settings.value = await api<TestAccess>(`/admin/daily-practice/test-access/${encodeURIComponent(user.id)}`, {
      method: 'PATCH', body: JSON.stringify({ enabled, expectedRevision: settings.value.revision }),
    });
    toast.success(enabled ? '已为该用户开启内部测试' : '已关闭该用户的内部测试');
  } catch (caught) { error.value = formatError(caught, '设置失败，请刷新后重试'); }
  finally { busy.value = false; }
}
onMounted(() => void load());
</script>

<template>
  <section class="test-users" aria-labelledby="test-users-title">
    <header><h3 id="test-users-title">内部测试用户</h3><p class="muted-note">仅管理员可管理。总开关关闭时，只有在这里开启的活动用户可以使用每日一练；计划暂停时段仍对测试用户生效。总开关开启后，所有用户按正常规则使用，这里的设置不再限制访问。</p></header>
    <p v-if="settings?.globalEnabled" class="muted-note" role="status">当前总开关已开启。请先关闭总开关，再调整内部测试用户。</p>
    <p v-else-if="settings" role="status">总开关关闭 · 已选择 {{ settings.userIds.length }} 位内部测试用户</p>
    <form class="search-controls" @submit.prevent="load(1)"><label for="test-user-search">搜索用户</label><input id="test-user-search" v-model="search" type="search" placeholder="输入姓名" :disabled="busy" /><button class="button secondary" :disabled="busy || requests.loading.value">搜索 / 刷新</button></form>
    <ErrorState v-if="error" :message="error" @retry="load(page)" />
    <p v-if="requests.loading.value">正在加载…</p>
    <ul v-else class="test-user-list"><li v-for="user in users" :key="user.id"><div><strong>{{ user.displayName }}</strong><span v-if="user.status !== 'ACTIVE'" class="muted-note">账号未启用</span></div><button type="button" role="switch" :aria-checked="settings?.userIds.includes(user.id) ?? false" :aria-label="`${user.displayName}的内部测试`" class="button secondary" :disabled="busy || !settings || settings.globalEnabled || (user.status !== 'ACTIVE' && !settings.userIds.includes(user.id))" @click="toggle(user)">{{ settings?.userIds.includes(user.id) ? '已开启' : '已关闭' }}</button></li></ul>
    <p v-if="!requests.loading.value && !users.length">没有符合条件的用户。</p>
    <PaginationControl :page="page" :page-count="Math.max(1, Math.ceil(total / 20))" @update:page="load" />
  </section>
</template>

<style scoped>
.test-users { display: grid; gap: var(--space-4); min-width: 0; }
.test-users h3 { margin: 0; }
.muted-note { color: var(--muted); font-size: 13px; line-height: 1.7; }
.search-controls { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.search-controls input { flex: 1; min-width: 160px; }
.test-user-list { list-style: none; margin: 0; padding: 0; }
.test-user-list li { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); padding: var(--space-3) 0; border-bottom: 1px solid var(--border); }
.test-user-list li > div { display: grid; gap: var(--space-2); }
.test-user-list [aria-checked=true] { color: var(--accent-dark); border-color: var(--accent); }
@media (max-width: 560px) { .search-controls { align-items: stretch; flex-direction: column; } }
</style>
