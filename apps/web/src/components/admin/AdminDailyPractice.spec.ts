import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth';
import AdminDailyPractice from './AdminDailyPractice.vue';

type PaneId = 'configuration' | 'mapping' | 'cycles' | 'users' | 'runtime';

function mountPanel(role: 'EDITOR' | 'ADMIN', initialPane?: PaneId, active = true) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const auth = useAuthStore();
  auth.user = {
    id: `${role.toLowerCase()}-1`,
    displayName: role,
    role,
    status: 'ACTIVE',
  };
  return mount(AdminDailyPractice, {
    props: { ...(initialPane ? { initialPane } : {}), active },
    global: {
      plugins: [pinia],
      stubs: {
        AdminDailyService: true,
        AdminTeachingProgress: true,
        AdminQuestionMappings: true,
        AdminDailyFixedQuestions: true,
        AdminDailyCycles: true,
        AdminDailyRuntime: true,
        AdminDailyUsers: true,
      },
    },
  });
}

describe('AdminDailyPractice permissions', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('never renders or requests the user-status panel for EDITOR', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const wrapper = mountPanel('EDITOR');
    const tabs = wrapper.findAll('[role="tab"]').map((tab) => tab.text());

    expect(tabs).toEqual(['服务、教学进度与固定题', '题目主题匹配', '周期管理', '运行与缺口']);
    expect(wrapper.find('admin-daily-users-stub').exists()).toBe(false);
    expect(wrapper.find('admin-daily-service-stub').exists()).toBe(true);
    expect(wrapper.find('admin-teaching-progress-stub').exists()).toBe(true);
    expect(wrapper.find('admin-daily-fixed-questions-stub').exists()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives EDITOR the shared runtime view without exposing user status', async () => {
    const wrapper = mountPanel('EDITOR');
    const runtimeTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === '运行与缺口')!;
    await runtimeTab.trigger('click');

    expect(wrapper.find('admin-daily-runtime-stub').exists()).toBe(true);
    expect(wrapper.find('admin-daily-users-stub').exists()).toBe(false);
  });

  it('mounts the user-status panel lazily for ADMIN', async () => {
    const wrapper = mountPanel('ADMIN');
    expect(wrapper.find('admin-daily-users-stub').exists()).toBe(false);
    const userTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === '用户状态')!;
    await userTab.trigger('click');
    expect(wrapper.find('admin-daily-users-stub').exists()).toBe(true);
  });

});

describe('AdminDailyPractice pane deep links', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('activates the cycles pane from the initial pane parameter', () => {
    const wrapper = mountPanel('EDITOR', 'cycles');
    const cyclesTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === '周期管理')!;

    expect(cyclesTab.attributes('aria-selected')).toBe('true');
    expect(wrapper.find('admin-daily-cycles-stub').exists()).toBe(true);
  });

  it('follows pane parameter changes after mount', async () => {
    const wrapper = mountPanel('EDITOR');
    expect(wrapper.find('admin-daily-cycles-stub').exists()).toBe(false);

    await wrapper.setProps({ initialPane: 'cycles' as PaneId });

    const cyclesTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text() === '周期管理')!;
    expect(cyclesTab.attributes('aria-selected')).toBe('true');
    expect(wrapper.find('admin-daily-cycles-stub').exists()).toBe(true);
  });

  it('keeps EDITOR out of the admin-only users pane even when deep-linked', () => {
    const wrapper = mountPanel('EDITOR', 'users');
    const tabs = wrapper.findAll('[role="tab"]');

    expect(wrapper.find('admin-daily-users-stub').exists()).toBe(false);
    expect(tabs[0]!.attributes('aria-selected')).toBe('true');
  });

  it('combines the top-level tab state with the selected background-reading pane', async () => {
    const cycles = mountPanel('EDITOR', 'cycles', false);
    expect(cycles.findComponent({ name: 'AdminDailyCycles' }).props('active')).toBe(false);
    await cycles.setProps({ active: true });
    expect(cycles.findComponent({ name: 'AdminDailyCycles' }).props('active')).toBe(true);
    cycles.unmount();

    const runtime = mountPanel('EDITOR', 'runtime', false);
    expect(runtime.findComponent({ name: 'AdminDailyRuntime' }).props('active')).toBe(false);
    await runtime.setProps({ active: true });
    expect(runtime.findComponent({ name: 'AdminDailyRuntime' }).props('active')).toBe(true);
    runtime.unmount();
  });
});
