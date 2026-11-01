import { describe, expect, it } from 'vitest';
import { ScriptedLLM } from '../src/adapters/fake-llm.ts';
import { FallbackChain, ProviderHealth } from '../src/adapters/llm-chain.ts';
import { buildLLMChain } from '../src/adapters/llm-config.ts';
import { OpenAICompatibleProvider } from '../src/adapters/openai-compatible.ts';
import { LLMError, type ChatRequest } from '../src/ports/llm.ts';

const REQ: ChatRequest = {
  messages: [{ role: 'user', content: 'oi' }],
  maxOutputTokens: 100,
  timeoutMs: 45_000,
};

/** Relógio falso: sleep avança o tempo sem esperar de verdade. */
function fakeTime() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    advance: (ms: number) => (now += ms),
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

describe('cadeia de reserva', () => {
  it('usa o primeiro provedor quando dá certo', async () => {
    const a = new ScriptedLLM([{ content: 'A' }], 'groq', 'a');
    const b = new ScriptedLLM([{ content: 'B' }], 'groq', 'b');
    const res = await new FallbackChain([a, b]).chat(REQ);
    expect(res.content).toBe('A');
    expect(res.attempts).toEqual([expect.objectContaining({ provider: 'groq', model: 'a', ok: true })]);
    expect(b.requests).toHaveLength(0);
  });

  it('erro 5xx: tenta de novo com espera crescente e depois consegue', async () => {
    const t = fakeTime();
    const a = new ScriptedLLM([new LLMError('server', '500', 500), new LLMError('timeout', 't'), { content: 'ok' }]);
    const chain = new FallbackChain([a], { sleep: t.sleep, now: t.now, random: () => 0 });
    const res = await chain.chat(REQ);
    expect(res.content).toBe('ok');
    expect(t.sleeps).toEqual([1_000, 3_000]);
    expect(res.attempts.map((x) => x.ok)).toEqual([false, false, true]);
  });

  it('falha → nova tentativa → reserva', async () => {
    const t = fakeTime();
    const a = new ScriptedLLM(() => new LLMError('server', '503', 503), 'groq', 'a');
    const b = new ScriptedLLM([{ content: 'reserva' }], 'workersai', 'b');
    const res = await new FallbackChain([a, b], { sleep: t.sleep, now: t.now, random: () => 0 }).chat(REQ);
    expect(a.requests).toHaveLength(3);
    expect(res.content).toBe('reserva');
    expect(res.provider).toBe('workersai');
  });

  it('429 pula direto para o próximo e deixa o provedor de fora por um tempo', async () => {
    const t = fakeTime();
    const health = new ProviderHealth();
    const a = new ScriptedLLM(() => new LLMError('rate_limit', '429', 429, 120), 'groq', 'a');
    const b = new ScriptedLLM(() => ({ content: 'B' }), 'groq', 'b');
    const chain = new FallbackChain([a, b], { sleep: t.sleep, now: t.now, health });

    expect((await chain.chat(REQ)).content).toBe('B');
    expect(a.requests).toHaveLength(1);
    expect(t.sleeps).toEqual([]);

    // Dentro dos 120 s, nem tenta o provedor esgotado.
    t.advance(60_000);
    await chain.chat(REQ);
    expect(a.requests).toHaveLength(1);

    // Depois do prazo, volta a tentar.
    t.advance(61_000);
    await chain.chat(REQ);
    expect(a.requests).toHaveLength(2);
  });

  it('4xx (que não é 429) não tenta de novo', async () => {
    const a = new ScriptedLLM(() => new LLMError('client', '400', 400), 'groq', 'a');
    const b = new ScriptedLLM([{ content: 'B' }], 'groq', 'b');
    await new FallbackChain([a, b]).chat(REQ);
    expect(a.requests).toHaveLength(1);
  });

  it('tudo falhando lança LLMError com todas as tentativas', async () => {
    const t = fakeTime();
    const a = new ScriptedLLM(() => new LLMError('server', '500', 500), 'groq', 'a');
    const b = new ScriptedLLM(() => new LLMError('rate_limit', '429', 429), 'groq', 'b');
    const chain = new FallbackChain([a, b], { sleep: t.sleep, now: t.now, random: () => 0 });
    const err = await chain.chat(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect((err as LLMError).attempts).toHaveLength(4);
  });

  it('respeita o orçamento total de tempo', async () => {
    const t = fakeTime();
    const a = new ScriptedLLM(() => {
      t.advance(20_000);
      return new LLMError('timeout', 't');
    });
    const chain = new FallbackChain([a], { sleep: t.sleep, now: t.now, random: () => 0, totalBudgetMs: 45_000 });
    await expect(chain.chat(REQ)).rejects.toBeInstanceOf(LLMError);
    // 20 s + 1 s de espera + 20 s = 41 s; não sobra tempo para a terceira.
    expect(a.requests).toHaveLength(2);
    expect(a.requests[1]!.timeoutMs).toBeLessThanOrEqual(20_000);
  });
});

describe('adaptador OpenAI-compatível', () => {
  function provider(fetchFn: typeof fetch) {
    return new OpenAICompatibleProvider({
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'chave',
      maxTokensParam: 'max_completion_tokens',
      extraBody: { reasoning_effort: 'low' },
      fetchFn,
    });
  }

  it('monta o corpo e lê conteúdo, ferramentas e uso', async () => {
    let sent: { url: string; body: Record<string, unknown>; auth: string | null } | null = null;
    const p = provider(async (url, init) => {
      sent = {
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get('authorization'),
      };
      return Response.json({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 7 },
      });
    });
    const res = await p.chat({
      ...REQ,
      tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
    });
    expect(sent!.url).toBe('https://api.example.com/v1/chat/completions');
    expect(sent!.auth).toBe('Bearer chave');
    expect(sent!.body).toMatchObject({
      model: 'openai/gpt-oss-120b',
      max_completion_tokens: 100,
      reasoning_effort: 'low',
      tool_choice: 'auto',
    });
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'f', arguments: '{"a":1}' }]);
    expect(res.usage).toEqual({ inputTokens: 50, outputTokens: 7 });
  });

  it('converte 429 com retry-after, 5xx e 4xx em LLMError', async () => {
    const r429 = await provider(async () => new Response('x', { status: 429, headers: { 'retry-after': '30' } }))
      .chat(REQ)
      .catch((e: LLMError) => e);
    expect(r429).toMatchObject({ kind: 'rate_limit', status: 429, retryAfterSec: 30 });

    const r503 = await provider(async () => new Response('x', { status: 503 }))
      .chat(REQ)
      .catch((e: LLMError) => e);
    expect(r503).toMatchObject({ kind: 'server', status: 503 });

    const r401 = await provider(async () => new Response('x', { status: 401 }))
      .chat(REQ)
      .catch((e: LLMError) => e);
    expect(r401).toMatchObject({ kind: 'client', status: 401 });
  });

  it('converte timeout e resposta inválida', async () => {
    const timeout = await provider(async () => {
      throw new DOMException('t', 'TimeoutError');
    })
      .chat(REQ)
      .catch((e: LLMError) => e);
    expect(timeout).toMatchObject({ kind: 'timeout' });

    const invalid = await provider(async () => Response.json({ choices: [] }))
      .chat(REQ)
      .catch((e: LLMError) => e);
    expect(invalid).toMatchObject({ kind: 'invalid_response' });
  });
});

describe('configuração da cadeia', () => {
  it('monta a cadeia na ordem e ignora provedores sem chave', () => {
    const built = buildLLMChain({
      LLM_CHAIN: 'groq:openai/gpt-oss-120b, groq:openai/gpt-oss-20b ,workersai:@cf/openai/gpt-oss-120b',
      GROQ_BASE_URL: 'https://api.groq.com/openai/v1',
      GROQ_API_KEY: 'k',
      WORKERSAI_BASE_URL: 'https://x/{account_id}/ai/v1',
      WORKERSAI_ACCOUNT_ID: '',
    });
    expect(built.providers.map((p) => `${p.provider}:${p.model}`)).toEqual([
      'groq:openai/gpt-oss-120b',
      'groq:openai/gpt-oss-20b',
    ]);
    expect(built.skipped).toEqual(['workersai:@cf/openai/gpt-oss-120b']);
  });
});
