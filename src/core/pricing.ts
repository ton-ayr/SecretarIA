import type { LLMUsage } from '../ports/llm.ts';

// Preço em US$ por milhão de tokens, para o "custo se fosse pago".
// Fonte: ARQUITETURA §16 (verificado em 2026-10-01 e 2026-10-02).
export type PricingTable = Record<string, { inputUsdPerM: number; outputUsdPerM: number }>;

export const DEFAULT_PRICING: PricingTable = {
  'groq:openai/gpt-oss-120b': { inputUsdPerM: 0.15, outputUsdPerM: 0.6 },
  'groq:openai/gpt-oss-20b': { inputUsdPerM: 0.075, outputUsdPerM: 0.3 },
  'workersai:@cf/openai/gpt-oss-120b': { inputUsdPerM: 0.35, outputUsdPerM: 0.75 },
};

/** Custo em micro-dólares (US$ 1 = 1.000.000). */
export function estimateCostMicros(pricing: PricingTable, provider: string, model: string, usage: LLMUsage): number {
  const price = pricing[`${provider}:${model}`];
  if (!price) return 0;
  // tokens × (US$/milhão) = micro-dólares
  return Math.round(usage.inputTokens * price.inputUsdPerM + usage.outputTokens * price.outputUsdPerM);
}

// Transcrição: US$ por minuto de áudio (verificado em 2026-10-03).
export type SttPricingTable = Record<string, { usdPerMinute: number; minBilledSeconds?: number }>;

export const DEFAULT_STT_PRICING: SttPricingTable = {
  // US$ 0,04 por hora; a Groq cobra no mínimo 10 s por pedido.
  'groq:whisper-large-v3-turbo': { usdPerMinute: 0.04 / 60, minBilledSeconds: 10 },
  'workersai:@cf/openai/whisper-large-v3-turbo': { usdPerMinute: 0.000513 },
};

export function estimateSttCostMicros(pricing: SttPricingTable, provider: string, model: string, seconds: number): number {
  const price = pricing[`${provider}:${model}`];
  if (!price) return 0;
  const billed = Math.max(seconds, price.minBilledSeconds ?? 0);
  return Math.round((billed / 60) * price.usdPerMinute * 1_000_000);
}
