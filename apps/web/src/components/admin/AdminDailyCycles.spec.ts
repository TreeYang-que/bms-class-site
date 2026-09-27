import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminDailyCycles from './AdminDailyCycles.vue';
import { useToast } from '../../composables/useToast';

const confirmMock = vi.hoisted(() => vi.fn());
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function cycleSummary(practiceDate: string, overrides: Record<string, unknown> = {}) {
  return {
    practiceDate,
    status: 'READY',
    baselineAt: `${practiceDate}T20:00:00.000Z`,
    deadlineAt: `${practiceDate}T20:30:00.000Z`,
    refreezeRequestedAt: null,
    activeUsers: 10,
    createdDays: 5,
    terminalUsers: 8,
    statusCounts: { READY: 8 },
    pool: {
      candidateQuestionCount: 40,
      unresolvedProgressNodeCount: 2,
      remappedProgressNodeCount: 1,
      invalidFixedQuestionCount: 0,
      fixedQuestionCount: 3,
      gapCount: 1,
    },
    ...overrides,
  };
}

function cycleAggregate(
  practiceDate: string,
  options: { pool?: Record<string, unknown> } & Record<string, unknown> = {},
) {
  const { pool, ...rest } = options;
  return {
    practiceDate,
    status: 'READY',
    baselineAt: `${practiceDate}T20:00:00.000Z`,
    deadlineAt: `${practiceDate}T20:30:00.000Z`,
    totalUsers: 10,
    statusCounts: { READY: 10 },
    generationCounts: { PRO_MAX: 10 },
    progressPercent: 100,
    latencyMs: { p50: 1000, p95: 2000 },
    usage: { calls: 10, inputTokens: '100', outputTokens: '50' },
    gapSummary: [
      { subjectId: 'subject-1', subject: '生理学', nodeCount: 3, eligibleQuestionCount: 1 },
    ],
    invalidFixedQuestionCount: 0,
    progressSetHash: 'abcdef1234567890feedface',
    refreezeRequestedAt: null,
    pool: {
      progressNodeCount: 12,
      candidateQuestionCount: 40,
      candidateTypeCounts: { SINGLE: 30, MULTIPLE: 10 },
      unresolvedProgressNodeCount: 0,
      remappedProgressNodeCount: 1,
      remappedNodes: [{
        subjectId: 'subject-1',
        title: '心动周期',
        breadcrumb: '循环 / 心动周期',
        documentId: 'doc-new-1234567890abcd',
        remappedFromDocumentId: 'doc-old-1234567890abcd',
        firstTaughtDate: '2026-07-20',
      }],
      ...pool,
    },
    ...rest,
  };
}

function mockCycleFetch(handlers: {
  list?: { items: unknown[]; total?: number };
  aggregate?: (practiceDate: string) => unknown;
  refreeze?: unknown;
}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    if (init?.method === 'POST' && url.pathname.endsWith('/refreeze')) {
      return response(handlers.refreeze ?? {});
    }
    const detailMatch = url.pathname.match(/\/cycles\/([^/]+)$/);
    if (detailMatch) {
      return response(handlers.aggregate?.(decodeURIComponent(detailMatch[1]!)) ?? null);
    }
    const items = handlers.list?.items ?? [];
    return response({ items, total: handlers.list?.total ?? items.length, page: 1, pageSize: 20 });
  });
}

function listCallCount(fetchMock: ReturnType<typeof mockCycleFetch>) {
  return fetchMock.mock.calls.filter(
    ([input]) => new URL(String(input), 'http://localhost').pathname.endsWith('/cycles'),
  ).length;
}

function mountCycles(active = true) {
  return mount(AdminDailyCycles, {
    props: { active },
    global: { stubs: { RouterLink: RouterLinkStub } },
  });
}

