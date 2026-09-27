import type { AiContentBlock } from '@bmc3/ai-core';
import { CosMediaStore, MAX_STORED_IMAGE_BYTES, readMediaCosConfig } from '@bmc3/media-core';
import type { PrismaClient } from '@prisma/client';

// Inline images never expose a private object key or a reusable signed URL.
// Keep base64 plus text below the provider's 48 MiB HTTP request limit.
const MAX_REQUEST_IMAGE_BYTES = 28 * 1024 * 1024;

export interface PracticeImageQuestion {
  questionId: string;
  alias: string;
}

export async function loadPracticeQuestionImages(
  prisma: Pick<PrismaClient, 'quizQuestionPhoto'>,
  questions: PracticeImageQuestion[],
  signal?: AbortSignal,
): Promise<{ blocks: AiContentBlock[]; count: number; estimatedTokens: number }> {
  if (!questions.length) return { blocks: [], count: 0, estimatedTokens: 0 };
  const links = await prisma.quizQuestionPhoto.findMany({
    where: { questionId: { in: questions.map((question) => question.questionId) } },
    include: { photo: true },
    orderBy: [{ questionId: 'asc' }, { sortOrder: 'asc' }, { photoId: 'asc' }],
  });
  const total = links.reduce((sum, link) => sum + link.photo.size, 0);
  if (links.length > 300 || total > MAX_REQUEST_IMAGE_BYTES) throw new Error('PRACTICE_IMAGE_REQUEST_TOO_LARGE');
  const blocks: AiContentBlock[] = [];
  let actualBytes = 0;
  for (const question of questions) {
    const images = links.filter((link) => link.questionId === question.questionId);
    for (const [index, { photo }] of images.entries()) {
      signal?.throwIfAborted();
      if (photo.mimeType !== 'image/webp' || photo.size > MAX_STORED_IMAGE_BYTES ||
        !photo.width || !photo.height || photo.width > 4096 || photo.height > 4096) {
        throw new Error('PRACTICE_IMAGE_FORMAT_UNSUPPORTED');
      }
      let data: Buffer;
      if (photo.data) data = Buffer.from(photo.data);
      else {
        if (!photo.objectKey || process.env.MEDIA_STORAGE_PROVIDER !== 'cos') throw new Error('PRACTICE_IMAGE_UNAVAILABLE');
        data = await new CosMediaStore(readMediaCosConfig(process.env)).download(photo.objectKey);
      }
      signal?.throwIfAborted();
      actualBytes += data.length;
      if (data.length !== photo.size || data.length > MAX_STORED_IMAGE_BYTES || actualBytes > MAX_REQUEST_IMAGE_BYTES) {
        throw new Error('PRACTICE_IMAGE_SIZE_MISMATCH');
      }
      blocks.push({ type: 'text', text: JSON.stringify({ questionAlias: question.alias, imageIndex: index + 1, caption: photo.caption }) });
      blocks.push({ type: 'image_url', image_url: { url: `data:image/webp;base64,${data.toString('base64')}` } });
    }
  }
  return { blocks, count: links.length, estimatedTokens: links.length * 1024 };
}
