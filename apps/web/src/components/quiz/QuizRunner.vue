<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  LoaderCircle,
  RotateCw,
  Send,
  XCircle,
} from 'lucide-vue-next';
import StatusBadge from '../common/StatusBadge.vue';
import QuizQuestionImages from './QuizQuestionImages.vue';
import {
  ApiClientError,
  api,
  formatError,
  isAbortError,
} from '../../lib/api';
import {
  answeredCount,
  optionTexts,
  setShortAnswer,
  toggleAnswer,
} from '../../lib/quiz';
import { labelOf, questionTypeLabels } from '../../lib/labels';
import { useConfirm } from '../../composables/useConfirm';
import { useToast } from '../../composables/useToast';
import type {
  QuizAnswerMap,
  QuizAttemptLifecycle,
  QuizAttemptStatus,
  QuizDraftSaveResponse,
  QuizQuestion,
  QuizResult,
  QuizSubmissionResponse,
  QuizSubmitResponse,
} from '../../types';

type QuizAttemptState = Partial<
  Pick<
    QuizAttemptLifecycle,
    | 'status'
    | 'revision'
    | 'position'
    | 'answers'
    | 'savedAt'
    | 'score'
    | 'total'
    | 'results'
    | 'gradingError'
  >
>;

const props = withDefaults(
  defineProps<{
    attemptId: string;
    questions: QuizQuestion[];
    finishLabel?: string;
    initialState?: QuizAttemptState;
  }>(),
  { finishLabel: '返回题库', initialState: () => ({}) },
);
const emit = defineEmits<{
  restart: [];
  submitted: [result: QuizSubmitResponse];
}>();

const toast = useToast();
const { confirm } = useConfirm();

const current = ref(
  Math.min(
    Math.max(0, props.initialState.position ?? 0),
    Math.max(0, props.questions.length - 1),
  ),
);
const answers = ref<QuizAnswerMap>({ ...(props.initialState.answers ?? {}) });
const results = ref<QuizResult[] | null>(props.initialState.results ?? null);
const score = ref<number | null>(props.initialState.score ?? null);
const total = ref<number | null>(props.initialState.total ?? null);
const lifecycleStatus = ref<QuizAttemptStatus>(
  props.initialState.status ?? (results.value ? 'SUBMITTED' : 'DRAFT'),
);
const revision = ref(props.initialState.revision ?? 0);
const savedAt = ref<string | null>(props.initialState.savedAt ?? null);
const gradingError = ref<string | null>(props.initialState.gradingError ?? null);
const pollError = ref('');
const submitting = ref(false);
const reloading = ref(false);
const dirty = ref(false);
const saveState = ref<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>(
  'idle',
);
const saveError = ref('');
let saveTimer: number | undefined;
let saveInFlight: Promise<boolean> | null = null;
let flushInFlight: Promise<boolean> | null = null;
let changeVersion = 0;
let ignoreChanges = false;
let pollTimer: number | undefined;
let pollInFlight = false;
let alive = true;
const requestControllers = new Set<AbortController>();

function ownsAttempt(attemptId: string) {
  return alive && props.attemptId === attemptId;
}

async function requestForAttempt<T>(
  attemptId: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  if (!ownsAttempt(attemptId)) {
    throw new DOMException('组件已卸载', 'AbortError');
  }
  const controller = new AbortController();
  requestControllers.add(controller);
  try {
    return await api<T>(path, { ...options, signal: controller.signal });
  } finally {
    requestControllers.delete(controller);
  }
}

function abortRequests() {
  for (const controller of requestControllers) controller.abort();
  requestControllers.clear();
}

const question = computed(() => props.questions[current.value]!);
const done = computed(() => answeredCount(props.questions, answers.value));
const submitted = computed(() => results.value !== null);
const incorrectQuestionIds = computed(
  () => new Set(
    (results.value ?? [])
      .filter((result) => result.score < result.maxScore)
      .map((result) => result.questionId),
  ),
);
const scoring = computed(() => lifecycleStatus.value === 'SCORING');
const scoringFailed = computed(
  () => lifecycleStatus.value === 'SCORING_FAILED',
);
const abandoned = computed(() => lifecycleStatus.value === 'ABANDONED');
const answersLocked = computed(
  () =>
    submitting.value ||
    lifecycleStatus.value === 'SUBMITTED' ||
    submitted.value ||
    scoring.value ||
    scoringFailed.value ||
    abandoned.value,
);

