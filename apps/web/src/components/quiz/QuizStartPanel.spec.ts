import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetQuizFiltersCache } from '../../composables/useQuizFilters';
import QuizStartPanel from './QuizStartPanel.vue';

const confirmMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('../../composables/useConfirm', () => ({
  useConfirm: () => ({ confirm: confirmMock }),
}));

const filtersPayload = {
  subjects: ['生理学', '病理学'],
  types: ['SINGLE', 'SHORT_ANSWER'],
  subjectGroups: [
    {
      subjectId: 'subject-1',
      subject: '生理学',
      pastPaperCount: 4,
      types: [
        {
          label: '单选题',
          gradingTypes: ['SINGLE'],
          total: 5,
          randomEligibleCount: 5,
          pastPaperCount: 0,
        },
        {
          label: '病例分析题',
          gradingTypes: ['SHORT_ANSWER'],
          total: 3,
          randomEligibleCount: 1,
          pastPaperCount: 2,
        },
        {
          label: '真题论述题',
          gradingTypes: ['SHORT_ANSWER'],
          total: 2,
          randomEligibleCount: 0,
          pastPaperCount: 2,
        },
      ],
      chapters: [
        {
          chapterId: 'chapter-circulation',
          chapter: '循环',
          total: 3,
          randomEligibleCount: 3,
          pastPaperCount: 0,
          types: [
            {
              label: '单选题',
              gradingTypes: ['SINGLE'],
              total: 2,
              randomEligibleCount: 2,
              pastPaperCount: 0,
            },
            {
              label: '病例分析题',
              gradingTypes: ['SHORT_ANSWER'],
              total: 1,
              randomEligibleCount: 1,
              pastPaperCount: 0,
            },
          ],
        },
        {
          chapterId: 'chapter-respiration',
          chapter: '呼吸',
          total: 7,
          randomEligibleCount: 3,
          pastPaperCount: 4,
          types: [
            {
              label: '单选题',
              gradingTypes: ['SINGLE'],
              total: 3,
              randomEligibleCount: 3,
              pastPaperCount: 0,
            },
            {
              label: '病例分析题',
              gradingTypes: ['SHORT_ANSWER'],
              total: 2,
              randomEligibleCount: 0,
              pastPaperCount: 2,
            },
            {
              label: '真题论述题',
              gradingTypes: ['SHORT_ANSWER'],
              total: 2,
              randomEligibleCount: 0,
              pastPaperCount: 2,
            },
          ],
        },
      ],
      pastPapers: [],
    },
    {
      subjectId: 'subject-2',
      subject: '病理学',
      pastPaperCount: 0,
      types: [
        {
          label: '识图题',
          gradingTypes: ['SINGLE'],
          total: 4,
          randomEligibleCount: 4,
          pastPaperCount: 0,
        },
      ],
      chapters: [
        {
          chapterId: 'chapter-general',
          chapter: '总论',
          total: 4,
          randomEligibleCount: 4,
          pastPaperCount: 0,
          types: [
            {
              label: '识图题',
              gradingTypes: ['SINGLE'],
              total: 4,
              randomEligibleCount: 4,
              pastPaperCount: 0,
            },
          ],
        },
      ],
      pastPapers: [],
    },
  ],
};

function jsonResponse(payload: unknown, status = 200): Response {
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

function mockFetch(filtersOk = true) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/quizzes/filters')) {
      return filtersOk
        ? jsonResponse(filtersPayload)
        : jsonResponse({ message: '服务器错误' }, 500);
    }
    return jsonResponse({ attemptId: 'attempt-1', questions: [] });
  });
}

async function mountPanel() {
  const wrapper = mount(QuizStartPanel);
  await flushPromises();
  return wrapper;
}

async function clickStart(wrapper: ReturnType<typeof mount>) {
  const button = wrapper
    .findAll('button')
    .find((candidate) => candidate.text().includes('开始抽题'));
  expect(button).toBeDefined();
  await button?.trigger('click');
  await flushPromises();
}