describe('AdminDailyCycles', () => {
  beforeEach(() => {
    confirmMock.mockResolvedValue(true);
    useToast().toasts.splice(0);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the cycle list with pool columns and queued badges for the default 14-day range', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const fetchMock = mockCycleFetch({
      list: {
        items: [
          cycleSummary('2026-07-28'),
          cycleSummary('2026-07-27', { refreezeRequestedAt: '2026-07-27T21:00:00.000Z' }),
        ],
      },
      aggregate: (date) => cycleAggregate(date),
    });
    const wrapper = mountCycles();
    await flushPromises();

    const listUrl = new URL(String(fetchMock.mock.calls[0]![0]), 'http://localhost');
    expect(listUrl.searchParams.get('from')).toBe('2026-07-15');
    expect(listUrl.searchParams.get('to')).toBe('2026-07-28');
    expect(listUrl.searchParams.get('page')).toBe('1');
    expect(listUrl.searchParams.get('pageSize')).toBe('20');

    const rows = wrapper.findAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.get('td[data-label="练习日"]').text()).toBe('2026-07-28');
    expect(rows[0]!.get('td[data-label="状态"]').text()).toContain('已就绪');
    expect(rows[0]!.get('td[data-label="状态"]').text()).not.toContain('重新冻结排队中');
    expect(rows[0]!.get('td[data-label="建批记录"]').text()).toBe('任务 5 条 · 当时纳入 10 人');
    expect(rows[0]!.get('td[data-label="候选题"]').text()).toBe('40');
    expect(rows[0]!.get('td[data-label="未解析节点"]').text()).toBe('2');
    expect(rows[0]!.get('td[data-label="重映射"]').text()).toBe('1');
    expect(rows[0]!.get('td[data-label="无效固定题"]').text()).toBe('0');
    expect(rows[0]!.get('td[data-label="缺口"]').text()).toBe('1');
    expect(rows[1]!.get('td[data-label="状态"]').text()).toContain('重新冻结排队中');
    wrapper.unmount();
  });

  it('reloads the list when a range shortcut is selected', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const fetchMock = mockCycleFetch({
      list: { items: [cycleSummary('2026-07-28')] },
      aggregate: (date) => cycleAggregate(date),
    });
    const wrapper = mountCycles();
    await flushPromises();

    const shortcuts = wrapper.findAll('.range-shortcuts button');
    expect(shortcuts.map((button) => button.text())).toEqual(['近7天', '近14天', '近30天']);

    await shortcuts[0]!.trigger('click');
    await flushPromises();
    let latestUrl = new URL(String(fetchMock.mock.calls.at(-1)![0]), 'http://localhost');
    expect(latestUrl.searchParams.get('from')).toBe('2026-07-22');
    expect(latestUrl.searchParams.get('to')).toBe('2026-07-28');

    await shortcuts[2]!.trigger('click');
    await flushPromises();
    latestUrl = new URL(String(fetchMock.mock.calls.at(-1)![0]), 'http://localhost');
    expect(latestUrl.searchParams.get('from')).toBe('2026-06-29');
    expect(latestUrl.searchParams.get('to')).toBe('2026-07-28');
    wrapper.unmount();
  });

  it('warns inside the drawer when the frozen pool is empty', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    mockCycleFetch({
      list: { items: [cycleSummary('2026-07-28')] },
      aggregate: (date) => cycleAggregate(date, { pool: { progressNodeCount: 0 } }),
    });
    const wrapper = mountCycles();
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();

    const alert = wrapper.get('.detail-panel .alert.error');
    expect(alert.text()).toContain('没有符合已学范围的题目');
    expect(alert.text()).toContain('重新冻结');
    const link = wrapper.findComponent(RouterLinkStub);
    expect(link.props('to')).toEqual({ path: '/admin', query: { tab: 'daily', pane: 'mapping' } });
    wrapper.unmount();
  });

  it('disables refreeze for cycles other than the current practice date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    mockCycleFetch({
      list: { items: [cycleSummary('2026-07-27')] },
      aggregate: (date) => cycleAggregate(date),
    });
    const wrapper = mountCycles();
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();

    const button = wrapper.get('.refreeze-button');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain('仅当前练习日可重新冻结');
    expect(wrapper.get('.detail-panel').text()).toContain(
      '仅当前练习日可请求重新冻结',
    );

    await button.trigger('click');
    await flushPromises();
    expect(useToast().toasts).toHaveLength(0);
    wrapper.unmount();
  });

  it('stops polling when a past cycle has a stale queued refreeze flag', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const fetchMock = mockCycleFetch({
      list: {
        items: [
          cycleSummary('2026-07-27', {
            refreezeRequestedAt: '2026-07-27T21:00:00.000Z',
          }),
        ],
      },
      aggregate: (date) =>
        cycleAggregate(date, {
          refreezeRequestedAt: '2026-07-27T21:00:00.000Z',
        }),
    });
    const wrapper = mountCycles();
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();

    const detailCalls = () =>
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith('/cycles/2026-07-27'),
      ).length;
    expect(detailCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(detailCalls()).toBe(1);
    wrapper.unmount();
  });

  it('does not call the refreeze endpoint when the confirmation is cancelled', async () => {
    confirmMock.mockResolvedValue(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const fetchMock = mockCycleFetch({
      list: { items: [cycleSummary('2026-07-28')] },
      aggregate: (date) => cycleAggregate(date),
    });
    const wrapper = mountCycles();
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();

    await wrapper.get('.refreeze-button').trigger('click');
    await flushPromises();

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    wrapper.unmount();
  });

  it('submits refreeze after confirmation and polls until the queue flag clears', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const toast = useToast();
    const fetchMock = mockCycleFetch({
      list: { items: [cycleSummary('2026-07-28')] },
      aggregate: (date) => cycleAggregate(date),
      refreeze: {
        practiceDate: '2026-07-28',
        status: 'READY',
        refreezeRequestedAt: '2026-07-28T12:00:00.000Z',
        rebuildableDayCount: 3,
        alreadyRequested: false,
      },
    });
    const wrapper = mountCycles();
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();

    await wrapper.get('.refreeze-button').trigger('click');
    await flushPromises();

    expect(
      fetchMock.mock.calls.some(([input, init]) =>
        init?.method === 'POST' && String(input).endsWith('/cycles/2026-07-28/refreeze')),
    ).toBe(true);
    expect(toast.toasts.some((item) => item.text.includes('重建 3 个未开始计划'))).toBe(true);
    expect(wrapper.get('.refreeze-button').attributes('disabled')).toBeDefined();
    expect(wrapper.get('.detail-panel').text()).toContain('重新冻结排队中');
    const listCallsAfterSubmit = listCallCount(fetchMock);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();

    expect(toast.toasts.some((item) => item.text.includes('重新冻结已完成'))).toBe(true);
    expect(wrapper.get('.detail-panel').text()).not.toContain('重新冻结排队中');
    expect(wrapper.get('.refreeze-button').attributes('disabled')).toBeUndefined();
    expect(listCallCount(fetchMock)).toBeGreaterThan(listCallsAfterSubmit);
    wrapper.unmount();
  });

  it('reports an already-queued refreeze without a duplicate submission toast', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const toast = useToast();
    mockCycleFetch({
      list: { items: [cycleSummary('2026-07-28')] },
      aggregate: (date) => cycleAggregate(date),
      refreeze: {
        practiceDate: '2026-07-28',
        status: 'READY',
        refreezeRequestedAt: '2026-07-28T11:59:00.000Z',
        rebuildableDayCount: 0,
        alreadyRequested: true,
      },
    });
    const wrapper = mountCycles();
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();

    await wrapper.get('.refreeze-button').trigger('click');
    await flushPromises();

    expect(toast.toasts.some((item) => item.text.includes('已在重新冻结排队中'))).toBe(true);
    expect(toast.toasts.some((item) => item.text.includes('已提交重新冻结'))).toBe(false);
    wrapper.unmount();
  });

  it('reloads the authoritative cycle detail after a refreeze conflict', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    let detailCalls = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (init?.method === 'POST' && url.pathname.endsWith('/refreeze')) {
        return response({ message: '该周期已发生变化' }, 409);
      }
      const detailMatch = url.pathname.match(/\/cycles\/([^/]+)$/);
      if (detailMatch) {
        detailCalls += 1;
        return response(cycleAggregate(decodeURIComponent(detailMatch[1]!)));
      }
      return response({
        items: [cycleSummary('2026-07-28')],
        total: 1,
        page: 1,
        pageSize: 20,
      });
    });
    const wrapper = mountCycles();
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();

    await wrapper.get('.refreeze-button').trigger('click');
    await flushPromises();

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true);
    expect(detailCalls).toBe(2);
    wrapper.unmount();
  });

  it('disables refreeze reactively when the Shanghai practice day rolls over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T19:59:55.000Z'));
    mockCycleFetch({
      list: { items: [cycleSummary('2026-07-28')] },
      aggregate: (date) => cycleAggregate(date),
    });
    const wrapper = mountCycles();
    await flushPromises();
    await wrapper.get('.action-link').trigger('click');
    await flushPromises();
    expect(wrapper.get('.refreeze-button').attributes('disabled')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5_050);
    await flushPromises();

    expect(wrapper.get('.refreeze-button').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('keeps the stable cycle list visible when pagination fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.searchParams.get('page') === '2') {
        return response({ message: '周期列表暂时不可用' }, 500);
      }
      return response({
        items: [cycleSummary('2026-07-28')],
        total: 21,
        page: 1,
        pageSize: 20,
      });
    });
    const wrapper = mountCycles();
    await flushPromises();

    wrapper.findComponent({ name: 'PaginationControl' }).vm.$emit('update:page', 2);
    await flushPromises();

    expect(wrapper.text()).toContain('2026-07-28');
    expect(wrapper.get('.alert.error').text()).toContain('周期列表暂时不可用');
    expect(wrapper.findComponent({ name: 'PaginationControl' }).props('page')).toBe(1);
    wrapper.unmount();
  });

  it('corrects a cycle page that became out of range once', async () => {
    const requestedPages: string[] = [];
    let pageOneCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input), 'http://localhost');
      const requestedPage = url.searchParams.get('page') ?? '';
      requestedPages.push(requestedPage);
      if (requestedPage === '3') {
        return response({ items: [], total: 1, page: 3, pageSize: 20 });
      }
      pageOneCalls += 1;
      return response({
        items: [cycleSummary(pageOneCalls === 1 ? '2026-07-28' : '2026-07-29')],
        total: pageOneCalls === 1 ? 41 : 1,
        page: 1,
        pageSize: 20,
      });
    });
    const wrapper = mountCycles();
    await flushPromises();

    wrapper.findComponent({ name: 'PaginationControl' }).vm.$emit('update:page', 3);
    await flushPromises();

    expect(requestedPages).toEqual(['1', '3', '1']);
    expect(wrapper.text()).toContain('2026-07-29');
    expect(wrapper.text()).not.toContain('2026-07-28');
    expect(wrapper.findComponent({ name: 'PaginationControl' }).props('page')).toBe(1);
    wrapper.unmount();
  });

  it('stops retained-pane reads while hidden and reloads the list once when restored', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const fetchMock = mockCycleFetch({ list: { items: [] } });
    const wrapper = mountCycles(false);
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();

    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(listCallCount(fetchMock)).toBe(1);

    await wrapper.setProps({ active: false });
    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(listCallCount(fetchMock)).toBe(2);
    wrapper.unmount();
  });
});