const saveStatusText = computed(() => {
  if (saveState.value === 'saving') return '正在保存…';
  if (saveState.value === 'saved') return '已保存';
  if (saveState.value === 'error') return '保存失败';
  if (saveState.value === 'conflict') return '草稿冲突';
  if (dirty.value) return '尚未保存';
  return savedAt.value ? '已保存' : '等待作答';
});

function clearSaveTimer() {
  if (saveTimer === undefined) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
}

function scheduleDraftSave() {
  clearSaveTimer();
  if (
    !alive ||
    lifecycleStatus.value !== 'DRAFT' ||
    saveState.value === 'conflict'
  )
    return;
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void persistDraft();
  }, 500);
}

async function persistDraft(): Promise<boolean> {
  if (lifecycleStatus.value !== 'DRAFT' || !dirty.value) return true;
  if (saveInFlight) {
    const previousSaved = await saveInFlight;
    if (!previousSaved || !dirty.value) return previousSaved;
  }

  const savedVersion = changeVersion;
  const attemptId = props.attemptId;
  saveState.value = 'saving';
  saveError.value = '';
  const request = requestForAttempt<QuizDraftSaveResponse>(
    attemptId,
    `/quizzes/attempts/${encodeURIComponent(attemptId)}/draft`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        revision: revision.value,
        position: current.value,
        answers: answers.value,
      }),
    },
  )
    .then((data) => {
      if (!ownsAttempt(attemptId) || data.attemptId !== attemptId) return false;
      revision.value = data.revision;
      savedAt.value = data.savedAt;
      if (changeVersion === savedVersion) {
        dirty.value = false;
        saveState.value = 'saved';
      } else {
        dirty.value = true;
        saveState.value = 'idle';
        scheduleDraftSave();
      }
      return true;
    })
    .catch((caught: unknown) => {
      if (!ownsAttempt(attemptId) || isAbortError(caught)) return false;
      dirty.value = true;
      if (caught instanceof ApiClientError && caught.status === 409) {
        saveState.value = 'conflict';
        saveError.value = '草稿已在其他页面更新，请重新载入服务器版本。';
      } else {
        saveState.value = 'error';
        saveError.value = formatError(caught, '草稿保存失败，请重试');
      }
      return false;
    })
    .finally(() => {
      if (saveInFlight === request) saveInFlight = null;
    });
  saveInFlight = request;
  return request;
}

function flushDraft(): Promise<boolean> {
  if (flushInFlight) return flushInFlight;
  const request = (async () => {
    clearSaveTimer();
    while (lifecycleStatus.value === 'DRAFT' && dirty.value) {
      const saved = await persistDraft();
      if (!saved) return false;
    }
    return true;
  })().finally(() => {
    if (flushInFlight === request) flushInFlight = null;
  });
  flushInFlight = request;
  return request;
}

async function applyAttemptState(attempt: QuizAttemptLifecycle) {
  if (!ownsAttempt(attempt.attemptId)) return false;
  ignoreChanges = true;
  lifecycleStatus.value = attempt.status;
  revision.value = attempt.revision;
  answers.value = { ...attempt.answers };
  current.value = Math.min(
    Math.max(0, attempt.position),
    Math.max(0, props.questions.length - 1),
  );
  savedAt.value = attempt.savedAt;
  score.value = attempt.score;
  total.value = attempt.total;
  results.value = attempt.results;
  gradingError.value = attempt.gradingError;
  pollError.value = '';
  dirty.value = false;
  saveState.value = 'saved';
  await nextTick();
  ignoreChanges = false;
  if (!ownsAttempt(attempt.attemptId)) return false;
  return true;
}

async function reloadAttempt() {
  if (reloading.value) return;
  if (dirty.value) {
    const ok = await confirm({
      title: '重新载入答题草稿',
      body: '服务器版本会覆盖当前未保存的答案。',
      confirmText: '重新载入',
      danger: true,
    });
    if (!ok) return;
  }
  reloading.value = true;
  const attemptId = props.attemptId;
  try {
    const attempt = await requestForAttempt<QuizAttemptLifecycle>(
      attemptId,
      `/quizzes/attempts/${encodeURIComponent(attemptId)}`,
    );
    if (!(await applyAttemptState(attempt))) return;
    if (attempt.status === 'SCORING') schedulePoll();
  } catch (caught) {
    if (!ownsAttempt(attemptId) || isAbortError(caught)) return;
    toast.error(formatError(caught, '答题草稿重新载入失败'));
  } finally {
    if (ownsAttempt(attemptId)) reloading.value = false;
  }
}

