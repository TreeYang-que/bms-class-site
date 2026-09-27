import { loadPracticeQuestionImages } from './practice-question-images';

it('sends each stored image with the exact question alias and ordinal, without storage identifiers', async () => {
  const photo = { id: 'private-photo', objectKey: 'private/object-key', data: Buffer.from('webp'), caption: '结构图', mimeType: 'image/webp', size: 4, width: 400, height: 300 };
  const prisma = { quizQuestionPhoto: { findMany: jest.fn(async () => [
    { questionId: 'db-fixed', photoId: 'p1', sortOrder: 1, photo },
    { questionId: 'db-candidate', photoId: 'p2', sortOrder: 1, photo },
  ]) } };
  const result = await loadPracticeQuestionImages(prisma as never, [{ questionId: 'db-candidate', alias: 'Q001' }, { questionId: 'db-fixed', alias: 'F001' }]);
  expect(result).toMatchObject({ count: 2, estimatedTokens: 2048 });
  expect(result.blocks[0]).toEqual({ type: 'text', text: JSON.stringify({ questionAlias: 'Q001', imageIndex: 1, caption: '结构图' }) });
  expect(result.blocks[2]).toEqual({ type: 'text', text: JSON.stringify({ questionAlias: 'F001', imageIndex: 1, caption: '结构图' }) });
  expect(result.blocks[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/webp;base64,d2VicA==' } });
  expect(JSON.stringify(result.blocks)).not.toMatch(/private|db-candidate|db-fixed/);
});

it('fails the whole request instead of silently dropping an oversized or missing image', async () => {
  const prisma = { quizQuestionPhoto: { findMany: jest.fn(async () => [{ questionId: 'q', photo: { size: 30 * 1024 * 1024 } }]) } };
  await expect(loadPracticeQuestionImages(prisma as never, [{ questionId: 'q', alias: 'Q001' }])).rejects.toThrow('PRACTICE_IMAGE_REQUEST_TOO_LARGE');
});
