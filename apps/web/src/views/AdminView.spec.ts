import { mount, RouterLinkStub } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { routeLocationKey } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/auth';
import AdminView from './AdminView.vue';

vi.mock('../components/admin/AdminKnowledge.vue', () => ({
  default: { name: 'AdminKnowledge', props: ['active'], template: '<div />' },
}));

describe('AdminView role visibility', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => vi.restoreAllMocks());

  it('shows content management but not administrator-only management for EDITOR', () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const auth = useAuthStore();
    auth.user = {
      id: 'editor-1',
      displayName: '编辑',
      role: 'EDITOR',
      status: 'ACTIVE',
    };
    const wrapper = mount(AdminView, {
      global: {
        stubs: {
          RouterLink: RouterLinkStub,
          PageHeader: {
            template:
              '<div><slot name="breadcrumb"/><slot name="actions"/></div>',
          },
          AdminMembers: true,
          AdminInvites: true,
          AdminNews: true,
          AdminAlbums: true,
          AdminKnowledge: true,
          AdminQuiz: true,
          AdminDailyPractice: true,
          AdminCreditHours: true,
          AdminAuditLogs: true,
        },
      },
    });

    const tabs = wrapper.findAll('[role="tab"]').map((tab) => tab.text());
    expect(tabs).toContain('动态');
    expect(tabs).toContain('相册');
    expect(tabs).toContain('题库');
    expect(tabs).toContain('每日一练');
    expect(tabs).not.toContain('成员');
    expect(tabs).not.toContain('邀请码');
    expect(tabs).not.toContain('学时管理');
    expect(tabs).not.toContain('审计日志');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens question management when a retired AI workspace link is visited', () => {
    const auth = useAuthStore();
    auth.user = {
      id: 'admin-1',
      displayName: '管理员',
      role: 'ADMIN',
      status: 'ACTIVE',
    };
    const wrapper = mount(AdminView, {
      global: {
        provide: {
          [routeLocationKey as symbol]: {
            query: { tab: 'quiz', pane: 'ai', subjectId: 'subject-2' },
          },
        },
        stubs: {
          RouterLink: RouterLinkStub,
          PageHeader: { template: '<div><slot name="breadcrumb" /></div>' },
          AdminMembers: true,
          AdminInvites: true,
          AdminNews: true,
          AdminAlbums: true,
          AdminKnowledge: true,
          AdminQuiz: true,
          AdminDailyPractice: true,
          AdminCreditHours: true,
          AdminAuditLogs: true,
        },
      },
    });

    const quizTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text().includes('题库'))!;
    const quiz = wrapper.findComponent({ name: 'AdminQuiz' });
    expect(quizTab.attributes('aria-selected')).toBe('true');
    expect(quiz.props('initialPane')).toBe('manage');
    expect(quiz.props('initialSubjectId')).toBe('subject-2');
  });
});

