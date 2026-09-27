import Ajv, { type ErrorObject } from 'ajv';

export const CREDIT_HOUR_REVIEW_PROMPT_VERSION = 'credit-hour-review-v3';

export const AI_TASK_TYPES = [
  'CHAT_QA',
  'CURRICULUM_MAPPING',
  'SHORT_ANSWER_GRADING',
  'DAILY_PLAN',
  'CREDIT_HOUR_REVIEW',
] as const;

export const AI_TASK_STRATEGIES = [
  'FLASH_NO_THINKING',
  'FLASH_HIGH',
  'PRO_HIGH',
  'PRO_MAX',
  'VISION_HIGH',
] as const;

export type AiTaskType = (typeof AI_TASK_TYPES)[number];
export type AiTaskStrategy = (typeof AI_TASK_STRATEGIES)[number];
export type AiProviderKind = 'mock' | 'deepseek';
export type AiReasoningEffort = 'high' | 'max';

export interface AiRuntimeEnvironment {
  [key: string]: string | undefined;
}

export interface AiRuntimeConfig {
  provider: AiProviderKind;
  baseUrl: string;
  apiKey: string;
  flashModel: string;
  creditHourReviewModel?: string;
  visionModel?: string;
}

export type AiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file_id: string };

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | AiContentBlock[];
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  source: 'PROVIDER' | 'ESTIMATED';
}

export interface AiRequest {
  taskType: AiTaskType;
  strategy: AiTaskStrategy;
  promptVersion: string;
  messages: AiMessage[];
  maxOutputTokens: number;
  timeoutMs: number;
  responseFormat?: { type: 'json_object' };
  temperature?: number;
  signal?: AbortSignal;
  mockContent?: string;
  estimatedImageTokens?: number;
  vision?: boolean;
}

export interface AiProviderFile {
  id: string;
  bytes: number;
  expiresAt: Date;
}

export interface AiCompletion {
  content: string;
  provider: AiProviderKind;
  model: string;
  providerRequestId?: string;
  usage: AiUsage;
  latencyMs: number;
}

export type AiStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'usage'; usage: AiUsage; providerRequestId?: string };

export type AiErrorCategory =
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'RATE_LIMIT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_REJECTED'
  | 'INVALID_RESPONSE'
  | 'CONFIGURATION';

export class AiClientError extends Error {
  constructor(
    message: string,
    readonly category: AiErrorCategory,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AiClientError';
  }
}

export interface AiStrategyDescriptor {
  modelTier: 'flash';
  thinking: { type: 'enabled' };
  reasoningEffort?: AiReasoningEffort;
}

export function describeStrategy(
  strategy: AiTaskStrategy,
): AiStrategyDescriptor {
  switch (strategy) {
    case 'FLASH_NO_THINKING':
      return { modelTier: 'flash', thinking: { type: 'enabled' } };
    case 'FLASH_HIGH':
      return {
        modelTier: 'flash',
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
      };
    case 'PRO_HIGH':
      return {
        modelTier: 'flash',
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
      };
    case 'PRO_MAX':
      return {
        modelTier: 'flash',
        thinking: { type: 'enabled' },
        reasoningEffort: 'max',
      };
    case 'VISION_HIGH':
      return {
        modelTier: 'flash',
        thinking: { type: 'enabled' },
        reasoningEffort: 'high',
      };
  }
}

export function modelForStrategy(
  config: Pick<AiRuntimeConfig, 'flashModel' | 'creditHourReviewModel' | 'visionModel'>,
  strategy: AiTaskStrategy,
  vision = false,
) {
  if (vision) return config.visionModel ?? 'deepseek-v4-flash-vision-exp';
  return strategy === 'VISION_HIGH'
    ? config.creditHourReviewModel ?? 'deepseek-v4-flash-vision-exp'
    : config.flashModel;
}

export function readAiRuntimeConfig(
  env: AiRuntimeEnvironment,
): AiRuntimeConfig {
  const provider = readAlias(env, 'AI_PROVIDER', [
    'LLM_PROVIDER',
    'QUIZ_GRADING_PROVIDER',
  ]) ?? 'mock';
  if (provider !== 'mock' && provider !== 'deepseek') {
    throw new AiClientError(
      `不支持的 AI_PROVIDER: ${provider}`,
      'CONFIGURATION',
      false,
    );
  }
  return {
    provider,
    baseUrl:
      readAlias(env, 'AI_BASE_URL', ['LLM_BASE_URL', 'DEEPSEEK_BASE_URL']) ??
      'https://api.deepseek.com',
    apiKey:
      readAlias(env, 'AI_API_KEY', ['LLM_API_KEY', 'DEEPSEEK_API_KEY']) ?? '',
    flashModel:
      readAlias(env, 'AI_FLASH_MODEL', [
        'LLM_MODEL',
        'DEEPSEEK_GRADING_MODEL',
      ]) ?? 'deepseek-v4-flash',
    creditHourReviewModel:
      env.AI_CREDIT_HOUR_REVIEW_MODEL?.trim() ??
      'deepseek-v4-flash-vision-exp',
    visionModel: env.AI_VISION_MODEL?.trim() ?? 'deepseek-v4-flash-vision-exp',
  };
}

