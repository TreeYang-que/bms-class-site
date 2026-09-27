import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminQuestionMappings from './AdminQuestionMappings.vue';

const course = {
  id: 'course', subjectId: 'subject', subject: { id: 'subject', name: '医学分子细胞遗传基础', slug: 'mcg' },
  topics: [
    { id: 'membrane', title: '细胞膜', learned: true, paused: false, availableOn: '2026-09-12' },
    { id: 'nucleus', title: '细胞核', learned: false, paused: false, availableOn: '2026-09-24' },
  ],
  mappingCounts: { PENDING: 0, PROCESSING: 0, READY: 0, NEEDS_REVIEW: 1, STALE: 0 },
};
const mapping = { questionId: 'question', courseId: 'course', question: { id: 'question', prompt: '比较细胞膜与细胞核', typeLabel: '简答题', contentRevision: 2 }, status: 'NEEDS_REVIEW', topicIds: ['membrane'], reason: '需确认跨主题范围', confidence: 0.5, manual: false, revision: 3, contentRevision: 2, stale: false, updatedAt: '2026-09-24T01:00:00Z' };
function response(value: unknown) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
function mockFetch(stale = false) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (String(input).endsWith('/curriculum')) return response({ practiceDate: '2026-09-24', initialized: true, courses: [course] });
    if (String(input).endsWith('/quizzes/questions/question')) return response({ ...mapping.question, gradingType: 'SHORT_ANSWER', correctAnswer: ['完整参考答案'], explanation: '完整解析', images: [], options: [] });
    if (init?.method === 'PATCH') return response(mapping);
    return response({ items: [{ ...mapping, ...(stale ? { status: 'READY', stale: true } : {}) }], total: 1, page: 1, pageSize: 20 });
  });
}

afterEach(() => vi.restoreAllMocks());

describe('AdminQuestionMappings', () => {
  it('submits the full multi-topic selection and the viewed revision', async () => {
    const fetchMock = mockFetch();
    const wrapper = mount(AdminQuestionMappings, { global: { stubs: { teleport: true } } });
    await flushPromises();
    await wrapper.findAll('button').find((button) => button.text() === '校正主题')!.trigger('click');
    await flushPromises();
    expect(wrapper.get('[role=dialog]').text()).toContain('完整参考答案');
    expect(wrapper.get('[role=dialog]').text()).toContain('完整解析');
    await wrapper.get('#mapping-topic-search').setValue('细胞核');
    expect(wrapper.find('input[value=membrane]').exists()).toBe(false);
    await wrapper.get('input[value="nucleus"]').setValue(true);
    await wrapper.get('#mapping-reason').setValue('必须同时掌握细胞膜与细胞核');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(request[1]?.body))).toEqual({ expectedRevision: 3, expectedContentRevision: 2, topicIds: ['membrane', 'nucleus'], reason: '必须同时掌握细胞膜与细胞核' });
    wrapper.unmount();
  });

  it('does not present a stale READY mapping as a current successful match', async () => {
    mockFetch(true);
    const wrapper = mount(AdminQuestionMappings, { global: { stubs: { teleport: true } } });
    await flushPromises();
    expect(wrapper.get('.mapping-list .mapping-tags').text()).toContain('需重新匹配');
    expect(wrapper.get('.mapping-list .mapping-tags').text()).not.toContain('已匹配');
    wrapper.unmount();
  });
});
