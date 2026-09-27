import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../stores/auth';
import AdminTeachingProgress from './AdminTeachingProgress.vue';

const topic = { id: 'sugar', title: '糖代谢', sessionDates: ['2030-09-24', '2030-09-28'], sourceRefs: ['synthetic-example-2', 'synthetic-example-3'], paused: false, taughtOnOverride: null, taughtOn: '2030-09-28', availableOn: '2030-09-29', learned: false };
const course = { id: 'course-1', subjectId: 's1', subject: { id: 's1', name: '医学分子细胞遗传基础', slug: 'medical-molecular-cell-genetics' }, termKey: 'example-term', startDate: '2030-08-31', examDate: '2031-01-06', enabled: true, revision: 3, topicHash: 'hash', topics: [topic], status: 'ACTIVE', eligibleQuestionCount: 7, mappingCounts: { PENDING: 0, PROCESSING: 0, READY: 7, NEEDS_REVIEW: 1, STALE: 0 } };
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function mockFetch(conflict = false) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === 'PATCH') return response(conflict ? { message: '课程已被其他管理员修改，请刷新后重试' } : course, conflict ? 409 : 200);
    if (url.endsWith('/history')) return response({ items: [{ id: 'h1', revision: 2, snapshot: { ...course, examDate: '2031-01-05' }, reason: '调整考试日期', createdAt: '2030-09-23T10:00:00Z', publishedById: 'admin' }] });
    if (url.endsWith('/curriculum')) return response({ practiceDate: '2030-09-24', initialized: true, courses: [course] });
    return response({ message: 'unexpected endpoint' }, 404);
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  useAuthStore().user = { id: 'admin', displayName: '管理员', role: 'ADMIN', status: 'ACTIVE' };
});
afterEach(() => vi.restoreAllMocks());

describe('AdminTeachingProgress curriculum', () => {
  it('uses the last lesson date and loads no knowledge-library sources', async () => {
    const fetchMock = mockFetch();
    const wrapper = mount(AdminTeachingProgress);
    await flushPromises();
    expect(wrapper.text()).toContain('2030-09-29 起可练习');
    expect(wrapper.text()).toContain('待学');
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/sources/') && !String(url).includes('/knowledge'))).toBe(true);
    const historyButton = wrapper.findAll('button').find((button) => button.text() === '修订历史')!;
    await historyButton.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('调整考试日期');
    wrapper.unmount();
  });

  it('submits date corrections with a revision and preserves all topic metadata', async () => {
    const fetchMock = mockFetch();
    const wrapper = mount(AdminTeachingProgress);
    await flushPromises();
    await wrapper.get('#topic-date-sugar').setValue('2030-09-30');
    expect(wrapper.text()).toContain('2030-10-01 起可练习');
    await wrapper.get('#course-change-reason').setValue('授课延后');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({ expectedRevision: 3, reason: '授课延后', topics: [expect.objectContaining({ id: 'sugar', taughtOnOverride: '2030-09-30', sessionDates: topic.sessionDates, sourceRefs: topic.sourceRefs })] });
    wrapper.unmount();
  });

  it('keeps unsaved corrections visible after a concurrent revision conflict', async () => {
    mockFetch(true);
    const wrapper = mount(AdminTeachingProgress);
    await flushPromises();
    await wrapper.get('#course-exam-date').setValue('2031-01-07');
    await wrapper.get('#course-change-reason').setValue('考试调整');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.text()).toContain('课程已被其他管理员修改');
    expect((wrapper.get('#course-exam-date').element as HTMLInputElement).value).toBe('2031-01-07');
    wrapper.unmount();
  });
});