function applySubmitted(data: QuizSubmitResponse, attemptId = props.attemptId) {
  if (!ownsAttempt(attemptId)) return false;
  clearSaveTimer();
  lifecycleStatus.value = 'SUBMITTED';
  dirty.value = false;
  saveState.value = 'saved';
  score.value = data.score;
  total.value = data.total;
  results.value = data.results;
  gradingError.value = null;
  pollError.value = '';
  current.value = 0;
  emit('submitted', data);
  window.scrollTo({ top: 0 });
  return true;
}

function clearPollTimer() {
  if (pollTimer === undefined) return;
  window.clearTimeout(pollTimer);
  pollTimer = undefined;
}

function schedulePoll(delay = 1_500) {
  clearPollTimer();
  if (!alive || lifecycleStatus.value !== 'SCORING') return;
  pollTimer = window.setTimeout(() => {
    pollTimer = undefined;
    void pollAttempt();
  }, delay);
}

async function pollAttempt() {
  if (pollInFlight || !alive || lifecycleStatus.value !== 'SCORING') return;
  pollInFlight = true;
  const attemptId = props.attemptId;
  try {
    const attempt = await requestForAttempt<QuizAttemptLifecycle>(
      attemptId,
      `/quizzes/attempts/${encodeURIComponent(attemptId)}`,
    );
    if (!ownsAttempt(attemptId) || attempt.attemptId !== attemptId) return;
    pollError.value = '';
    if (attempt.status === 'SUBMITTED' && attempt.results) {
      applySubmitted({
        score: attempt.score ?? 0,
        total: attempt.total,
        results: attempt.results,
      }, attemptId);
      return;
    }
    if (attempt.status === 'SCORING_FAILED') {
      lifecycleStatus.value = 'SCORING_FAILED';
      gradingError.value = attempt.gradingError;
      return;
    }
    if (attempt.status !== 'SCORING') {
      await applyAttemptState(attempt);
    }
  } catch (caught) {
    if (!ownsAttempt(attemptId) || isAbortError(caught)) return;
    pollError.value = formatError(caught, '暂时无法获取评分状态，正在重试');
  } finally {
    pollInFlight = false;
    if (ownsAttempt(attemptId) && lifecycleStatus.value === 'SCORING')
      schedulePoll();
  }
}

function select(questionId: string, optionId: string) {
  if (answersLocked.value) return;
  answers.value = toggleAnswer(
    answers.value,
    questionId,
    question.value.gradingType,
    optionId,
  );
}

function isChecked(questionId: string, optionId: string): boolean {
  return answers.value[questionId]?.includes(optionId) ?? false;
}

function writeShortAnswer(questionId: string, event: Event) {
  if (answersLocked.value) return;
  answers.value = setShortAnswer(
    answers.value,
    questionId,
    (event.target as HTMLTextAreaElement).value,
  );
}

function go(index: number) {
  if (index >= 0 && index < props.questions.length) current.value = index;
}

function resultFor(questionId: string): QuizResult | undefined {
  return results.value?.find((item) => item.questionId === questionId);
}

function isUncertainNetworkError(caught: unknown) {
  return (
    caught instanceof TypeError &&
    /failed to fetch|network|load failed/i.test(caught.message)
  );
}

async function syncAttemptAfterSubmitFailure(
  attemptId: string,
): Promise<QuizAttemptStatus | null> {
  try {
    const attempt = await requestForAttempt<QuizAttemptLifecycle>(
      attemptId,
      `/quizzes/attempts/${encodeURIComponent(attemptId)}`,
    );
    if (!ownsAttempt(attemptId) || attempt.attemptId !== attemptId) return null;
    if (attempt.status === 'SUBMITTED' && attempt.results) {
      applySubmitted(
        {
          score: attempt.score ?? 0,
          total: attempt.total,
          results: attempt.results,
        },
        attemptId,
      );
      return attempt.status;
    }
    if (!(await applyAttemptState(attempt))) return null;
    if (attempt.status === 'SCORING') schedulePoll(0);
    return attempt.status;
  } catch {
    // 保留原始提交错误；权威状态同步失败不能覆盖它。
    return null;
  }
}

