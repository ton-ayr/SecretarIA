import { LLMError, type ChatRequest, type ChatResponse, type LLMAttempt, type LLMProvider } from '../ports/llm.ts';

/**
 * Cadeia de reserva (ARQUITETURA §5):
 * - 5xx, timeout ou rede: até 2 novas tentativas (1 s e 3 s + variação);
 * - 429: pula direto para o próximo e marca o provedor como esgotado;
 * - outro 4xx ou resposta inválida: próximo provedor, sem nova tentativa;
 * - orçamento total por turno; se tudo falhar, lança LLMError.
 */

/** Lembra quais provedores estão esgotados. Uma instância por isolate/objeto. */
export class ProviderHealth {
  private readonly exhaustedUntil = new Map<string, number>();

  isExhausted(key: string, nowMs: number): boolean {
    const until = this.exhaustedUntil.get(key);
    return until !== undefined && until > nowMs;
  }

  markExhausted(key: string, untilMs: number): void {
    this.exhaustedUntil.set(key, untilMs);
  }
}

export interface ChainOptions {
  perAttemptTimeoutMs?: number;
  totalBudgetMs?: number;
  retryDelaysMs?: number[];
  jitterMs?: number;
  /** Quanto tempo um provedor fica fora após 429 sem `retry-after`. */
  exhaustedDefaultMs?: number;
  health?: ProviderHealth;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** Uma tentativa com menos tempo que isto não vale a pena. */
const MIN_ATTEMPT_MS = 3_000;

export class FallbackChain implements LLMProvider {
  readonly provider = 'chain';
  readonly model = 'chain';
  readonly health: ProviderHealth;
  private readonly o: Required<Omit<ChainOptions, 'health'>>;

  constructor(
    private readonly providers: LLMProvider[],
    options: ChainOptions = {},
  ) {
    this.health = options.health ?? new ProviderHealth();
    this.o = {
      perAttemptTimeoutMs: options.perAttemptTimeoutMs ?? 20_000,
      totalBudgetMs: options.totalBudgetMs ?? 45_000,
      retryDelaysMs: options.retryDelaysMs ?? [1_000, 3_000],
      jitterMs: options.jitterMs ?? 300,
      exhaustedDefaultMs: options.exhaustedDefaultMs ?? 5 * 60_000,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const { o } = this;
    const deadline = o.now() + Math.min(req.timeoutMs, o.totalBudgetMs);
    const attempts: LLMAttempt[] = [];
    let lastError: LLMError | null = null;

    for (const p of this.providers) {
      const key = `${p.provider}:${p.model}`;
      if (this.health.isExhausted(key, o.now())) continue;

      for (let attempt = 0; attempt <= o.retryDelaysMs.length; attempt++) {
        const remaining = deadline - o.now();
        if (remaining < MIN_ATTEMPT_MS) throw this.fail(lastError, attempts, 'orçamento de tempo esgotado');

        const t0 = o.now();
        try {
          const res = await p.chat({ ...req, timeoutMs: Math.min(o.perAttemptTimeoutMs, remaining) });
          attempts.push({ provider: p.provider, model: p.model, ok: true, ms: o.now() - t0 });
          return { ...res, attempts };
        } catch (err) {
          const e = err instanceof LLMError ? err : new LLMError('invalid_response', 'erro inesperado no provedor');
          lastError = e;
          attempts.push({
            provider: p.provider,
            model: p.model,
            ok: false,
            ms: o.now() - t0,
            errorKind: e.kind,
            ...(e.status !== undefined ? { status: e.status } : {}),
          });

          if (e.kind === 'rate_limit') {
            const waitMs = e.retryAfterSec !== undefined ? e.retryAfterSec * 1000 : o.exhaustedDefaultMs;
            this.health.markExhausted(key, o.now() + Math.max(waitMs, 10_000));
            break;
          }
          if (e.kind === 'client' || e.kind === 'invalid_response') break;

          // timeout, server ou network: nova tentativa se houver espera e tempo.
          const delay = o.retryDelaysMs[attempt];
          if (delay === undefined) break;
          const wait = delay + Math.floor(o.random() * o.jitterMs);
          if (deadline - o.now() - wait < MIN_ATTEMPT_MS) break;
          await o.sleep(wait);
        }
      }
    }
    throw this.fail(lastError, attempts, 'todos os provedores falharam');
  }

  private fail(last: LLMError | null, attempts: LLMAttempt[], msg: string): LLMError {
    return new LLMError(last?.kind ?? 'server', msg, last?.status, last?.retryAfterSec, attempts);
  }
}
