import {
  LLMError,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type LLMProvider,
  type ToolCall,
} from '../ports/llm.ts';

/**
 * Adaptador para endpoints compatíveis com a API da OpenAI
 * (`POST {baseUrl}/chat/completions`). Serve para Groq e Workers AI: só mudam
 * URL, chave, modelo e alguns parâmetros.
 */
export interface OpenAICompatibleOptions {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Nome do parâmetro de teto de saída aceito pelo provedor. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  /** Parâmetros extras (ex.: reasoning_effort na Groq). */
  extraBody?: Record<string, unknown>;
  temperature?: number;
  fetchFn?: typeof fetch;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const sec = Number(value);
  return Number.isFinite(sec) && sec >= 0 ? sec : undefined;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly provider: string;
  readonly model: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toOpenAIMessages(req.messages),
      temperature: this.opts.temperature ?? 0.3,
      [this.opts.maxTokensParam ?? 'max_tokens']: req.maxOutputTokens,
      ...this.opts.extraBody,
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new LLMError('timeout', `${this.provider} timeout após ${Date.now() - started} ms`);
      }
      throw new LLMError('network', `${this.provider} erro de rede`);
    }

    if (!res.ok) {
      // O corpo do erro não é registrado: pode ecoar parte do pedido.
      await res.body?.cancel();
      if (res.status === 429) {
        throw new LLMError('rate_limit', `${this.provider} 429`, 429, parseRetryAfter(res.headers.get('retry-after')));
      }
      throw new LLMError(res.status >= 500 ? 'server' : 'client', `${this.provider} HTTP ${res.status}`, res.status);
    }

    let json: OpenAIResponse;
    try {
      json = (await res.json()) as OpenAIResponse;
    } catch {
      throw new LLMError('invalid_response', `${this.provider} JSON inválido`);
    }
    const message = json.choices?.[0]?.message;
    if (!message) throw new LLMError('invalid_response', `${this.provider} sem choices`);

    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      arguments: c.function.arguments,
    }));
    return {
      content: message.content ?? '',
      toolCalls,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
      provider: this.provider,
      model: this.model,
      attempts: [],
    };
  }
}