async function submit(retry = false) {
  if (submitting.value || submitted.value) return;
  submitting.value = true;
  const attemptId = props.attemptId;
  try {
    const missing = retry ? 0 : props.questions.length - done.value;
    if (missing > 0) {
      const ok = await confirm({
        title: "提交答案",
        body: `还有 ${missing} 道题未作答，未作答将记为错误。确定提交？`,
        confirmText: "确定提交",
      });
      if (!ok) return;
    }
    if (!(await flushDraft())) {
      toast.error('草稿尚未保存，请处理保存失败或冲突后再提交');
      return;
    }
    const data = await requestForAttempt<QuizSubmissionResponse>(
      attemptId,
      `/quizzes/${attemptId}/submit`,
      {
        method: 'POST',
        body: JSON.stringify({ answers: answers.value }),
      },
    );
    if (!ownsAttempt(attemptId) || data.attemptId !== attemptId) return;
    if (data.pending) {
      lifecycleStatus.value = 'SCORING';
      gradingError.value = null;
      pollError.value = '';
      schedulePoll();
    } else {
      applySubmitted(data, attemptId);
    }
  } catch (caught) {
    if (!ownsAttempt(attemptId) || isAbortError(caught)) return;
    let authoritativeStatus: QuizAttemptStatus | null = null;
    if (
      (caught instanceof ApiClientError && caught.status === 409) ||
      (caught instanceof ApiClientError && caught.status >= 500) ||
      isUncertainNetworkError(caught)
    ) {
      authoritativeStatus = await syncAttemptAfterSubmitFailure(attemptId);
    }
    if (!ownsAttempt(attemptId)) return;
    if (!authoritativeStatus || authoritativeStatus === 'DRAFT') {
      toast.error(formatError(caught, '提交失败，答案已保留，请重试'));
    }
  } finally {
    if (ownsAttempt(attemptId)) submitting.value = false;
  }
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value || lifecycleStatus.value !== 'DRAFT') return;
  event.preventDefault();
  event.returnValue = '';
}

watch(
  answers,
  () => {
    if (ignoreChanges || lifecycleStatus.value !== 'DRAFT') return;
    changeVersion += 1;
    dirty.value = true;
    if (saveState.value !== 'conflict') saveState.value = 'idle';
    scheduleDraftSave();
  },
  { deep: true },
);

watch(current, () => {
  if (ignoreChanges || lifecycleStatus.value !== 'DRAFT') return;
  changeVersion += 1;
  dirty.value = true;
  if (saveState.value !== 'conflict') saveState.value = 'idle';
  scheduleDraftSave();
});

onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload);
  if (lifecycleStatus.value === 'SCORING') schedulePoll(0);
});

onBeforeRouteLeave(async () => flushDraft());
onBeforeRouteUpdate(async () => flushDraft());

onBeforeUnmount(() => {
  alive = false;
  abortRequests();
  saveInFlight = null;
  flushInFlight = null;
  pollInFlight = false;
  clearSaveTimer();
  clearPollTimer();
  window.removeEventListener('beforeunload', beforeUnload);
});

defineExpose({ flushDraft });
</script>

