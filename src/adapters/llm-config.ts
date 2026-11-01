import type { LLMProvider } from '../ports/llm.ts';
import { FallbackChain, type ChainOptions } from './llm-chain.ts';
import { OpenAICompatibleProvider } from './openai-compatible.ts';

/** Variáveis de ambiente que configuram a IA (vars + secrets do Wrangler). */
export interface LLMEnv {
  LLM_CHAIN?: string;
  GROQ_BASE_URL?: string;
  GROQ_API_KEY?: string;
  WORKERSAI_BASE_URL?: string;
  WORKERSAI_ACCOUNT_ID?: string;
  WORKERSAI_API_KEY?: string;
}

export interface BuiltChain {
  chain: FallbackChain;
  providers: LLMProvider[];
  /** Entradas de LLM_CHAIN ignoradas por falta de chave ou provedor desconhecido. */
  skipped: string[];
}

/**
 * Lê LLM_CHAIN ("groq:openai/gpt-oss-120b,workersai:@cf/openai/gpt-oss-120b")
 * e monta a cadeia. O provedor é o texto antes do primeiro ":".
 */
export function buildLLMChain(env: LLMEnv, options?: ChainOptions): BuiltChain {
  const providers: LLMProvider[] = [];
  const skipped: string[] = [];
  const entries = (env.LLM_CHAIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const sep = entry.indexOf(':');
    const provider = entry.slice(0, sep);
    const model = entry.slice(sep + 1);
    if (sep <= 0 || !model) {
      skipped.push(entry);
      continue;
    }
    if (provider === 'groq' && env.GROQ_API_KEY && env.GROQ_BASE_URL) {
      providers.push(
        new OpenAICompatibleProvider({
          provider,
          model,
          baseUrl: env.GROQ_BASE_URL,
          apiKey: env.GROQ_API_KEY,
          maxTokensParam: 'max_completion_tokens',
          // gpt-oss: raciocínio curto (mais rápido, menos tokens) e sem
          // devolver o texto do raciocínio.
          extraBody: model.includes('gpt-oss') ? { reasoning_effort: 'low', include_reasoning: false } : {},
        }),
      );
    } else if (provider === 'workersai' && env.WORKERSAI_API_KEY && env.WORKERSAI_ACCOUNT_ID && env.WORKERSAI_BASE_URL) {
      providers.push(
        new OpenAICompatibleProvider({
          provider,
          model,
          baseUrl: env.WORKERSAI_BASE_URL.replace('{account_id}', env.WORKERSAI_ACCOUNT_ID),
          apiKey: env.WORKERSAI_API_KEY,
          maxTokensParam: 'max_tokens',
        }),
      );
    } else {
      skipped.push(entry);
    }
  }
  return { chain: new FallbackChain(providers, options), providers, skipped };
}
