import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminQuiz from "./AdminQuiz.vue";
import AdminQuizCreate from "./AdminQuizCreate.vue";
import AdminQuizImport from "./AdminQuizImport.vue";

const subjectsPayload = [
  {
    id: "subject-1",
    name: "生理学",
    slug: "physiology",
    sortOrder: 10,
    active: true,
  },
  {
    id: "subject-2",
    name: "病理学",
    slug: "pathology",
    sortOrder: 20,
    active: true,
  },
];

const papersPayload = {
  items: [
    {
      id: "paper-1",
      title: "2024 级生理学期末真题",
      subjectId: "subject-1",
      subject: "生理学",
      year: 2024,
      questionCount: 30,
      typeLabels: ["单选题"],
    },
  ],
  total: 1,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = new URL(String(input), "http://localhost");
      if (
        url.pathname.includes("/subjects/") &&
        url.pathname.endsWith("/chapters")
      ) {
        return jsonResponse([]);
      }
      if (url.pathname.endsWith("/subjects")) {
        if (init?.method === "POST") {
          return jsonResponse(
            {
              id: "subject-3",
              name: "药理学",
              slug: "pharmacology",
              sortOrder: 30,
            },
            201,
          );
        }
        return jsonResponse(subjectsPayload);
      }
      if (url.pathname.endsWith("/quizzes/imports")) {
        return jsonResponse({ items: [], total: 0, page: 1, pageSize: 10 });
      }
      if (url.pathname.endsWith("/quizzes/papers"))
        return jsonResponse(papersPayload);
      if (url.pathname.endsWith("/quizzes/filters")) {
        return jsonResponse({ subjects: [], types: [], subjectGroups: [] });
      }
      if (url.pathname.endsWith("/quizzes/questions")) {
        return jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 });
      }
      return jsonResponse({ message: "not found" }, 404);
    });
}

async function mountAdminQuiz(props: {
  initialPane?: 'manage' | 'create' | 'import' | 'taxonomy';
  initialSubjectId?: string;
  active?: boolean;
} = {}) {
  const wrapper = mount(AdminQuiz, {
    props,
    global: { stubs: { AdminQuizCreate: true } },
  });
  await flushPromises();
  return wrapper;
}

async function openTab(wrapper: ReturnType<typeof mount>, label: string) {
  const tab = wrapper
    .findAll('[role="tab"]')
    .find((candidate) => candidate.text() === label);
  expect(tab).toBeDefined();
  await tab!.trigger("click");
  await flushPromises();
}

describe("AdminQuiz workspaces", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards the retained-pane activity state to background-reading workspaces", async () => {
    mockFetch();
    const importWrapper = await mountAdminQuiz({ initialPane: 'import', active: false });
    expect(importWrapper.findComponent(AdminQuizImport).props('active')).toBe(false);
    await importWrapper.setProps({ active: true });
    expect(importWrapper.findComponent(AdminQuizImport).props('active')).toBe(true);
    importWrapper.unmount();
  });

  it("creates a persisted subject and updates the single-question workspace", async () => {
    const fetchMock = mockFetch();
    const wrapper = await mountAdminQuiz();
    await openTab(wrapper, "学科章节");
    await wrapper.get('button[aria-label="新建学科"]').trigger("click");
    await wrapper.get("#quiz-subject-name").setValue("药理学");
    await wrapper.get("#quiz-subject-slug").setValue("pharmacology");
    await wrapper.get(".subject-form").trigger("submit");
    await flushPromises();

    const call = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes("/subjects") && init?.method === "POST",
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      name: "药理学",
      slug: "pharmacology",
    });
    await openTab(wrapper, "单题录入");
    expect(wrapper.findComponent(AdminQuizCreate).props("subjects")).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "药理学" })]),
    );
  });

  it("passes taxonomy and paper data into the import workspace", async () => {
    mockFetch();
    const wrapper = await mountAdminQuiz();
    await openTab(wrapper, "批量导入");

    const importer = wrapper.findComponent(AdminQuizImport);
    expect(importer.props("subjects")).toEqual(subjectsPayload);
    expect(importer.props("papers")).toEqual(papersPayload.items);
  });

  it("offers question management without the retired AI generation workspace", async () => {
    mockFetch();
    const wrapper = await mountAdminQuiz();
    expect(wrapper.findAll('[role="tab"]').map((tab) => tab.text())).toEqual([
      '题目管理', '单题录入', '批量导入', '学科章节',
    ]);
  });
});
