import type { ChatRequest, ChatResponse, LLMProvider, ToolCall } from '../ports/llm.ts';

export type FakeStep =
  | { content: string; toolCalls?: ToolCall[]; usage?: { inputTokens: number; outputTokens: number } }
  | Error;

/** IA roteirizada para testes: devolve (ou lança) os passos em ordem. */
export class ScriptedLLM implements LLMProvider {
  readonly requests: ChatRequest[] = [];

  constructor(
    private readonly steps: FakeStep[] | ((req: ChatRequest, index: number) => FakeStep),
    readonly provider = 'fake',
    readonly model = 'scripted',
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const index = this.requests.length;
    this.requests.push(structuredClone(req));
    const step = typeof this.steps === 'function' ? this.steps(req, index) : this.steps[index];
    if (!step) throw new Error(`ScriptedLLM: sem passo ${index}`);
    if (step instanceof Error) throw step;
    return {
      content: step.content,
      toolCalls: step.toolCalls ?? [],
      usage: step.usage ?? { inputTokens: 100, outputTokens: 20 },
      provider: this.provider,
      model: this.model,
      attempts: [],
    };
  }
}

/** IA falsa do simulador (`--fake`): responde sem gastar cota. */
export class EchoLLM implements LLMProvider {
  readonly provider = 'fake';
  readonly model = 'echo';

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    const system = req.messages[0]?.role === 'system' ? req.messages[0].content : '';
    const name = /Você é ([^,]+),/.exec(system)?.[1] ?? 'atendente';
    const text = last?.content ?? '';
    return {
      content: `(${name}, IA falsa) Recebi: "${text.slice(0, 120)}"`,
      toolCalls: [],
      usage: { inputTokens: Math.ceil(system.length / 4), outputTokens: 20 },
      provider: this.provider,
      model: this.model,
      attempts: [],
    };
  }
}
