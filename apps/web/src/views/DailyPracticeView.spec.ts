import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DailyPracticeTodayResponse,
  QuizAttemptLifecycle,
} from '../types';
import DailyPracticeView from './DailyPracticeView.vue';

const historyMountMock = vi.fn();

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function today(
  overrides: Partial<DailyPracticeTodayResponse> = {},
): DailyPracticeTodayResponse {
  return {
    practiceDate: '2026-07-28',
    timeZone: 'Asia/Shanghai',
    dayStartedAt: '2026-07-27T20:00:00.000Z',
    nextDayStartsAt: '2026-07-28T20:00:00.000Z',
    status: 'READY',
    service: {
      enabled: true,
      paused: false,
      reason: null,
      resumesAt: null,
      settingsRevision: 1,
    },
    dayId: 'day-1',
    supplemental: false,
    planRevisionId: 'plan-1',
    generationSource: 'PRO_MAX',
    generatedAt: '2026-07-27T20:10:00.000Z',
    degradedReason: null,
    summary: {
      headline: '今日重点是巩固循环系统',
      overview: '近期基础概念较稳，优先处理仍有错题的章节。',
      dataQuality: 'SUFFICIENT',
      strengths: [{ knowledgeAlias: 'K001', text: '心动周期掌握较稳', evidenceRefs: ['S001'] }],
      priorities: [{ knowledgeAlias: 'K002', text: '复习微循环调节', evidenceRefs: ['S002'] }],
    },
    personalizedItems: [
      {
        ordinal: 1,
        source: 'PERSONALIZED',
        questionId: 'q1',
        gradingType: 'SINGLE',
        typeLabel: '单选题',
        subjectId: 's1',
        subject: '生理学',
        chapterIds: ['c1'],
        chapters: [{ id: 'c1', name: '循环', slug: 'circulation' }],
        prompt: '个性化题干',
        options: [{ id: 'A', text: '选项' }],
        images: [],
        maxScore: 1,
        reason: '对应近期错题',
        evidenceRefs: ['S002'],
      },
    ],
    fixedItems: [],
    counts: { personalized: 1, fixed: 0, total: 1 },
    attempt: null,
    suggestion: {
      targetPracticeDate: '2026-07-29',
      available: true,
      current: null,
    },
    initialization: null,
    ...overrides,
  };
}

function attemptLifecycle(
  overrides: Partial<QuizAttemptLifecycle> = {},
): QuizAttemptLifecycle {
  return {
    attemptId: 'attempt-1',
    status: 'DRAFT',
    revision: 4,
    position: 0,
    answers: { q1: ['A'] },
    questions: [],
    savedAt: '2026-07-28T09:00:00.000Z',
    expiresAt: '2026-08-04T09:00:00.000Z',
    abandonedAt: null,
    submittedAt: null,
    score: null,
    total: 1,
    results: null,
    gradingError: null,
    ...overrides,
  };
}

function mountView() {
  return mount(DailyPracticeView, {
    global: {
      stubs: {
        RouterLink: RouterLinkStub,
        PageHeader: {
          props: ['title', 'description'],
          template: '<header class="page-header-stub" :data-title="title" :data-description="description"><slot name="breadcrumb" /></header>',
        },
        DailySuggestionForm: true,
        DailyPracticeHistory: {
          name: 'DailyPracticeHistory',
          template: '<div class="history-stub" />',
          mounted() { historyMountMock(); },
        },
        QuizRunner: {
          name: 'QuizRunner',
          props: ['attemptId', 'questions', 'finishLabel', 'initialState'],
          emits: ['submitted', 'restart'],
          template: '<div class="quiz-runner-stub"><span class="finish-label">{{ finishLabel }}</span><button class="finish-stub" @click="$emit(\'restart\')">完成</button></div>',
        },
      },
    },
  });
}