<template>
  <div class="quiz-runner">
    <div v-if="submitted" class="score-banner" role="status">
      <CheckCircle2 :size="20" aria-hidden="true" />
      <strong>本次得分：{{ score }} / {{ total }}</strong>
      <span class="score-detail">
        满分 {{ results?.filter((item) => item.correct).length }} 题，部分得分
        {{
          results?.filter((item) => !item.correct && item.score > 0).length
        }}
        题
      </span>
    </div>

    <div v-else-if="scoring" class="grading-banner" role="status">
      <LoaderCircle class="spin" :size="20" aria-hidden="true" />
      <div>
        <strong>正在评分</strong>
        <p>答案已锁定，评分完成后会自动显示结果。</p>
        <small v-if="pollError">{{ pollError }}</small>
      </div>
    </div>

    <div v-else-if="scoringFailed" class="grading-banner failed" role="alert">
      <XCircle :size="20" aria-hidden="true" />
      <div>
        <strong>评分未完成</strong>
        <p>{{ gradingError || '评分服务暂时不可用，答案已保留。' }}</p>
      </div>
      <button
        type="button"
        class="button secondary"
        :disabled="submitting"
        @click="submit(true)"
      >
        <RotateCw :size="16" aria-hidden="true" />
        {{ submitting ? '正在重试…' : '用相同答案重新评分' }}
      </button>
    </div>

    <div v-else-if="abandoned" class="grading-banner abandoned" role="status">
      <XCircle :size="20" aria-hidden="true" />
      <div>
        <strong>该答题已放弃</strong>
        <p>已保存答案仅供查看，不能继续编辑或提交。</p>
      </div>
    </div>

    <div
      v-if="lifecycleStatus === 'DRAFT'"
      class="draft-save-status"
      :class="saveState"
      role="status"
    >
      <span>{{ saveStatusText }}</span>
      <small v-if="saveError">{{ saveError }}</small>
      <button
        v-if="saveState === 'error'"
        type="button"
        class="button ghost"
        @click="flushDraft"
      >
        <RotateCw :size="15" aria-hidden="true" />
        重试保存
      </button>
      <button
        v-if="saveState === 'conflict'"
        type="button"
        class="button ghost"
        :disabled="reloading"
        @click="reloadAttempt"
      >
        <RotateCw :size="15" aria-hidden="true" />
        {{ reloading ? '正在载入…' : '重新载入' }}
      </button>
    </div>

    <div class="quiz-progress" aria-label="答题进度">
      <span
        >第 {{ current + 1 }} / {{ questions.length }} 题 · 已答
        {{ done }} 题</span
      >
      <div class="progress-track" aria-hidden="true">
        <div
          class="progress-bar"
          :style="{ width: `${(done / questions.length) * 100}%` }"
        />
      </div>
    </div>

    <nav class="question-nav" aria-label="题号导航">
      <button
        v-for="(item, index) in questions"
        :key="item.id"
        type="button"
        class="question-dot"
        :class="{
          current: index === current,
          answered: (answers[item.id]?.length ?? 0) > 0,
          incorrect: incorrectQuestionIds.has(item.id),
        }"
        :aria-current="index === current ? 'true' : undefined"
        :aria-label="`第 ${index + 1} 题，${(answers[item.id]?.length ?? 0) > 0 ? '已作答' : '未作答'}${incorrectQuestionIds.has(item.id) ? '，未得满分' : ''}`"
        @click="go(index)"
      >
        {{ index + 1 }}
      </button>
    </nav>

    <article class="question-card">
      <div class="question-head">
        <div class="question-badges">
          <StatusBadge
            :text="
              question.typeLabel ||
              labelOf(questionTypeLabels, question.gradingType)
            "
            tone="accent"
          />
          <StatusBadge
            v-if="question.isPastPaper"
            :text="
              question.pastPaper
                ? `往年真题 · ${question.pastPaper.title}${
                    question.pastPaper.year ? `（${question.pastPaper.year}）` : ''
                  }`
                : '往年真题'
            "
            tone="warning"
          />
        </div>
        <h2 class="question-prompt">
          {{ current + 1 }}. {{ question.prompt }}
        </h2>
        <p class="question-meta">
          {{ question.subject }} · {{ question.chapters.map((chapter) => chapter.name).join(' / ') || question.chapter }} ·
          {{ question.maxScore }} 分
        </p>
      </div>
      <QuizQuestionImages
        v-if="question.images?.length"
        :images="question.images"
        :alt-context="question.prompt"
      />
      <div v-if="question.gradingType === 'SHORT_ANSWER'" class="short-answer-field">
        <label :for="`short-answer-${question.id}`">作答</label>
        <textarea
          :id="`short-answer-${question.id}`"
          :value="answers[question.id]?.[0] ?? ''"
          :disabled="answersLocked"
          maxlength="10000"
          rows="8"
          @input="writeShortAnswer(question.id, $event)"
        ></textarea>
      </div>
      <div
        v-else
        class="options"
        :role="question.gradingType === 'MULTIPLE' ? 'group' : 'radiogroup'"
        :aria-label="`第 ${current + 1} 题选项`"
      >
        <label
          v-for="option in question.options"
          :key="option.id"
          class="option"
          :class="{
            checked: isChecked(question.id, option.id),
            correct:
              submitted &&
              resultFor(question.id)?.correctAnswer.includes(option.id),
            wrong:
              submitted &&
              isChecked(question.id, option.id) &&
              !resultFor(question.id)?.correctAnswer.includes(option.id),
          }"
        >
          <input
            :type="question.gradingType === 'MULTIPLE' ? 'checkbox' : 'radio'"
            :name="question.id"
            :checked="isChecked(question.id, option.id)"
            :disabled="answersLocked"
            @change="select(question.id, option.id)"
          />
          <span>{{ option.text }}</span>
        </label>
      </div>

      <div
        v-if="submitted && resultFor(question.id)"
        class="question-result"
        :class="{
          ok: resultFor(question.id)?.correct,
          partial:
            !resultFor(question.id)?.correct &&
            (resultFor(question.id)?.score ?? 0) > 0,
        }"
      >
        <p class="result-line">
          <CheckCircle2
            v-if="resultFor(question.id)?.correct"
            :size="17"
            aria-hidden="true"
          />
          <CircleDot
            v-else-if="(resultFor(question.id)?.score ?? 0) > 0"
            :size="17"
            aria-hidden="true"
          />
          <XCircle v-else :size="17" aria-hidden="true" />
          <strong v-if="question.gradingType === 'SHORT_ANSWER'">
            本题得分：{{ resultFor(question.id)?.score }} /
            {{ resultFor(question.id)?.maxScore }}
          </strong>
          <strong v-else-if="resultFor(question.id)?.correct">回答正确</strong>
          <strong v-else
            >正确答案：{{
              optionTexts(question, resultFor(question.id)!.correctAnswer).join(
                "、",
              )
            }}</strong
          >
        </p>
        <p v-if="resultFor(question.id)?.feedback" class="grading-feedback">
          {{ resultFor(question.id)?.feedback }}
        </p>
        <ul
          v-if="resultFor(question.id)?.criterionScores?.length"
          class="criterion-list"
        >
          <li
            v-for="criterion in resultFor(question.id)?.criterionScores"
            :key="criterion.description"
          >
            <span>{{ criterion.description }}</span>
            <strong
              >{{ criterion.awardedPoints }} /
              {{ criterion.maxPoints }} 分</strong
            >
            <small>{{ criterion.reason }}</small>
          </li>
        </ul>
        <p v-if="question.gradingType === 'SHORT_ANSWER'" class="reference-answer">
          <strong>参考答案：</strong
          >{{ resultFor(question.id)?.correctAnswer.join("；") }}
        </p>
        <p
          v-if="resultFor(question.id)?.explanation"
          class="result-explanation"
        >
          {{ resultFor(question.id)?.explanation }}
        </p>
      </div>
    </article>

    <div class="quiz-controls">
      <button
        type="button"
        class="button ghost"
        :disabled="current === 0"
        @click="go(current - 1)"
      >
        <ChevronLeft :size="17" aria-hidden="true" />
        上一题
      </button>
      <button
        v-if="lifecycleStatus === 'DRAFT'"
        type="button"
        class="button"
        :disabled="submitting"
        @click="submit()"
      >
        <Send :size="16" aria-hidden="true" />
        {{ submitting ? "正在提交…" : "提交答案" }}
      </button>
      <button
        v-else-if="scoring"
        type="button"
        class="button"
        disabled
      >
        <LoaderCircle class="spin" :size="16" aria-hidden="true" />
        正在评分…
      </button>
      <span v-else-if="scoringFailed" class="control-placeholder" />
      <button
        v-else-if="abandoned"
        type="button"
        class="button secondary"
        @click="emit('restart')"
      >
        {{ finishLabel }}
      </button>
      <button
        v-else-if="submitted"
        type="button"
        class="button secondary"
        @click="emit('restart')"
      >
        {{ finishLabel }}
      </button>
      <button
        type="button"
        class="button ghost"
        :disabled="current === questions.length - 1"
        @click="go(current + 1)"
      >
        下一题
        <ChevronRight :size="17" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.quiz-runner {
  display: grid;
  gap: var(--space-5);
}

