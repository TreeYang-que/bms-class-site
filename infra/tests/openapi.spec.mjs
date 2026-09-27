import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseDocument } from "yaml";

const openApiUrl = new URL(
  "../../packages/contracts/openapi.yaml",
  import.meta.url,
);

async function loadContract() {
  const source = await readFile(openApiUrl, "utf8");
  const document = parseDocument(source, { uniqueKeys: true });
  assert.deepEqual(
    document.errors.map((error) => error.message),
    [],
    "OpenAPI YAML must parse without duplicate keys",
  );
  return document.toJS();
}

test("OpenAPI preserves authentication, role and lifecycle response contracts", async () => {
  const contract = await loadContract();
  assert.equal(contract.openapi, "3.1.0");

  assert.deepEqual(contract.paths["/health"].get.security, []);
  assert.deepEqual(contract.paths["/health/ready"].get.security, []);
  assert.ok(contract.paths["/health/ready"].get.responses["503"]);
  assert.equal(
    contract.paths["/albums/photos/{id}/content"].get.deprecated,
    true,
  );
  assert.deepEqual(contract.paths["/invites"].post["x-required-roles"], [
    "ADMIN",
  ]);
  assert.deepEqual(contract.paths["/news/manage"].get["x-required-roles"], [
    "EDITOR",
    "ADMIN",
  ]);
  assert.ok(contract.paths["/news/{id}"].patch.responses["409"]);
  assert.equal(contract.paths["/quizzes/questions/import"], undefined);
  for (const [path, method, roles] of [
    ["/quizzes/imports", "get", ["EDITOR", "ADMIN"]],
    ["/quizzes/imports", "post", ["EDITOR", "ADMIN"]],
    ["/quizzes/imports/orphans", "get", ["ADMIN"]],
    ["/quizzes/imports/{id}", "get", ["EDITOR", "ADMIN"]],
    ["/quizzes/imports/{id}/confirm", "post", ["EDITOR", "ADMIN"]],
    ["/quizzes/imports/{id}/cancel", "post", ["EDITOR", "ADMIN"]],
    ["/quizzes/imports/{id}/issues.csv", "get", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/test-access", "get", ["ADMIN"]],
    ["/admin/daily-practice/test-access/{userId}", "patch", ["ADMIN"]],
    ["/admin/daily-practice/settings", "get", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/settings", "patch", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/service-pauses", "get", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/service-pauses", "post", ["EDITOR", "ADMIN"]],
    [
      "/admin/daily-practice/service-pauses/{id}/cancel",
      "post",
      ["EDITOR", "ADMIN"],
    ],
    ["/admin/daily-practice/teaching-progress", "get", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/curriculum", "get", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/curriculum/initialize", "post", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/curriculum/{id}", "patch", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/curriculum/{id}/history", "get", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/curriculum/{id}/queue-mappings", "post", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/question-mappings", "get", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/question-mappings/{id}", "patch", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/question-mappings/{id}/retry", "post", ["EDITOR", "ADMIN"]],
    [
      "/admin/daily-practice/teaching-progress/{id}",
      "get",
      ["EDITOR", "ADMIN"],
    ],
    [
      "/admin/daily-practice/fixed-question-candidates",
      "get",
      ["EDITOR", "ADMIN"],
    ],
    [
      "/admin/daily-practice/fixed-assignments/{practiceDate}",
      "get",
      ["EDITOR", "ADMIN"],
    ],
    ["/admin/daily-practice/fixed-assignments", "post", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/cycles/{practiceDate}", "get", ["EDITOR", "ADMIN"]],
    ["/admin/daily-practice/cycles", "get", ["EDITOR", "ADMIN"]],
    [
      "/admin/daily-practice/cycles/{practiceDate}/refreeze",
      "post",
      ["EDITOR", "ADMIN"],
    ],
    ["/admin/daily-practice/users", "get", ["ADMIN"]],
    ["/admin/daily-practice/users/{userId}", "get", ["ADMIN"]],
    ["/admin/daily-practice/users/{userId}/suggestions", "post", ["ADMIN"]],
    [
      "/admin/daily-practice/users/{userId}/plans/{practiceDate}/regenerate",
      "post",
      ["ADMIN"],
    ],
    [
      "/admin/daily-practice/users/{userId}/plans/{practiceDate}/preview",
      "post",
      ["ADMIN"],
    ],
    ["/admin/credit-hours/submissions", "get", ["ADMIN"]],
    ["/admin/credit-hours/submissions", "post", ["ADMIN"]],
    ["/admin/credit-hours/submissions/{id}", "get", ["ADMIN"]],
    ["/admin/credit-hours/evidence/{id}/original", "get", ["ADMIN"]],
    ["/admin/credit-hours/overview", "get", ["ADMIN"]],
    ["/admin/credit-hours/exports/approved.zip", "get", ["ADMIN"]],
    ["/admin/credit-hours/runtime", "get", ["ADMIN"]],
    ["/admin/credit-hours/operations/{id}", "get", ["ADMIN"]],
    ["/admin/credit-hours/operations/{id}/resume", "post", ["ADMIN"]],
    ["/admin/credit-hours/submissions/{id}/decisions", "post", ["ADMIN"]],
    ["/admin/credit-hours/submissions/{id}/reopen", "post", ["ADMIN"]],
    ["/admin/credit-hours/submissions/{id}/ai-retry", "post", ["ADMIN"]],
    ["/admin/credit-hours/submissions/{id}/deletion", "post", ["ADMIN"]],
    ["/admin/credit-hours/initializations/preflight", "post", ["ADMIN"]],
  ]) {
    assert.deepEqual(contract.paths[path][method]["x-required-roles"], roles);
  }
  for (const path of [
    "/auth/change-password",
    "/invites",
    "/quizzes/history",
    "/quizzes/wrong",
  ]) {
    const method =
      path === "/invites" || path === "/auth/change-password" ? "post" : "get";
    assert.ok(contract.paths[path][method].responses["401"]);
  }
  assert.ok(contract.paths["/quizzes/{attemptId}/submit"].post.responses["202"]);
  assert.ok(contract.paths["/quizzes/{attemptId}/submit"].post.responses["409"]);
  assert.ok(
    contract.paths["/quizzes/attempts/{attemptId}/draft"].patch.responses[
      "409"
    ],
  );
});

test('curriculum selection replaces question generation without removing historical quiz contracts', async () => {
  const contract = await loadContract();
  const schemas = contract.components.schemas;
  assert.equal(Object.keys(contract.paths).some((path) => /^\/ai\/question-(generation|reviews)/u.test(path)), false);
  assert.equal(Object.keys(schemas).some((name) => name.startsWith('AiQuestion')), false);
  assert.equal(contract.paths['/admin/daily-practice/teaching-progress'].post, undefined);
  assert.ok(contract.paths['/admin/daily-practice/teaching-progress'].get);
  assert.ok(contract.paths['/quizzes/attempts/{attemptId}'].get);
  assert.ok(contract.paths['/quizzes/{attemptId}/submit'].post);
  assert.ok(schemas.DailyPracticeTodayStatus.enum.includes('TERM_COMPLETED'));
  assert.equal(schemas.DailyPracticeToday.properties.curriculum.$ref, '#/components/schemas/PracticeCurriculumResponse');
  assert.equal(schemas.QuizWrongItem.properties.retired.type, 'boolean');
  assert.equal(schemas.QuizPaperSummary.allOf[1].properties.retiredQuestionCount.minimum, 0);
  const parameters = contract.paths['/admin/daily-practice/fixed-question-candidates'].get.parameters;
  assert.equal(parameters.find((parameter) => parameter.name === 'practiceDate').schema.format, 'date');
  assert.equal(schemas.PracticeCourseUpdateRequest.properties.expectedRevision.minimum, 1);
  assert.equal(schemas.PracticeQuestionMappingUpdateRequest.properties.topicIds.uniqueItems, true);
  assert.equal(schemas.PracticeQuestionMappingView.additionalProperties, false);
  assert.equal(schemas.PracticeQuestionMappingView.properties.leaseOwnerToken, undefined);
});

test("all local OpenAPI references resolve", async () => {
  const contract = await loadContract();
  const references = [];

  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string") references.push(value.$ref);
    for (const child of Object.values(value)) visit(child);
  };
  visit(contract);

  for (const reference of references) {
    assert.match(
      reference,
      /^#\//,
      `external reference is not allowed: ${reference}`,
    );
    const target = reference
      .slice(2)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((value, part) => value?.[part], contract);
    assert.ok(target, `unresolved reference: ${reference}`);
  }
});

test("phase nine contracts retain authorization, manual review and atomic batch boundaries", async () => {
  const contract = await loadContract();
  const schemas = contract.components.schemas;
  const batch = contract.paths["/admin/credit-hours/submission-batches"].post;
  assert.deepEqual(batch["x-required-roles"], ["ADMIN"]);
  assert.equal(batch.parameters[0].$ref, "#/components/parameters/IdempotencyKey");
  assert.equal(contract.components.parameters.IdempotencyKey.required, true);
  const entries = schemas.AdminCreditHourBatchCreateRequest.properties.entries;
  assert.equal(entries.minItems, 1);
  assert.equal(entries.maxItems, 100);
  assert.deepEqual(entries.items.properties.hours, {
    type: "number", minimum: 0.5, maximum: 1000, multipleOf: 0.5,
  });
  assert.ok(schemas.CreditHourSubmissionStatus.enum.includes("PENDING_MANUAL_REVIEW"));
  assert.equal(schemas.CreditHourSubmission.properties.manualReview.anyOf[0].$ref, "#/components/schemas/CreditHourManualReview");
  assert.deepEqual(contract.paths["/albums/{id}/originals.zip"].get["x-required-roles"], ["EDITOR", "ADMIN"]);
  assert.equal(schemas.PhotoItem.properties.originalAvailable.type, "boolean");
  for (const path of ["/admin/announcements", "/admin/announcements/{id}", "/admin/announcements/{id}/publish", "/admin/announcements/{id}/withdraw"]) {
    for (const [method, operation] of Object.entries(contract.paths[path])) {
      if (method !== "parameters") assert.deepEqual(operation["x-required-roles"], ["ADMIN"]);
    }
  }
  assert.equal(schemas.AnnouncementAction.properties.expectedRevision.minimum, 1);
  assert.equal(schemas.AnnouncementDraft.properties.body.maxLength, 20000);
  assert.ok(contract.paths["/announcements/{id}/read"].post.responses["201"]);
});

test("administrator daily-practice responses are strict bounded summaries", async () => {
  const contract = await loadContract();
  const schemas = contract.components.schemas;
  for (const name of [
    "DailyPracticeFixedAssignment",
    "DailyPracticeFixedAssignmentEnvelope",
    "AdminDailyPracticeUserSummary",
    "AdminDailyPracticeStateEntry",
    "AdminDailyPracticeCandidateQuestion",
    "AdminDailyPracticeFrozenFixedQuestion",
    "AdminDailyPracticeTodayPlan",
    "AdminDailyPracticeUserDetail",
  ]) {
    assert.equal(
      schemas[name].additionalProperties,
      false,
      `${name} must reject undeclared response fields`,
    );
  }

  const fixedEnvelope = schemas.DailyPracticeFixedAssignmentEnvelope;
  assert.equal(fixedEnvelope.properties.history.maxItems, 50);
  assert.ok(fixedEnvelope.required.includes("historyTotal"));

  const detail = schemas.AdminDailyPracticeUserDetail;
  for (const [field, maximum] of [
    ["knowledgeStates", 100],
    ["chapterStates", 100],
    ["planRevisions", 50],
    ["suggestions", 50],
  ]) {
    assert.equal(detail.properties[field].maxItems, maximum);
    assert.ok(detail.required.includes(`${field}Total`));
  }
});