describe('DailyPracticeView', () => {
  afterEach(() => {
    vi.useRealTimers();
    historyMountMock.mockReset();
    vi.restoreAllMocks();
  });

  it('renders personalized and fixed questions as adjacent sections with the total formula', async () => {
    const fixed = {
      ...today().personalizedItems[0]!,
      ordinal: 2,
      source: 'ADMIN_FIXED' as const,
      questionId: 'q2',
      prompt: '固定题干',
      reason: '管理员指定',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(
        today({
          fixedItems: [fixed],
          counts: { personalized: 1, fixed: 1, total: 2 },
        }),
      ),
    );
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('个性化 1 题 + 固定 1 题 = 今日共 2 题');
    expect(wrapper.text()).toContain('个性化题干');
    expect(wrapper.text()).toContain('管理员指定');
    expect(wrapper.text()).toContain('固定题干');
    wrapper.unmount();
  });

  it('starts the active plan once and reuses QuizRunner with a daily finish label', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      if (url.endsWith('/daily-practice/today')) return response(today());
      if (url.endsWith('/daily-practice/plans/plan-1/start') && options?.method === 'POST') {
        return response({
          attemptId: 'attempt-1',
          planRevisionId: 'plan-1',
          questions: [],
        });
      }
      if (url.endsWith('/quizzes/attempts/attempt-1')) {
        return response(attemptLifecycle({ status: 'SCORING', revision: 7 }));
      }
      return response({}, 404);
    });
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const wrapper = mountView();
    await flushPromises();
    await wrapper.find('.status-actions .button').trigger('click');
    await flushPromises();

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/start'))).toHaveLength(1);
    const runner = wrapper.findComponent({ name: 'QuizRunner' });
    expect(runner.get('.finish-label').text()).toBe('返回今日练习');
    expect(runner.props('initialState')).toMatchObject({
      attemptId: 'attempt-1',
      planRevisionId: 'plan-1',
      status: 'SCORING',
      revision: 7,
      answers: { q1: ['A'] },
    });
    wrapper.unmount();
  });

  it('does not enter an empty runner when attempt lifecycle loading fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      if (url.endsWith('/daily-practice/today')) return response(today());
      if (url.endsWith('/daily-practice/plans/plan-1/start') && options?.method === 'POST') {
        return response({
          attemptId: 'attempt-1',
          planRevisionId: 'plan-1',
          questions: [],
        });
      }
      if (url.endsWith('/quizzes/attempts/attempt-1')) {
        return response({ message: '答题记录读取失败' }, 500);
      }
      return response({}, 404);
    });
    const wrapper = mountView();
    await flushPromises();
    await wrapper.find('.status-actions .button').trigger('click');
    await flushPromises();

    expect(wrapper.findComponent({ name: 'QuizRunner' }).exists()).toBe(false);
    expect(wrapper.text()).toContain('开始今日练习');
    wrapper.unmount();
  });

  it('aborts a pending daily-practice start when the view unmounts', async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      if (url.endsWith('/daily-practice/today')) return response(today());
      if (url.endsWith('/daily-practice/plans/plan-1/start')) {
        signal = options?.signal ?? undefined;
        return pending.promise;
      }
      return response({}, 404);
    });
    const wrapper = mountView();
    await flushPromises();
    await wrapper.find('.status-actions .button').trigger('click');
    await flushPromises();
    wrapper.unmount();

    expect(signal?.aborted).toBe(true);
    pending.resolve(response({
      attemptId: 'attempt-1',
      planRevisionId: 'plan-1',
      questions: [],
    }));
    await flushPromises();
  });

  it('keeps only one scheduled refresh loop while a plan is generating', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(today({ status: 'GENERATING', planRevisionId: null, counts: { personalized: 0, fixed: 0, total: 0 } })),
    );
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.text()).toContain('本页会自动刷新');

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('ignores an older today response that resolves after a newer refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
    const older = deferred<Response>();
    const newer = deferred<Response>();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(today()))
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    const wrapper = mountView();
    await flushPromises();
    const suggestion = wrapper.findComponent({ name: 'DailySuggestionForm' });

    suggestion.vm.$emit('conflict');
    suggestion.vm.$emit('conflict');
    newer.resolve(response(today({
      practiceDate: '2026-07-30',
      summary: {
        ...today().summary!,
        headline: '最新练习计划',
      },
    })));
    await flushPromises();
    older.resolve(response(today({
      practiceDate: '2026-07-29',
      summary: {
        ...today().summary!,
        headline: '过期练习计划',
      },
    })));
    await flushPromises();

    expect(wrapper.text()).toContain('练习日 2026-07-30');
    expect(wrapper.text()).toContain('最新练习计划');
    expect(wrapper.text()).not.toContain('过期练习计划');
    wrapper.unmount();
  });

  it('reloads at the server-provided next practice-day boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T19:59:55.000Z'));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(today()))
      .mockResolvedValueOnce(response(today({
        practiceDate: '2026-07-29',
        dayStartedAt: '2026-07-28T20:00:00.000Z',
        nextDayStartsAt: '2026-07-29T20:00:00.000Z',
      })));
    const wrapper = mountView();
    await flushPromises();

    await vi.advanceTimersByTimeAsync(5_050);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('练习日 2026-07-29');
    wrapper.unmount();
  });

  it('retries a failed rollover load without creating a tight refresh loop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T19:59:55.000Z'));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(today()))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response(today({
        practiceDate: '2026-07-29',
        dayStartedAt: '2026-07-28T20:00:00.000Z',
        nextDayStartsAt: '2026-07-29T20:00:00.000Z',
      })));
    const wrapper = mountView();
    await flushPromises();

    await vi.advanceTimersByTimeAsync(5_050);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(wrapper.text()).toContain('练习日 2026-07-29');
    wrapper.unmount();
  });

  it('retries when a successful rollover response still reports the old boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T19:59:55.000Z'));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(today()))
      .mockResolvedValueOnce(response(today()))
      .mockResolvedValueOnce(response(today({
        practiceDate: '2026-07-29',
        dayStartedAt: '2026-07-28T20:00:00.000Z',
        nextDayStartsAt: '2026-07-29T20:00:00.000Z',
      })));
    const wrapper = mountView();
    await flushPromises();

    await vi.advanceTimersByTimeAsync(5_050);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(wrapper.text()).toContain('练习日 2026-07-29');
    wrapper.unmount();
  });

  it('polls a stale plan until the service produces a recoverable revision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(today({ status: 'STALE', planRevisionId: null })),
    );
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('刷新状态');
    expect(wrapper.text()).toContain('题目状态已经变化');
    expect(wrapper.text()).not.toContain('预计 04:30 前完成');
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('remounts history after returning from a completed daily attempt', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      if (url.endsWith('/daily-practice/today')) return response(today());
      if (url.endsWith('/daily-practice/plans/plan-1/start') && options?.method === 'POST') {
        return response({ attemptId: 'attempt-1', planRevisionId: 'plan-1', questions: [] });
      }
      if (url.endsWith('/quizzes/attempts/attempt-1')) {
        return response(attemptLifecycle());
      }
      return response({}, 404);
    });
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const wrapper = mountView();
    await flushPromises();
    expect(historyMountMock).toHaveBeenCalledTimes(1);

    await wrapper.find('.status-actions .button').trigger('click');
    await flushPromises();
    await wrapper.get('.finish-stub').trigger('click');
    await flushPromises();

    expect(historyMountMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it.each([
    ['SERVICE_PAUSED', {
      status: 'SERVICE_PAUSED',
      service: { enabled: false, paused: true, reason: '暑假暂停', resumesAt: null, settingsRevision: 2 },
    }, '暑假暂停'],
    ['INITIALIZING', {
      status: 'INITIALIZING',
      initialization: { status: 'PROCESSING', appliedAttempts: 2, totalAttempts: 5 },
    }, '已处理 2 / 5 次答题'],
    ['PENDING', { status: 'PENDING', planRevisionId: null }, '今日计划正在生成。本页会自动刷新。'],
    ['PROCESSING', { status: 'PROCESSING', planRevisionId: null }, '今日计划正在生成。本页会自动刷新。'],
    ['PAUSED', {
      status: 'PAUSED',
      service: { enabled: true, paused: true, reason: '临时暂停', resumesAt: null, settingsRevision: 3 },
      attempt: { id: 'attempt-1', submittedAt: null, score: null, total: 1 },
    }, '继续练习'],
    ['NO_TEACHING_PROGRESS', { status: 'NO_TEACHING_PROGRESS' }, '还没有可用于今日练习的已学主题'],
    ['TERM_COMPLETED', { status: 'TERM_COMPLETED' }, '本学期两门课程的考试均已结束'],
    ['LIMITED_CONTENT', { status: 'LIMITED_CONTENT' }, '当前个性化题库不足 5 道'],
    ['NO_CONTENT', {
      status: 'NO_CONTENT', planRevisionId: null, personalizedItems: [], fixedItems: [],
      counts: { personalized: 0, fixed: 0, total: 0 },
    }, '今日暂无可用练习题'],
    ['DEGRADED_READY', { status: 'DEGRADED_READY' }, '今日计划使用回退策略生成'],
    ['FAILED', { status: 'FAILED', planRevisionId: null }, '今日计划生成失败'],
    ['STARTED', {
      status: 'STARTED',
      attempt: { id: 'attempt-1', submittedAt: null, score: null, total: 1 },
    }, '继续练习'],
  ] as const)('renders the %s state with its dedicated action or explanation', async (_status, overrides, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(today(overrides as Partial<DailyPracticeTodayResponse>)),
    );
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain(expected);
    wrapper.unmount();
  });

  it('marks a late-created task without promising the original 04:30 deadline', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(
        today({
          status: 'PENDING',
          supplemental: true,
          planRevisionId: null,
          counts: { personalized: 0, fixed: 0, total: 0 },
        }),
      ),
    );
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.text()).toContain('今日补建');
    expect(wrapper.text()).toContain('今日任务已补建，正在生成计划');
    expect(wrapper.text()).not.toContain('预计 04:30 前完成');
    wrapper.unmount();
  });

  it('refreshes today after another tab consumes the suggestion quota', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(
        today({ nextDayStartsAt: new Date(Date.now() + 86_400_000).toISOString() }),
      ),
    );
    const wrapper = mountView();
    await flushPromises();

    wrapper.findComponent({ name: 'DailySuggestionForm' }).vm.$emit('conflict');
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('links a completed practice directly to the wrong-question panel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(today({
      status: 'COMPLETED',
      attempt: {
        id: 'attempt-1',
        submittedAt: '2026-07-28T12:00:00.000Z',
        score: 1,
        total: 1,
      },
    })));
    const wrapper = mountView();
    await flushPromises();

    const wrongLink = wrapper.findAllComponents(RouterLinkStub)
      .find((link) => link.text() === '查看错题');
    expect(wrongLink?.props('to')).toBe('/quiz?mode=wrong');
    wrapper.unmount();
  });
});