.score-banner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--success-border);
  border-radius: var(--radius-m);
  background: var(--success-bg);
  color: var(--success);
}

.score-banner strong {
  font-size: 18px;
}

.score-detail {
  color: var(--ink-soft);
  font-size: 14px;
}

.grading-banner {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--accent);
  border-radius: var(--radius-m);
  background: var(--accent-soft);
  color: var(--accent-dark);
}

.grading-banner.failed {
  border-color: var(--danger-border);
  background: var(--danger-bg);
  color: var(--danger);
}

.grading-banner.abandoned {
  border-color: var(--border-strong);
  background: var(--surface-muted);
  color: var(--muted);
}

.grading-banner div {
  flex: 1 1 240px;
}

.grading-banner p {
  margin: 2px 0 0;
  color: var(--ink-soft);
  font-size: 14px;
}

.grading-banner small {
  display: block;
  margin-top: var(--space-1);
  color: var(--danger);
}

.draft-save-status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  color: var(--muted);
  font-size: 13px;
}

.draft-save-status.error,
.draft-save-status.conflict {
  flex-wrap: wrap;
  color: var(--danger);
}

.draft-save-status small {
  color: inherit;
}

.draft-save-status .button {
  min-height: 32px;
  padding: 5px 10px;
  color: inherit;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.quiz-progress {
  display: grid;
  gap: var(--space-2);
  color: var(--muted);
  font-size: 14px;
}

.progress-track {
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--surface-muted);
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  border-radius: var(--radius-pill);
  background: var(--gradient-accent);
  transition: width 0.25s var(--ease-out);
}