function startRequestBody(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls.find(([input]) =>
    String(input).includes('/quizzes/start'),
  );
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

function findChip(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper
    .findAll('.type-chip')
    .find((chip) => chip.text().includes(label));
}

function findChapter(wrapper: ReturnType<typeof mount>, label: string) {
  return wrapper
    .findAll('.chapter-select-option')
    .find((option) => option.text().includes(label));
}

describe('QuizStartPanel', () => {
  afterEach(() => {
    resetQuizFiltersCache();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    vi.restoreAllMocks();
  });

  it('sends only count by default and never includes past papers unless asked', async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountPanel();
    await clickStart(wrapper);
    const body = startRequestBody(fetchMock);
    expect(body).toEqual({ count: 10 });
    expect(body).not.toHaveProperty('includePastPapers');
  });

  it('shows different type labels for different subjects', async () => {
    mockFetch();
    const wrapper = await mountPanel();
    expect(wrapper.find('.type-fieldset').exists()).toBe(false);

    await wrapper.find('#quiz-subject').setValue('subject-1');
    expect(wrapper.findAll('.type-chip').map((chip) => chip.text())).toEqual([
      expect.stringContaining('单选题'),
      expect.stringContaining('病例分析题'),
      expect.stringContaining('真题论述题'),
    ]);

    await wrapper.find('#quiz-subject').setValue('subject-2');
    const chips = wrapper.findAll('.type-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.text()).toContain('识图题');
  });

  it('clears type label selections that do not belong to the new subject', async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountPanel();
    await wrapper.find('#quiz-subject').setValue('subject-1');
    await findChip(wrapper, '病例分析题')!.trigger('click');
    await wrapper.find('#quiz-subject').setValue('subject-2');
    await clickStart(wrapper);
    const body = startRequestBody(fetchMock);
    expect(body).toEqual({ count: 10, subjectId: 'subject-2' });
    expect(body).not.toHaveProperty('typeLabels');
  });

  it('sends selected type labels as typeLabels array', async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountPanel();
    await wrapper.find('#quiz-subject').setValue('subject-1');
    await findChip(wrapper, '单选题')!.trigger('click');
    await findChip(wrapper, '病例分析题')!.trigger('click');
    await clickStart(wrapper);
    expect(startRequestBody(fetchMock)).toEqual({
      count: 10,
      subjectId: 'subject-1',
      typeLabels: ['单选题', '病例分析题'],
    });
  });

  it('sends chapter and includePastPapers only when explicitly enabled', async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountPanel();
    await wrapper.find('#quiz-subject').setValue('subject-1');
    await wrapper.find('#quiz-chapters').trigger('click');
    await findChapter(wrapper, '呼吸')!.trigger('click');
    const toggle = wrapper.find('.past-paper-toggle input');
    expect(toggle.exists()).toBe(true);
    await toggle.setValue(true);
    await clickStart(wrapper);
    expect(startRequestBody(fetchMock)).toEqual({
      count: 10,
      subjectId: 'subject-1',
      chapterIds: ['chapter-respiration'],
      chapterMatch: 'ANY',
      includePastPapers: true,
    });
  });

  it('sends ALL matching and the cross-chapter switch for multiple chapters', async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountPanel();
    await wrapper.find('#quiz-subject').setValue('subject-1');
    await wrapper.find('#quiz-chapters').trigger('click');
    await findChapter(wrapper, '循环')!.trigger('click');
    await findChapter(wrapper, '呼吸')!.trigger('click');
    await wrapper
      .findAll('.match-options button')
      .find((button) => button.text().includes('全部命中'))!
      .trigger('click');
    await wrapper.find('#quiz-comprehensive').setValue('true');
    await clickStart(wrapper);
    expect(startRequestBody(fetchMock)).toEqual({
      count: 10,
      subjectId: 'subject-1',
      chapterIds: ['chapter-circulation', 'chapter-respiration'],
      chapterMatch: 'ALL',
      includeCrossChapter: true,
    });
  });

  it('hides the past paper toggle for subjects without past papers', async () => {
    mockFetch();
    const wrapper = await mountPanel();
    await wrapper.find('#quiz-subject').setValue('subject-2');
    expect(wrapper.find('.past-paper-toggle').exists()).toBe(false);
  });

  it('disables types without random-eligible questions and enables them when past papers are included', async () => {
    mockFetch();
    const wrapper = await mountPanel();
    await wrapper.find('#quiz-subject').setValue('subject-1');

    const exclusiveChip = findChip(wrapper, '真题论述题')!;
    expect(exclusiveChip.attributes()).toHaveProperty('disabled');
    expect(exclusiveChip.text()).toContain('0 题');

    const caseChip = findChip(wrapper, '病例分析题')!;
    expect(caseChip.text()).toContain('1 题');

    await wrapper.find('.past-paper-toggle input').setValue(true);
    expect(findChip(wrapper, '真题论述题')!.attributes()).not.toHaveProperty(
      'disabled',
    );
    expect(findChip(wrapper, '真题论述题')!.text()).toContain('2 题');
    expect(findChip(wrapper, '病例分析题')!.text()).toContain('3 题');
  });

  it('disables the start button when count exceeds the backend limit of 100', async () => {
    mockFetch();
    const wrapper = await mountPanel();
    await wrapper.find('#question-count').setValue(101);
    const button = wrapper
      .findAll('button')
      .find((candidate) => candidate.text().includes('开始抽题'))!;
    expect(button.attributes()).toHaveProperty('disabled');
  });

  it('still allows starting with defaults when filter metadata fails to load', async () => {
    const fetchMock = mockFetch(false);
    const wrapper = await mountPanel();
    expect(wrapper.find('.filters-alert').exists()).toBe(true);
    expect(wrapper.find('.retry-button').exists()).toBe(true);
    await clickStart(wrapper);
    expect(startRequestBody(fetchMock)).toEqual({ count: 10 });
  });

  it('disables filter controls while filter metadata is loading', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>(() => {}),
    );
    const wrapper = mount(QuizStartPanel);
    await wrapper.vm.$nextTick();
    const subject = wrapper.find('#quiz-subject').element as HTMLSelectElement;
    expect(subject.disabled).toBe(true);
  });

  it('aborts the active-attempt read when the panel unmounts', async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('/quizzes/filters'))
        return jsonResponse(filtersPayload);
      signal = init?.signal ?? undefined;
      return pending.promise;
    });
    const wrapper = mount(QuizStartPanel);
    await wrapper.vm.$nextTick();

    wrapper.unmount();
    expect(signal?.aborted).toBe(true);
    pending.resolve(jsonResponse({ items: [] }));
    await flushPromises();
  });

  it('shows at most five resumable attempts and emits the selected lifecycle', async () => {
    const attempts = Array.from({ length: 6 }, (_, index) => ({
      attemptId: `attempt-${index + 1}`,
      status: index === 0 ? 'SCORING' : 'DRAFT',
      revision: index,
      position: 0,
      answers: index === 0 ? { q1: ['A'] } : {},
      questions: [{ id: 'q1' }],
      savedAt: '2026-08-10T02:00:00.000Z',
      expiresAt: '2026-08-17T02:00:00.000Z',
      score: null,
      total: 1,
      results: null,
      gradingError: null,
    }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/quizzes/filters')
        ? jsonResponse(filtersPayload)
        : jsonResponse({ items: attempts }),
    );

    const wrapper = await mountPanel();
    expect(wrapper.findAll('.draft-item')).toHaveLength(5);
    expect(wrapper.findAll('.draft-item')[0]!.text()).toContain('评分中');
    expect(
      wrapper.findAll('.draft-item')[0]!.findAll('button')[1]!.attributes(
        'disabled',
      ),
    ).toBeDefined();

    await wrapper
      .findAll('.draft-item')[1]!
      .findAll('button')[0]!
      .trigger('click');
    expect(wrapper.emitted('started')?.[0]?.[0]).toMatchObject({
      attemptId: 'attempt-2',
      revision: 1,
    });
  });

  it('keeps abandon busy state scoped to one attempt and removes it on success', async () => {
    confirmMock.mockResolvedValue(true);
    const attempts = ['attempt-1', 'attempt-2'].map((attemptId) => ({
      attemptId,
      status: 'DRAFT',
      revision: 0,
      position: 0,
      answers: {},
      questions: [{ id: 'q1' }],
      savedAt: '2026-08-10T02:00:00.000Z',
      expiresAt: '2026-08-17T02:00:00.000Z',
      score: null,
      total: 1,
      results: null,
      gradingError: null,
    }));
    let resolveAbandon!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/quizzes/filters')) return jsonResponse(filtersPayload);
      if ((init?.method ?? 'GET') === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveAbandon = resolve;
        });
      }
      return jsonResponse({ items: attempts });
    });
    const wrapper = await mountPanel();

    await wrapper
      .findAll('.draft-item')[0]!
      .findAll('button')[1]!
      .trigger('click');
    await flushPromises();
    const firstButtons = wrapper.findAll('.draft-item')[0]!.findAll('button');
    const secondButtons = wrapper.findAll('.draft-item')[1]!.findAll('button');
    expect(firstButtons[1]!.text()).toContain('正在放弃');
    expect(firstButtons[0]!.attributes('disabled')).toBeDefined();
    expect(secondButtons[0]!.attributes('disabled')).toBeUndefined();

    resolveAbandon(jsonResponse({ attemptId: 'attempt-1', abandoned: true }));
    await flushPromises();
    expect(wrapper.findAll('.draft-item')).toHaveLength(1);
  });

  it('refreshes active attempts when abandon returns 409', async () => {
    confirmMock.mockResolvedValue(true);
    let activeLoads = 0;
    const draft = {
      attemptId: 'attempt-conflict',
      status: 'DRAFT',
      revision: 0,
      position: 0,
      answers: {},
      questions: [{ id: 'q1' }],
      savedAt: '2026-08-10T02:00:00.000Z',
      expiresAt: '2026-08-17T02:00:00.000Z',
      score: null,
      total: 1,
      results: null,
      gradingError: null,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/quizzes/filters')) return jsonResponse(filtersPayload);
      if ((init?.method ?? 'GET') === 'POST') {
        return jsonResponse({ message: '答题状态已变化，请刷新' }, 409);
      }
      activeLoads += 1;
      return jsonResponse({
        items: activeLoads === 1 ? [draft] : [{ ...draft, status: 'SCORING' }],
      });
    });
    const wrapper = await mountPanel();
    await wrapper.get('.draft-item .danger-action').trigger('click');
    await flushPromises();

    expect(activeLoads).toBe(2);
    expect(wrapper.get('.draft-item').text()).toContain('评分中');
    expect(
      wrapper.get('.draft-item .danger-action').attributes('disabled'),
    ).toBeDefined();
  });
});