describe('AdminView panel mounting and tab keyboard navigation', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  function mountAdmin() {
    const auth = useAuthStore();
    auth.user = {
      id: 'admin-1',
      displayName: '管理员',
      role: 'ADMIN',
      status: 'ACTIVE',
    };
    return mount(AdminView, {
      attachTo: document.body,
      global: {
        stubs: {
          RouterLink: RouterLinkStub,
          PageHeader: {
            template:
              '<div><slot name="breadcrumb"/><slot name="actions"/></div>',
          },
          AdminMembers: true,
          AdminInvites: true,
          AdminNews: true,
          AdminAlbums: true,
          AdminKnowledge: true,
          AdminQuiz: true,
          AdminDailyPractice: true,
          AdminCreditHours: true,
          AdminAuditLogs: true,
        },
      },
    });
  }

  it('mounts panels lazily on first visit and keeps them alive afterwards', async () => {
    const wrapper = mountAdmin();
    expect(wrapper.find('admin-members-stub').exists()).toBe(true);
    expect(wrapper.find('admin-news-stub').exists()).toBe(false);
    expect(wrapper.find('admin-quiz-stub').exists()).toBe(false);

    const newsTab = wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text().includes('动态'))!;
    await newsTab.trigger('click');

    expect(wrapper.find('admin-news-stub').exists()).toBe(true);
    expect(wrapper.find('admin-members-stub').exists()).toBe(true);
    wrapper.unmount();
  });

  it('hides a visited multi-root credit-hours panel when audit logs open', async () => {
    const auth = useAuthStore();
    auth.user = {
      id: 'admin-1',
      displayName: '管理员',
      role: 'ADMIN',
      status: 'ACTIVE',
    };
    const wrapper = mount(AdminView, {
      attachTo: document.body,
      global: {
        stubs: {
          RouterLink: RouterLinkStub,
          PageHeader: {
            template:
              '<div><slot name="breadcrumb"/><slot name="actions"/></div>',
          },
          AdminMembers: true,
          AdminInvites: true,
          AdminNews: true,
          AdminAlbums: true,
          AdminKnowledge: true,
          AdminQuiz: true,
          AdminDailyPractice: true,
          AdminCreditHours: {
            template:
              '<section data-testid="credit-hours-content">学时管理</section><div data-testid="credit-hours-dialog" />',
          },
          AdminAuditLogs: true,
        },
      },
    });

    const tabs = wrapper.findAll('[role="tab"]');
    const creditHoursTab = tabs.find((tab) => tab.text().includes('学时管理'))!;
    const auditTab = tabs.find((tab) => tab.text().includes('审计日志'))!;

    await creditHoursTab.trigger('click');
    expect(wrapper.get('[data-testid="credit-hours-content"]').isVisible()).toBe(true);

    await auditTab.trigger('click');
    expect(wrapper.get('[data-testid="credit-hours-content"]').isVisible()).toBe(false);
    expect(wrapper.get('admin-audit-logs-stub').isVisible()).toBe(true);

    await creditHoursTab.trigger('click');
    expect(wrapper.get('[data-testid="credit-hours-content"]').isVisible()).toBe(true);
    wrapper.unmount();
  });

  it('unmounts the multi-root announcements panel when switching management tabs', async () => {
    useAuthStore().user = { id: 'admin-1', displayName: '管理员', role: 'ADMIN', status: 'ACTIVE' };
    const wrapper = mount(AdminView, {
      global: {
        stubs: {
          RouterLink: RouterLinkStub, PageHeader: true, AdminMembers: true, AdminAuditLogs: true,
          AdminAnnouncements: { template: '<section data-testid="announcements-content" /><div data-testid="announcements-preview" />' },
        },
      },
    });
    const tabs = wrapper.findAll('[role="tab"]');
    const announcements = tabs.find((tab) => tab.text().includes('公告'))!;
    await announcements.trigger('click');
    expect(wrapper.find('[data-testid="announcements-content"]').exists()).toBe(true);
    await tabs.find((tab) => tab.text().includes('审计日志'))!.trigger('click');
    expect(wrapper.find('[data-testid="announcements-content"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="announcements-preview"]').exists()).toBe(false);
    await announcements.trigger('click');
    expect(wrapper.find('[data-testid="announcements-content"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('marks only the visible retained management pane as active', async () => {
    const wrapper = mountAdmin();
    const knowledgeTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text().includes('知识库'))!;
    const quizTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text().includes('题库'))!;
    const dailyTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text().includes('每日一练'))!;

    await knowledgeTab.trigger('click');
    const knowledge = wrapper.findComponent({ name: 'AdminKnowledge' });
    expect(knowledge.props('active')).toBe(true);

    await quizTab.trigger('click');
    const quiz = wrapper.findComponent({ name: 'AdminQuiz' });
    expect(knowledge.props('active')).toBe(false);
    expect(quiz.props('active')).toBe(true);

    await dailyTab.trigger('click');
    const daily = wrapper.findComponent({ name: 'AdminDailyPractice' });
    expect(quiz.props('active')).toBe(false);
    expect(daily.props('active')).toBe(true);
    wrapper.unmount();
  });

  it('moves selection and focus with arrow keys (roving tabindex)', async () => {
    const wrapper = mountAdmin();
    const tabElements = wrapper.findAll('[role="tab"]');
    expect(tabElements[0]!.attributes('tabindex')).toBe('0');
    expect(tabElements[1]!.attributes('tabindex')).toBe('-1');

    await tabElements[0]!.trigger('keydown', { key: 'ArrowRight' });

    const updated = wrapper.findAll('[role="tab"]');
    expect(updated[1]!.attributes('aria-selected')).toBe('true');
    expect(updated[1]!.attributes('tabindex')).toBe('0');
    expect(document.activeElement).toBe(updated[1]!.element);
    wrapper.unmount();
  });
});
