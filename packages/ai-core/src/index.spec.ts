import {
  AiClient,
  AiClientError,
  CREDIT_HOUR_REVIEW_PROMPT_VERSION,
  compileJsonSchema,
  describeStrategy,
  modelForStrategy,
  parseStrictJsonObject,
  readAiRuntimeConfig,
} from './index';

describe('AI task strategies', () => {
  it('keeps shared model strategies including Max', () => {
    expect(describeStrategy('PRO_MAX')).toEqual({
      modelTier: 'flash',
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    });
    expect(describeStrategy('FLASH_NO_THINKING')).toEqual({
      modelTier: 'flash',
      thinking: { type: 'enabled' },
    });
    expect(describeStrategy('VISION_HIGH')).toEqual({
      modelTier: 'flash',
      thinking: { type: 'enabled' },
      reasoningEffort: 'high',
    });
    expect(
      modelForStrategy(
        {
          flashModel: 'deepseek-v4-flash',
          creditHourReviewModel: 'deepseek-v4-flash-vision-exp',
        },
        'VISION_HIGH',
      ),
    ).toBe('deepseek-v4-flash-vision-exp');
    for (const strategy of [
      'FLASH_NO_THINKING',
      'FLASH_HIGH',
      'PRO_HIGH',
      'PRO_MAX',
    ] as const) {
      expect(
        modelForStrategy({ flashModel: 'deepseek-v4-flash' }, strategy),
      ).toBe('deepseek-v4-flash');
    }
  });

  it('rejects conflicting legacy aliases', () => {
    expect(() =>
      readAiRuntimeConfig({
        AI_BASE_URL: 'https://one.example.test',
        LLM_BASE_URL: 'https://two.example.test',
      }),
    ).toThrow(AiClientError);
  });
});