.question-nav {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.question-dot {
  width: 38px;
  height: 38px;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.16s var(--ease-out), border-color 0.16s var(--ease-out), color 0.16s var(--ease-out);
}

.question-dot:hover {
  border-color: var(--border-strong);
  color: var(--primary);
}

.question-dot.answered {
  border-color: var(--accent);
  color: var(--accent-dark);
  background: var(--accent-soft);
}

.question-dot.current {
  border-color: transparent;
  background: var(--gradient-primary);
  color: #ffffff;
  box-shadow: 0 6px 14px -6px rgba(20, 31, 75, 0.5);
}

.question-dot.incorrect {
  border-color: var(--danger-border);
  background: var(--danger-bg);
  color: var(--danger);
}

.question-dot.incorrect:hover {
  border-color: var(--danger);
}

.question-dot.incorrect.current {
  border-color: var(--danger);
  box-shadow: inset 0 0 0 1px var(--danger);
  font-weight: 700;
}

.question-card {
  display: grid;
  gap: var(--space-4);
  padding: var(--space-6);
  border: 1px solid var(--border);
  border-radius: var(--radius-l);
  background: var(--surface);
  box-shadow: var(--shadow-s);
}

.question-head {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
}

.question-badges {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.question-prompt {
  margin: 0;
  font-size: 18px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.question-meta {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.options {
  display: grid;
  gap: var(--space-2);
}

.option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  min-height: 46px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-m);
  background: var(--surface);
  cursor: pointer;
  line-height: 1.6;
  transition: background 0.15s var(--ease-out), border-color 0.15s var(--ease-out);
}

.option:hover {
  background: var(--surface-tint);
  border-color: var(--border-strong);
}

.option.checked {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.option input {
  margin-top: 5px;
  flex: none;
  accent-color: var(--accent);
}

.option.correct {
  border-color: var(--success-border);
  background: var(--success-bg);
}

.option.wrong {
  border-color: var(--danger-border);
  background: var(--danger-bg);
}

.short-answer-field {
  display: grid;
  gap: var(--space-2);
}

.short-answer-field label {
  color: var(--ink-soft);
  font-size: 14px;
  font-weight: 600;
}

.short-answer-field textarea {
  width: 100%;
  min-height: 180px;
  resize: vertical;
  line-height: 1.7;
}

.question-result {
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-m);
  background: var(--danger-bg);
  color: var(--danger);
}

.question-result.ok {
  background: var(--success-bg);
  color: var(--success);
}

.question-result.partial {
  background: var(--warning-bg);
  color: var(--warning);
}

.result-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
}

.result-explanation {
  margin: var(--space-2) 0 0;
  color: var(--ink-soft);
  line-height: 1.7;
}

.grading-feedback,
.reference-answer {
  margin: var(--space-2) 0 0;
  color: var(--ink-soft);
  line-height: 1.7;
  white-space: pre-wrap;
}

.criterion-list {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding: 0;
  list-style: none;
}

.criterion-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px solid currentColor;
}

.criterion-list span,
.criterion-list small {
  overflow-wrap: anywhere;
}

.criterion-list small {
  grid-column: 1 / -1;
  color: var(--ink-soft);
  line-height: 1.5;
}

.quiz-controls {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.control-placeholder {
  min-width: 1px;
}

@media (max-width: 560px) {
  .question-dot {
    width: 34px;
    height: 34px;
  }

  .quiz-controls .button {
    flex: 1;
    justify-content: center;
  }
}
</style>