function readAlias(
  env: AiRuntimeEnvironment,
  primary: string,
  aliases: string[],
) {
  const primaryValue = env[primary]?.trim();
  const aliasValues = aliases
    .map((name) => ({ name, value: env[name]?.trim() }))
    .filter((item): item is { name: string; value: string } => Boolean(item.value));
  if (primaryValue) {
    const conflict = aliasValues.find((item) => item.value !== primaryValue);
    if (conflict) {
      throw new AiClientError(
        `${primary} 与兼容配置 ${conflict.name} 冲突`,
        'CONFIGURATION',
        false,
      );
    }
    return primaryValue;
  }
  const values = [...new Set(aliasValues.map((item) => item.value))];
  if (values.length > 1) {
    throw new AiClientError(
      `${aliases.join('/')} 兼容配置冲突`,
      'CONFIGURATION',
      false,
    );
  }
  return values[0];
}

export class AiClient {
  constructor(
    private readonly config: AiRuntimeConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (config.provider === 'deepseek' && !config.apiKey) {
      throw new AiClientError(
        'DeepSeek 调用需要 AI_API_KEY',
        'CONFIGURATION',
        false,
      );
    }
  }

  model(strategy: AiTaskStrategy, vision = false) {
    return modelForStrategy(this.config, strategy, vision);
  }

  async uploadFile(
    data: Uint8Array,
    filename: string,
    mimeType: string,
    expireAfterSeconds = 3_600,
  ): Promise<AiProviderFile> {
    if (
      !Number.isInteger(expireAfterSeconds) ||
      expireAfterSeconds < 3_600 ||
      expireAfterSeconds > 2_592_000
    ) {
      throw new RangeError('expireAfterSeconds must be between 3600 and 2592000');
    }
    if (this.config.provider === 'mock') {
      return {
        id: `mock-file-${Date.now()}`,
        bytes: data.byteLength,
        expiresAt: new Date(Date.now() + expireAfterSeconds * 1_000),
      };
    }
    const form = new FormData();
    form.set('purpose', 'user_data');
    form.set('expires_after[anchor]', 'created_at');
    form.set('expires_after[seconds]', String(expireAfterSeconds));
    form.set(
      'file',
      new Blob([Uint8Array.from(data)], { type: mimeType }),
      filename,
    );
    let response: Response;
    try {
      response = await this.fetcher(this.filesEndpoint(), {
        method: 'POST',
        headers: this.authorizationHeaders(),
        body: form,
      });
    } catch (error) {
      throw normalizeClientError(error, undefined, false);
    }
    if (!response.ok) throw responseError(response.status);
    const payload = (await response.json().catch(() => null)) as {
      id?: unknown;
      bytes?: unknown;
      expires_at?: unknown;
    } | null;
    if (!payload || typeof payload.id !== 'string' || !payload.id) {
      throw new AiClientError(
        'Files API 未返回有效文件标识',
        'INVALID_RESPONSE',
        true,
      );
    }
    const expiresAt = normalizeProviderExpiry(
      payload.expires_at,
      expireAfterSeconds,
    );
    return {
      id: payload.id,
      bytes:
        Number.isInteger(payload.bytes) && (payload.bytes as number) >= 0
          ? (payload.bytes as number)
          : data.byteLength,
      expiresAt,
    };
  }

