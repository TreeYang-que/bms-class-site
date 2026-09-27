<script setup lang="ts">
import { ref } from 'vue';
import { api, formatError } from '../../lib/api';
import QuizQuestionImages from '../quiz/QuizQuestionImages.vue';
import type { QuizImage } from '../../types';

const props = defineProps<{ questionId: string; images: QuizImage[] }>();
const emit = defineEmits<{ busy: [value: boolean] }>();
const images = ref([...props.images]);
const file = ref<File | null>(null);
const caption = ref('');
const busy = ref(false);
const error = ref('');
const uncertain = ref(false);
const input = ref<HTMLInputElement | null>(null);

function choose(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0];
  error.value = '';
  file.value = null;
  if (!selected) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type) || selected.size > 10 * 1024 * 1024) {
    error.value = '请选择不超过 10MB 的 JPG、PNG 或 WebP 图片';
    return;
  }
  file.value = selected;
}

async function upload() {
  if (!file.value || busy.value || uncertain.value || images.value.length >= 5) return;
  busy.value = true;
  emit('busy', true);
  error.value = '';
  try {
    const body = new FormData();
    body.append('file', file.value);
    body.append('caption', caption.value.trim());
    body.append('sortOrder', String(images.value.length));
    const photo = await api<QuizImage>(`/quizzes/questions/${encodeURIComponent(props.questionId)}/images`, { method: 'POST', body });
    images.value.push(photo);
    file.value = null;
    caption.value = '';
    if (input.value) input.value.value = '';
  } catch (caught) {
    uncertain.value = true;
    error.value = formatError(caught, '图片上传结果未确认') + '。请关闭并重新打开编辑，核对已有配图后再继续，避免重复上传。';
  } finally {
    busy.value = false;
    emit('busy', false);
  }
}
</script>

<template>
  <section class="question-image-editor" aria-label="题目配图管理">
    <h4>题目配图</h4>
    <QuizQuestionImages :images="images" alt-context="题目配图" />
    <p class="muted-note" role="status">已上传 {{ images.length }} 张。图片上传后立即生效，取消文字编辑不会撤回图片。</p>
    <div class="field"><label :for="`edit-image-${questionId}`">添加配图（每张不超过 10MB，最多 5 张）</label><input :id="`edit-image-${questionId}`" ref="input" type="file" accept="image/jpeg,image/png,image/webp" :disabled="busy || uncertain || images.length >= 5" @change="choose" /></div>
    <div class="field"><label :for="`edit-image-caption-${questionId}`">配图说明</label><input :id="`edit-image-caption-${questionId}`" v-model="caption" maxlength="500" :disabled="busy || uncertain" placeholder="说明观察对象、标记及多图顺序" /></div>
    <button type="button" class="button secondary" :disabled="!file || busy || uncertain || images.length >= 5" @click="upload">{{ busy ? '正在上传…' : '上传配图' }}</button>
    <p v-if="error" class="alert error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.question-image-editor { display: grid; gap: var(--space-3); min-width: 0; }
.question-image-editor h4, .question-image-editor p { margin: 0; }
.question-image-editor .button { width: fit-content; }
.muted-note { color: var(--muted); font-size: 13px; line-height: 1.7; }
</style>
