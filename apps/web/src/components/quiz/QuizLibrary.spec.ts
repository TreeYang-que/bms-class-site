import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetQuizFiltersCache } from '../../composables/useQuizFilters';
import QuizLibrary from './QuizLibrary.vue';
import type { QuizQuestionSummary } from '../../types';

const filtersPayload = {
  subjects: ['生理学', '病理学'],
  types: ['SINGLE', 'SHORT_ANSWER'],
  subjectGroups: [
    {
      subjectId: 'subject-1',
      subject: '生理学',
      pastPaperCount: 1,
      types: [
        {
          label: '单选题',
          gradingTypes: ['SINGLE'],
          total: 3,
          randomEligibleCount: 2,
          pastPaperCount: 1,
        },
        {
          label: '病例分析题',
          gradingTypes: ['SHORT_ANSWER'],
          total: 1,
          randomEligibleCount: 1,
          pastPaperCount: 0,
        },
      ],
      chapters: [
        {
          chapterId: 'chapter-1',
          chapter: '第一章',
          total: 3,
          randomEligibleCount: 2,
          pastPaperCount: 1,
          types: [
            {
              label: '单选题',
              gradingTypes: ['SINGLE'],
              total: 2,
              randomEligibleCount: 1,
              pastPaperCount: 1,
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
          chapterId: 'chapter-2',
          chapter: '第二章',
          total: 1,
          randomEligibleCount: 1,
          pastPaperCount: 0,
          types: [
            {
              label: '单选题',
              gradingTypes: ['SINGLE'],
              total: 1,
              randomEligibleCount: 1,
              pastPaperCount: 0,
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
          total: 2,
          randomEligibleCount: 2,
          pastPaperCount: 0,
        },
      ],
      chapters: [
        {
          chapterId: 'chapter-general',
          chapter: '总论',
          total: 2,
          randomEligibleCount: 2,
          pastPaperCount: 0,
          types: [
            {
              label: '识图题',
              gradingTypes: ['SINGLE'],
              total: 2,
              randomEligibleCount: 2,
              pastPaperCount: 0,
            },
          ],
        },
      ],
      pastPapers: [],
    },
  ],
};

let sequence = 0;

function makeQuestion(
  overrides: Partial<QuizQuestionSummary> = {},
): QuizQuestionSummary {
  sequence += 1;
  const id = overrides.id ?? `q${sequence}`;
  return {
    id,
    type: 'SINGLE',
    gradingType: 'SINGLE',
    typeLabel: '单选题',
    subjectId: 'subject-1',
    subject: '生理学',
    chapterIds: ['chapter-1'],
    chapter: '第一章',
    chapters: [
      {
        id: 'chapter-1',
        subjectId: 'subject-1',
        name: '第一章',
        slug: 'chapter-1',
        sortOrder: 1,
        active: true,
      },
    ],
    category: 'STANDARD',
    origin: 'MANUAL',
    prompt: `题干 ${id}`,
    options: [
      { id: 'A', text: '选项甲' },
      { id: 'B', text: '选项乙' },
    ],
    images: [],
    isPastPaper: false,
    pastPaper: null,
    paperOrder: null,
    maxScore: 1,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface MockConfig {
  total?: number;
  pageItems?: Record<number, QuizQuestionSummary[]>;
  failFirst?: boolean;
}

function mockFetch(config: MockConfig = {}) {
  let questionCalls = 0;
  const fetchMock = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/quizzes/filters')) return jsonResponse(filtersPayload);
      if (url.includes('/quizzes/start')) {
        return jsonResponse({ attemptId: 'attempt-x', questions: [] });
      }
      if (url.includes('/quizzes/questions')) {
        questionCalls += 1;
        if (config.failFirst && questionCalls === 1) {
          return jsonResponse({ message: '服务器错误' }, 500);
        }
        const parsed = new URL(url, 'http://localhost');
        const page = Number(parsed.searchParams.get('page') ?? '1');
        const pageSize = Number(parsed.searchParams.get('pageSize') ?? '20');
        const total = config.total ?? config.pageItems?.[page]?.length ?? 0;
        const items =
          config.pageItems?.[page] ??
          Array.from({ length: Math.min(pageSize, total) }, (_, index) =>
            makeQuestion({ id: `p${page}-q${index + 1}` }),
          );
        return jsonResponse({ items, total, page, pageSize });
      }
      return jsonResponse({ message: 'not found' }, 404);
    });
  return fetchMock;
}

async function mountLibrary() {
  const wrapper = mount(QuizLibrary);
  await flushPromises();
  return wrapper;
}

function questionUrls(fetchMock: ReturnType<typeof mockFetch>): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.includes('/quizzes/questions'))
    .map((url) => new URL(url, 'http://localhost'));
}

function startBody(fetchMock: ReturnType<typeof mockFetch>) {
  const call = fetchMock.mock.calls.find(([input]) =>
    String(input).includes('/quizzes/start'),
  );
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

function startButton(wrapper: ReturnType<typeof mount>) {
  return wrapper
    .findAll('button')
    .find((button) => button.text().includes('开始所选练习'));
}

async function selectQuestion(wrapper: ReturnType<typeof mount>, id: string) {
  const input = wrapper.find(`input[aria-label^="选择题目：题干 ${id}"]`);
  expect(input.exists()).toBe(true);
  await input.trigger('change');
}

describe('QuizLibrary', () => {
  afterEach(() => {
    resetQuizFiltersCache();
    vi.restoreAllMocks();
  });

  it('loads the first page with default params and renders questions without answers', async () => {
    const fetchMock = mockFetch({
      pageItems: {
        1: [
          makeQuestion({ id: 'q1', prompt: '肾小球滤过的主要动力是' }),
          makeQuestion({
            id: 'q2',
            prompt: '既往真题题干',
            isPastPaper: true,
            pastPaper: {
              id: 'paper-1',
              title: '2024 期末真题',
              subjectId: 'subject-1',
              subject: '生理学',
              year: 2024,
            },
            paperOrder: 3,
          }),
        ],
      },
      total: 2,
    });
    const wrapper = await mountLibrary();

    const urls = questionUrls(fetchMock);
    expect(urls[0]!.searchParams.get('page')).toBe('1');
    expect(urls[0]!.searchParams.get('pageSize')).toBe('20');
    expect(urls[0]!.searchParams.get('pastPaper')).toBeNull();

    expect(wrapper.text()).toContain('肾小球滤过的主要动力是');
    expect(wrapper.text()).toContain('往年真题 · 2024 期末真题（2024）');
    // 服务端不返回答案字段，界面也不得出现答案相关内容
    expect(wrapper.text()).not.toContain('正确答案');
    expect(wrapper.text()).not.toContain('解析');
  });

  it('sends subject, chapter, typeLabel, pastPaper and search params', async () => {
    const fetchMock = mockFetch({ total: 0 });
    const wrapper = await mountLibrary();

    await wrapper.find('#library-subject').setValue('subject-1');
    await flushPromises();
    await wrapper.find('#library-chapters').trigger('click');
    await wrapper
      .findAll('.chapter-select-option')
      .find((option) => option.text().includes('第一章'))!
      .trigger('click');
    await flushPromises();
    await wrapper.find('#library-type').setValue('病例分析题');
    await flushPromises();
    await wrapper.find('#library-comprehensive').setValue('true');
    await flushPromises();
    await wrapper.find('#library-past-paper').setValue('ONLY');
    await flushPromises();
    await wrapper.find('#library-search-input').setValue('滤过');
    await wrapper.find('.library-filters').trigger('submit');
    await flushPromises();

    const last = questionUrls(fetchMock).at(-1)!;
    expect(last.searchParams.get('subjectId')).toBe('subject-1');
    expect(last.searchParams.get('chapterIds')).toBe('chapter-1');
    expect(last.searchParams.get('chapterMatch')).toBe('ANY');
    expect(last.searchParams.get('typeLabel')).toBe('病例分析题');
    expect(last.searchParams.get('includeCrossChapter')).toBe('true');
    expect(last.searchParams.get('pastPaper')).toBe('ONLY');
    expect(last.searchParams.get('search')).toBe('滤过');
    expect(last.searchParams.get('page')).toBe('1');
    expect(
      wrapper
        .get('#library-search-input')
        .element.closest('.quiz-keyword-search'),
    ).not.toBeNull();
  });

  it('resets to page 1 when filters change after navigating', async () => {
    const fetchMock = mockFetch({ total: 60 });
    const wrapper = await mountLibrary();

    const next = wrapper
      .findAll('.pagination button')
      .find((button) => button.attributes('aria-label') === '下一页')!;
    await next.trigger('click');
    await flushPromises();
    expect(questionUrls(fetchMock).at(-1)!.searchParams.get('page')).toBe('2');

    await wrapper.find('#library-past-paper').setValue('EXCLUDE');
    await flushPromises();
    const last = questionUrls(fetchMock).at(-1)!;
    expect(last.searchParams.get('page')).toBe('1');
    expect(last.searchParams.get('pastPaper')).toBe('EXCLUDE');
  });

  it('clears the type label when the subject changes', async () => {
    const fetchMock = mockFetch({ total: 0 });
    const wrapper = await mountLibrary();
    await wrapper.find('#library-subject').setValue('subject-1');
    await flushPromises();
    await wrapper.find('#library-type').setValue('病例分析题');
    await flushPromises();
    expect(questionUrls(fetchMock).at(-1)!.searchParams.get('typeLabel')).toBe(
      '病例分析题',
    );
    await wrapper.find('#library-subject').setValue('subject-2');
    await flushPromises();
    const last = questionUrls(fetchMock).at(-1)!;
    expect(last.searchParams.get('subjectId')).toBe('subject-2');
    expect(last.searchParams.get('chapterIds')).toBeNull();
    expect(last.searchParams.get('typeLabel')).toBeNull();
    const typeSelect = wrapper.find('#library-type');
    expect(typeSelect.attributes()).not.toHaveProperty('disabled');
    await wrapper.find('#library-subject').setValue('');
    expect(wrapper.find('#library-type').attributes()).toHaveProperty(
      'disabled',
    );
  });

  it('selects and deselects every question on the current page', async () => {
    mockFetch({ total: 3 });
    const wrapper = await mountLibrary();
    const pageSelection = wrapper.get('.page-selection-button');

    expect(pageSelection.text()).toContain('全选本页');
    await pageSelection.trigger('click');
    expect(wrapper.find('.selection-count').text()).toContain('3');
    expect(wrapper.get('.page-selection-button').text()).toContain(
      '取消本页选择',
    );
    expect(
      wrapper
        .findAll('.question-select input')
        .every((input) => (input.element as HTMLInputElement).checked),
    ).toBe(true);

    await wrapper.get('.page-selection-button').trigger('click');
    expect(wrapper.find('.selection-count').text()).toContain('0');
    expect(wrapper.get('.page-selection-button').text()).toContain('全选本页');
  });

  it('keeps cross-page selections and submits them in selection order', async () => {
    const fetchMock = mockFetch({ total: 25 });
    const wrapper = await mountLibrary();

    await selectQuestion(wrapper, 'p1-q2');
    await selectQuestion(wrapper, 'p1-q1');
    expect(wrapper.find('.selection-count').text()).toContain('2');

    const next = wrapper
      .findAll('.pagination button')
      .find((button) => button.attributes('aria-label') === '下一页')!;
    await next.trigger('click');
    await flushPromises();
    await selectQuestion(wrapper, 'p2-q1');

    expect(wrapper.find('.selection-count').text()).toContain('3');
    const button = startButton(wrapper)!;
    expect(button.attributes()).not.toHaveProperty('disabled');
    await button.trigger('click');
    await flushPromises();

    const body = startBody(fetchMock);
    expect(body).toEqual({ questionIds: ['p1-q2', 'p1-q1', 'p2-q1'] });
    expect(Object.keys(body)).toEqual(['questionIds']);
    expect(wrapper.emitted('started')).toHaveLength(1);
  });

  it('allows deselecting questions and clearing the whole selection', async () => {
    mockFetch({ total: 2 });
    const wrapper = await mountLibrary();
    await selectQuestion(wrapper, 'p1-q1');
    await selectQuestion(wrapper, 'p1-q2');
    await selectQuestion(wrapper, 'p1-q1');
    expect(wrapper.find('.selection-count').text()).toContain('1');
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('清空选择'))!
      .trigger('click');
    expect(wrapper.find('.selection-count').text()).toContain('0');
    expect(startButton(wrapper)!.attributes()).toHaveProperty('disabled');
  });

  it('caps the selection at 100 questions and explains the limit', async () => {
    const pageItems: Record<number, QuizQuestionSummary[]> = {
      1: Array.from({ length: 50 }, (_, index) =>
        makeQuestion({ id: `a${index + 1}` }),
      ),
      2: Array.from({ length: 50 }, (_, index) =>
        makeQuestion({ id: `b${index + 1}` }),
      ),
      3: [makeQuestion({ id: 'c1' })],
    };
    mockFetch({ total: 101, pageItems });
    const wrapper = await mountLibrary();
    await wrapper.find('#library-page-size').setValue('50');
    await flushPromises();

    await wrapper.get('.page-selection-button').trigger('click');
    expect(wrapper.find('.selection-count').text()).toContain('50');

    const next = () =>
      wrapper
        .findAll('.pagination button')
        .find((button) => button.attributes('aria-label') === '下一页')!;
    await next().trigger('click');
    await flushPromises();
    await wrapper.get('.page-selection-button').trigger('click');
    expect(wrapper.find('.selection-count').text()).toContain('100');

    await next().trigger('click');
    await flushPromises();
    await wrapper.get('.page-selection-button').trigger('click');
    expect(wrapper.find('.selection-count').text()).toContain('100');
    expect(wrapper.find('.selection-hint').text()).toContain('达到 100 道上限');
    expect(wrapper.find('.selection-hint').text()).toContain('还有 1 道题未选择');
  }, 10_000);

  it('shows an error state and recovers on retry', async () => {
    mockFetch({ total: 1, failFirst: true });
    const wrapper = await mountLibrary();
    expect(wrapper.text()).toContain('服务器错误');

    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('重试'))!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('题干 p1-q1');
  });

  it('keeps the selection when starting fails so the user can retry', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/quizzes/filters'))
          return jsonResponse(filtersPayload);
        if (url.includes('/quizzes/start'))
          return jsonResponse({ message: '部分所选题目不存在或已停用' }, 422);
        return jsonResponse({ items: [makeQuestion({ id: 'q1' })], total: 1 });
      });
    const wrapper = await mountLibrary();
    await selectQuestion(wrapper, 'q1');
    await startButton(wrapper)!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('部分所选题目不存在或已停用');
    expect(wrapper.find('.selection-count').text()).toContain('1');
    expect(wrapper.emitted('started')).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
  });
});