  async deleteFile(fileId: string) {
    if (!fileId) return;
    if (this.config.provider === 'mock') return;
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.filesEndpoint()}/${encodeURIComponent(fileId)}`,
        {
          method: 'DELETE',
          headers: this.authorizationHeaders(),
        },
      );
    } catch (error) {
      throw normalizeClientError(error, undefined, false);
    }
    if (!response.ok && response.status !== 404) {
      throw responseError(response.status);
    }
  }

  async complete(request: AiRequest): Promise<AiCompletion> {
    const startedAt = Date.now();
    const model = this.model(request.strategy, request.vision);
    if (this.config.provider === 'mock') {
      const content = request.mockContent ?? '{}';
      return {
        content,
        provider: 'mock',
        model: `mock:${model}`,
        usage: estimatedUsage(request.messages, content),
        latencyMs: Date.now() - startedAt,
      };
    }
    const linked = linkedAbortSignal(request.signal, request.timeoutMs);
    try {
      const response = await this.fetcher(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.requestBody(request, false)),
        signal: linked.signal,
      });
      if (!response.ok) throw responseError(response.status);
      let payload: {
        id?: unknown;
        choices?: Array<{
          message?: { content?: unknown };
          finish_reason?: unknown;
        }>;
        usage?: ProviderUsage;
      };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        throw new AiClientError(
          '模型服务返回了无效 JSON',
          'INVALID_RESPONSE',
          false,
        );
      }
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content) {
        const details = invalidContentDetails(payload);
        throw new AiClientError(
          `模型服务未返回有效内容${details ? ` (${details})` : ''}`,
          'INVALID_RESPONSE',
          false,
        );
      }
      return {
        content,
        provider: this.config.provider,
        model,
        providerRequestId:
          typeof payload.id === 'string'
            ? payload.id
            : response.headers?.get('x-request-id') ?? undefined,
        usage: normalizeUsage(payload.usage, request.messages, content),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      throw normalizeClientError(error, request.signal, linked.timedOut());
    } finally {
      linked.dispose();
    }
  }

  async *stream(request: AiRequest): AsyncGenerator<AiStreamEvent> {
    if (this.config.provider === 'mock') {
      const content = request.mockContent ?? '';
      for (const part of content.match(/.{1,36}/gu) ?? [content]) {
        if (part) yield { type: 'token', text: part };
      }
      yield {
        type: 'usage',
        usage: estimatedUsage(request.messages, content),
      };
      return;
    }
    const linked = linkedAbortSignal(request.signal, request.timeoutMs);
    try {
      const response = await this.fetcher(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(this.requestBody(request, true)),
        signal: linked.signal,
      });
      if (!response.ok) throw responseError(response.status);
      if (!response.body) {
        throw new AiClientError(
          '模型服务没有返回响应流',
          'INVALID_RESPONSE',
          false,
        );
      }
      const requestId = response.headers?.get('x-request-id') ?? undefined;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      let content = '';
      let usage: ProviderUsage | undefined;
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const parsed = takeSseEvents(buffer, done);
          buffer = parsed.rest;
          for (const data of parsed.events) {
            if (data === '[DONE]') {
              completed = true;
              break;
            }
            let payload: {
              choices?: Array<{ delta?: { content?: unknown } }>;
              usage?: ProviderUsage;
            };
            try {
              payload = JSON.parse(data) as typeof payload;
            } catch {
              throw new AiClientError(
                '模型流格式无效',
                'INVALID_RESPONSE',
                false,
              );
            }
            if (payload.usage) usage = payload.usage;
            const token = payload.choices?.[0]?.delta?.content;
            if (typeof token === 'string' && token) {
              content += token;
              yield { type: 'token', text: token };
            }
          }
          if (completed || done) break;
        }
      } finally {
        reader.releaseLock();
      }
      if (!completed) {
        throw new AiClientError(
          '模型流意外中断',
          'INVALID_RESPONSE',
          true,
        );
      }
      yield {
        type: 'usage',
        usage: normalizeUsage(usage, request.messages, content),
        providerRequestId: requestId,
      };
    } catch (error) {
      throw normalizeClientError(error, request.signal, linked.timedOut());
    } finally {
      linked.dispose();
    }
  }

  private endpoint() {
    return `${this.config.baseUrl.replace(/\/$/u, '')}/chat/completions`;
  }

  private filesEndpoint() {
    return `${this.config.baseUrl.replace(/\/$/u, '')}/files`;
  }

  private authorizationHeaders() {
    return { authorization: `Bearer ${this.config.apiKey}` };
  }

  private headers() {
    return {
      ...this.authorizationHeaders(),
      'content-type': 'application/json',
    };
  }

  private requestBody(request: AiRequest, stream: boolean) {
    const descriptor = describeStrategy(request.strategy);
    const body: Record<string, unknown> = {
      model: this.model(request.strategy, request.vision),
      messages: request.messages,
      stream,
      max_tokens: request.maxOutputTokens,
      thinking: descriptor.thinking,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (descriptor.reasoningEffort) {
      body.reasoning_effort = descriptor.reasoningEffort;
    }
    if (request.responseFormat) body.response_format = request.responseFormat;
    return body;
  }
}

interface ProviderUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
}

function invalidContentDetails(payload: {
  choices?: Array<{ finish_reason?: unknown }>;
  usage?: ProviderUsage;
}) {
  const details: string[] = [];
  const finishReason = payload.choices?.[0]?.finish_reason;
  if (
    typeof finishReason === 'string' &&
    /^[A-Za-z0-9_-]{1,40}$/u.test(finishReason)
  ) {
    details.push(`finish_reason=${finishReason}`);
  }
  const completionTokens = payload.usage?.completion_tokens;
  if (Number.isInteger(completionTokens) && (completionTokens as number) >= 0) {
    details.push(`completion_tokens=${completionTokens}`);
  }
  return details.join(', ');
}

function normalizeUsage(
  usage: ProviderUsage | undefined,
  messages: AiMessage[],
  content: string,
): AiUsage {
  if (
    Number.isInteger(usage?.prompt_tokens) &&
    (usage!.prompt_tokens as number) >= 0 &&
    Number.isInteger(usage?.completion_tokens) &&
    (usage!.completion_tokens as number) >= 0
  ) {
    return {
      inputTokens: usage!.prompt_tokens as number,
      outputTokens: usage!.completion_tokens as number,
      source: 'PROVIDER',
    };
  }
  return estimatedUsage(messages, content);
}

function estimatedUsage(messages: AiMessage[], content: string): AiUsage {
  return {
    inputTokens: estimateAiMessagesTokens(messages),
    outputTokens: estimateTokens(content),
    source: 'ESTIMATED',
  };
}

export function estimateAiMessagesTokens(messages: AiMessage[]) {
  return estimateTokens(
    messages
      .flatMap((message) =>
        typeof message.content === 'string'
          ? [message.content]
          : message.content
              .filter(
                (block): block is Extract<AiContentBlock, { type: 'text' }> =>
                  block.type === 'text',
              )
              .map((block) => block.text),
      )
      .join('\n'),
  );
}

export function estimateAiRequestTokens(request: AiRequest) {
  return (
    estimateAiMessagesTokens(request.messages) +
    (request.estimatedImageTokens ?? 0) +
    request.maxOutputTokens
  );
}

export function estimateTokens(value: string) {
  if (!value) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(value, 'utf8') / 4));
}

function normalizeProviderExpiry(value: unknown, fallbackSeconds: number) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
    const date = new Date(milliseconds);
    if (Number.isFinite(date.getTime())) return date;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return new Date(Date.now() + fallbackSeconds * 1_000);
}

function responseError(status: number) {
  if (status === 429) {
    return new AiClientError('模型服务请求过于频繁', 'RATE_LIMIT', true, status);
  }
  if (status >= 500) {
    return new AiClientError(
      `模型服务返回 ${status}`,
      'UPSTREAM_UNAVAILABLE',
      true,
      status,
    );
  }
  return new AiClientError(
    `模型服务拒绝请求 (${status})`,
    'UPSTREAM_REJECTED',
    false,
    status,
  );
}

function normalizeClientError(
  error: unknown,
  source: AbortSignal | undefined,
  timedOut: boolean,
) {
  if (error instanceof AiClientError) return error;
  if (source?.aborted) {
    return source.reason instanceof Error
      ? source.reason
      : new DOMException('AI 请求已取消', 'AbortError');
  }
  if (timedOut || isAbortError(error)) {
    return new AiClientError('模型服务请求超时', 'TIMEOUT', true);
  }
  return new AiClientError(
    '模型服务暂时不可用',
    'UPSTREAM_UNAVAILABLE',
    true,
  );
}

function isAbortError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

function linkedAbortSignal(source: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timeoutReached = false;
  const abort = () => controller.abort(source?.reason);
  if (source?.aborted) abort();
  else source?.addEventListener('abort', abort, { once: true });
  const safeTimeout =
    Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 600_000
      ? timeoutMs
      : 60_000;
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, safeTimeout);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose() {
      clearTimeout(timeout);
      source?.removeEventListener('abort', abort);
    },
  };
}

function takeSseEvents(buffer: string, flush: boolean) {
  const normalized = buffer.replace(/\r\n/gu, '\n');
  const parts = normalized.split('\n\n');
  const rest = flush ? '' : (parts.pop() ?? '');
  const events = parts
    .flatMap((part) =>
      part
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()),
    )
    .filter(Boolean);
  if (flush && parts.length === 0 && normalized.trim()) {
    events.push(
      ...normalized
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .filter(Boolean),
    );
  }
  return { events, rest };
}

const ajv = new Ajv({ allErrors: true, strict: true });

export function compileJsonSchema<T>(schema: object) {
  const validate = ajv.compile<T>(schema);
  return (value: unknown): { valid: true; value: T } | {
    valid: false;
    errors: ErrorObject[];
  } => {
    if (validate(value)) return { valid: true, value };
    return { valid: false, errors: validate.errors ?? [] };
  };
}

export function parseStrictJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new AiClientError(
      '模型输出必须是单一 JSON 对象',
      'INVALID_RESPONSE',
      false,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AiClientError(
      '模型输出不是有效 JSON',
      'INVALID_RESPONSE',
      false,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AiClientError(
      '模型输出必须是 JSON 对象',
      'INVALID_RESPONSE',
      false,
    );
  }
  return parsed as Record<string, unknown>;
}
