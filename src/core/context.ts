import type { StoredMessage } from '../ports/domain.ts';

// Estimativa de tokens por caracteres. Não há tokenizador no Worker (pesado
// demais para 10 ms de CPU). Português fica perto de 4 caracteres por token;
// 3,5 deixa uma margem. Calibrar com o `usage` real dos provedores.
const CHARS_PER_TOKEN = 3.5;
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;
}

/** Mensagens a mais, além de N, antes de gerar um novo resumo. */
export const SUMMARY_BATCH = 8;

export interface HistorySelection {
  messages: StoredMessage[];
  dropped: number;
  tokens: number;
}

/**
 * Escolhe o histórico que cabe no orçamento, das mais novas para as mais
 * antigas. `budgetTokens` vale para histórico + mensagens novas
 * (`reservedTokens`); o prompt de sistema tem tamanho limitado pelo cadastro
 * (base de conhecimento ≤ 4.000 caracteres).
 */
export function selectHistory(
  history: StoredMessage[],
  opts: { maxMessages: number; budgetTokens: number; reservedTokens: number },
): HistorySelection {
  let budget = opts.budgetTokens - opts.reservedTokens;
  const picked: StoredMessage[] = [];
  let tokens = 0;
  for (let i = history.length - 1; i >= 0 && picked.length < opts.maxMessages; i--) {
    const msg = history[i]!;
    const cost = estimateTokens(msg.body);
    if (cost > budget) break;
    budget -= cost;
    tokens += cost;
    picked.unshift(msg);
  }
  return { messages: picked, dropped: history.length - picked.length, tokens };
}