describe('AiClient request boundaries', () => {
  it('routes daily and curriculum image messages to the vision model without altering image associations', async () => {
    const fetcher = jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 }));
    const client = new AiClient({ provider: 'deepseek', baseUrl: 'https://ai.example.test', apiKey: 'test-only', flashModel: 'text-model', visionModel: 'vision-model' }, fetcher as typeof fetch);
    const content = [{ type: 'text' as const, text: '{"questionAlias":"Q001","imageIndex":1}' }, { type: 'image_url' as const, image_url: { url: 'data:image/webp;base64,d2VicA==' } }];
    for (const taskType of ['DAILY_PLAN', 'CURRICULUM_MAPPING'] as const) {
      await client.complete({ taskType, strategy: 'FLASH_HIGH', vision: true, promptVersion: 'test', messages: [{ role: 'user', content }], maxOutputTokens: 100, timeoutMs: 5000 });
    }
    for (const call of fetcher.mock.calls) {
      const body = JSON.parse(call[1]!.body as string);
      expect(body.model).toBe('vision-model');
      expect(body.messages[0].content).toEqual(content);
    }
    expect(client.model('FLASH_HIGH')).toBe('text-model');
  });

  it('uploads one-hour vision files, sends file blocks, and deletes them', async () => {
    const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/files') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'file-test-1',
            bytes: 3,
            expires_at: '2030-01-01T00:00:00.000Z',
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/files/file-test-1') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"decision":"APPROVE"}' } }],
        }),
        { status: 200 },
      );
    });
    const client = new AiClient(
      {
        provider: 'deepseek',
        baseUrl: 'https://deepseek.example.test/v1',
        apiKey: 'test-only',
        flashModel: 'deepseek-v4-flash',
        creditHourReviewModel: 'deepseek-v4-flash-vision-exp',
      },
      fetcher as typeof fetch,
    );
    const file = await client.uploadFile(
      Uint8Array.from([1, 2, 3]),
      'evidence.png',
      'image/png',
      3_600,
    );
    await client.complete({
      taskType: 'CREDIT_HOUR_REVIEW',
      strategy: 'VISION_HIGH',
      promptVersion: CREDIT_HOUR_REVIEW_PROMPT_VERSION,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'json' },
            { type: 'file', file_id: file.id },
          ],
        },
      ],
      maxOutputTokens: 100,
      timeoutMs: 5_000,
      responseFormat: { type: 'json_object' },
    });
    await client.deleteFile(file.id);

    const uploadForm = fetcher.mock.calls[0]![1]!.body as FormData;
    expect(uploadForm.get('purpose')).toBe('user_data');
    expect(uploadForm.get('expires_after[anchor]')).toBe('created_at');
    expect(uploadForm.get('expires_after[seconds]')).toBe('3600');
    expect(uploadForm.has('expire_after')).toBe(false);
    const body = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash-vision-exp',
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
    });
    expect(body.messages[0].content[1]).toEqual({
      type: 'file',
      file_id: 'file-test-1',
    });
    expect(body).not.toHaveProperty('temperature');
    expect(fetcher.mock.calls[2]![0]).toBe(
      'https://deepseek.example.test/v1/files/file-test-1',
    );
  });

  it('sends max thinking without ineffective sampling parameters', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'request-1',
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new AiClient(
      {
        provider: 'deepseek',
        baseUrl: 'https://deepseek.example.test/v1',
        apiKey: 'test-only',
        flashModel: 'deepseek-v4-flash',
      },
      fetcher,
    );

    await client.complete({
      taskType: 'CURRICULUM_MAPPING',
      strategy: 'PRO_MAX',
      promptVersion: 'test-v1',
      messages: [{ role: 'user', content: 'test' }],
      maxOutputTokens: 100,
      timeoutMs: 5_000,
      responseFormat: { type: 'json_object' },
    });

    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
    });
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
  });

  it('drops reasoning deltas from streams', async () => {
    const stream = [
      'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetcher = jest
      .fn()
      .mockResolvedValue(new Response(stream, { status: 200 }));
    const client = new AiClient(
      {
        provider: 'deepseek',
        baseUrl: 'https://deepseek.example.test/v1',
        apiKey: 'test-only',
        flashModel: 'deepseek-v4-flash',
      },
      fetcher,
    );
    let result = '';
    for await (const event of client.stream({
      taskType: 'CHAT_QA',
      strategy: 'FLASH_NO_THINKING',
      promptVersion: 'test-v1',
      messages: [{ role: 'user', content: 'test' }],
      maxOutputTokens: 100,
      timeoutMs: 5_000,
    })) {
      if (event.type === 'token') result += event.text;
    }
    expect(result).toBe('answer');
    expect(result).not.toContain('hidden');
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      thinking: { type: 'enabled' },
    });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('temperature');
  });

  it('reports bounded finish metadata when a completion has no usable content', async () => {
    const client = new AiClient(
      {
        provider: 'deepseek',
        baseUrl: 'https://deepseek.example.test/v1',
        apiKey: 'test-only',
        flashModel: 'deepseek-v4-flash',
      },
      jest.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 100, completion_tokens: 2_500 },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      client.complete({
        taskType: 'DAILY_PLAN',
        strategy: 'PRO_MAX',
        promptVersion: 'test-v1',
        messages: [{ role: 'user', content: 'test' }],
        maxOutputTokens: 2_500,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      category: 'INVALID_RESPONSE',
      message:
        '模型服务未返回有效内容 (finish_reason=length, completion_tokens=2500)',
    });
  });
});

describe('strict structured output', () => {
  const validate = compileJsonSchema<{ value: string }>({
    type: 'object',
    additionalProperties: false,
    required: ['value'],
    properties: { value: { type: 'string' } },
  });

  it('rejects markdown fences and extra fields', () => {
    expect(() => parseStrictJsonObject('```json\n{"value":"x"}\n```')).toThrow(
      AiClientError,
    );
    expect(validate({ value: 'ok' }).valid).toBe(true);
    expect(validate({ value: 'ok', extra: true }).valid).toBe(false);
  });
});
