import type { ButtonsMessage, ListMessage } from '../ports/whatsapp.ts';
import type { Reply } from './engine.ts';

export type { ButtonsMessage, ListMessage };

// Botões de resposta (verificado em 2026-10-02): até 3, título ≤ 20, corpo ≤ 1.024.
export const BUTTON_LIMITS = { max: 3, title: 20, id: 256, body: 1024 } as const;

/** Monta os botões da resposta. null se não houver ou passar dos limites. */
export function buildButtonsMessage(reply: Reply): ButtonsMessage | null {
  const buttons = reply.buttons ?? [];
  if (buttons.length === 0 || buttons.length > BUTTON_LIMITS.max) return null;
  if (!reply.text || reply.text.length > BUTTON_LIMITS.body) return null;
  const ids = new Set<string>();
  for (const b of buttons) {
    if (!b.id || b.id.length > BUTTON_LIMITS.id || ids.has(b.id)) return null;
    if (!b.title || b.title.length > BUTTON_LIMITS.title) return null;
    ids.add(b.id);
  }
  return { body: reply.text, buttons: buttons.map((b) => ({ id: b.id, title: b.title })) };
}

// Lista interativa do WhatsApp (verificado em 2026-10-02, ARQUITETURA §16):
// até 10 linhas no total, botão ≤ 20, título da linha ≤ 24, descrição ≤ 72,
// corpo ≤ 1.024 caracteres. Usamos no máximo 6 linhas.

export const LIST_LIMITS = {
  maxRows: 6,
  button: 20,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
  body: 1024,
} as const;

/**
 * Monta a lista a partir das opções da resposta. Devolve null se não houver
 * opções ou se algo passar dos limites: aí a resposta sai como texto simples.
 */
export function buildListMessage(reply: Reply, button = reply.listButton ?? 'Ver opções'): ListMessage | null {
  const options = reply.options ?? [];
  if (options.length === 0 || options.length > LIST_LIMITS.maxRows) return null;
  if (!reply.text || reply.text.length > LIST_LIMITS.body || button.length > LIST_LIMITS.button) return null;
  const ids = new Set<string>();
  for (const o of options) {
    if (!o.id || o.id.length > LIST_LIMITS.rowId || ids.has(o.id)) return null;
    if (!o.title || o.title.length > LIST_LIMITS.rowTitle) return null;
    if (o.description && o.description.length > LIST_LIMITS.rowDescription) return null;
    ids.add(o.id);
  }
  return {
    body: reply.text,
    button,
    rows: options.map((o) => ({ id: o.id, title: o.title, ...(o.description ? { description: o.description } : {}) })),
  };
}

/**
 * Texto para pessoas: o toque numa opção é gravado como "título (slot|…)" para
 * a IA ver a referência; equipe e painel veem só o título.
 */
export function stripReplyRef(body: string): string {
  return body.replace(/\s\((?:slot|day|cal|rem|skip|confirm|cancel|resched)\|[^()]*\)$/, '');
}
