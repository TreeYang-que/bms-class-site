import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminDailyRuntime from './AdminDailyRuntime.vue';

function response(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function cycle(practiceDate: string, poolOverrides: Record<string, unknown> = {}) {
  return {
    practiceDate,
    status: 'READY',
    baselineAt: `${practiceDate}T20:00:00.000Z`,
    deadlineAt: `${practiceDate}T20:30:00.000Z`,
    totalUsers: 10,
    statusCounts: { READY: 10 },
    generationCounts: { PRO_MAX: 10 },
    progressPercent: 100,
    progress: {
      scope: 'CURRENT_ACCESS', checkedAt: `${practiceDate}T08:00:00.000Z`,
      enqueuedUsers: 10, missingUsers: 0, availableUsers: 10, aiReadyUsers: 10,
      fallbackReadyUsers: 0, nextScheduledAt: null,
    },
    latencyMs: { p50: 1000, p95: 2000 },
    usage: { calls: 10, inputTokens: '100', outputTokens: '50' },
    gapSummary: [],
    invalidFixedQuestionCount: 0,
    progressSetHash: 'progress-set-hash-0123456789abcdef',
    refreezeRequestedAt: null,
    pool: {
      progressNodeCount: 12,
      candidateQuestionCount: 40,
      candidateTypeCounts: { SINGLE: 30, MULTIPLE: 10 },
      unresolvedProgressNodeCount: 0,
      remappedProgressNodeCount: 1,
      remappedNodes: [],
      ...poolOverrides,
    },
  };
}

function mountRuntime(active = true) {
  return mount(AdminDailyRuntime, {
    props: { active },
    global: { stubs: { RouterLink: RouterLinkStub } },
  });
}

describe('AdminDailyRuntime practice-day rollover', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('follows the shared Shanghai practice date across 04:00', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T19:59:55.000Z'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const practiceDate = decodeURIComponent(String(input).split('/').at(-1) ?? '');
      return response(cycle(practiceDate));
    });
    const wrapper = mountRuntime();
    await flushPromises();
    expect((wrapper.get('#runtime-date').element as HTMLInputElement).value).toBe('2026-07-28');

    await vi.advanceTimersByTimeAsync(5_050);
    await flushPromises();

    expect((wrapper.get('#runtime-date').element as HTMLInputElement).value).toBe('2026-07-29');
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/2026-07-29'))).toBe(true);
    wrapper.unmount();
  });

  it('does not leave a manually selected historical cycle at 04:00', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T19:59:55.000Z'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const practiceDate = decodeURIComponent(String(input).split('/').at(-1) ?? '');
      return response(cycle(practiceDate));
    });
    const wrapper = mountRuntime();
    await flushPromises();
    await wrapper.get('#runtime-date').setValue('2026-07-20');
    await wrapper.get('#runtime-date').trigger('change');
    await flushPromises();

    await vi.advanceTimersByTimeAsync(5_050);
    await flushPromises();

    expect((wrapper.get('#runtime-date').element as HTMLInputElement).value).toBe('2026-07-20');
    wrapper.unmount();
  });
});

describe('AdminDailyRuntime pool diagnostics', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('explains missing, rebuilding and fallback plans and keeps polling a degraded current day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00Z'));
    const payload = {
      ...cycle('2026-07-28'), status: 'DEGRADED', totalUsers: 4, progressPercent: 25,
      statusCounts: { STALE: 1, DEGRADED_READY: 1 }, generationCounts: { DETERMINISTIC: 1 },
      progress: { scope: 'CURRENT_ACCESS', checkedAt: '2026-07-28T08:00:00Z',
        enqueuedUsers: 2, missingUsers: 2, availableUsers: 1, aiReadyUsers: 0,
        fallbackReadyUsers: 1, nextScheduledAt: '2026-07-28T08:08:00Z' },
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(payload));
    const wrapper = mountRuntime();
    await flushPromises();
    expect(wrapper.text()).toContain('1 / 4 人（25%）');
    expect(wrapper.text()).toContain('尚未入队 2 人');
    expect(wrapper.text()).toContain('规则回退可用 1 人');
    expect(wrapper.text()).toContain('等待重建 1 人');
    expect(wrapper.text()).toContain('下一批计划调度时间');
    expect(wrapper.text()).not.toContain('完成进度');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('warns and links to cycle management when the pool is depleted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      response(cycle('2026-07-28', { candidateQuestionCount: 0 })),
    );
    const wrapper = mountRuntime();
    await flushPromises();

    const alert = wrapper.get('.pool-alert');
    expect(alert.text()).toContain('今日没有符合已学范围的题目');
    const link = wrapper.findComponent(RouterLinkStub);
    expect(link.props('to')).toEqual({ path: '/admin', query: { tab: 'daily', pane: 'cycles' } });
    wrapper.unmount();
  });

  it('tolerates a stale aggregate payload without pool diagnostics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const stale = cycle('2026-07-28') as Record<string, unknown>;
    delete stale.pool;
    delete stale.progressSetHash;
    delete stale.refreezeRequestedAt;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response(stale));
    const wrapper = mountRuntime();
    await flushPromises();

    expect(wrapper.text()).toContain('周期状态');
    expect(wrapper.find('.pool-strip').exists()).toBe(false);
    expect(wrapper.find('.pool-alert').exists()).toBe(false);
    wrapper.unmount();
  });

  it('schedules the next poll only after the current request completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    let resolveFirst!: (value: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const building = { ...cycle('2026-07-28'), status: 'BUILDING' };
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => firstResponse)
      .mockImplementation(async () => response(cycle('2026-07-28')));

    const wrapper = mountRuntime();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFirst(response(building));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('stops all reads while hidden and reloads once after each restore', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T08:00:00.000Z'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(cycle('2026-07-28')),
    );
    const wrapper = mountRuntime(false);
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();

    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await wrapper.setProps({ active: false });
    await wrapper.setProps({ active: true });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
