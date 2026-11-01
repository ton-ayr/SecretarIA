// Janela de atendimento de 24 horas da Meta: texto livre (e mensagens
// interativas) só até 24h depois da última mensagem do cliente. Fora dela,
// só template aprovado.

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Margem para não enviar no limite exato (relógios e filas). */
const SAFETY_MARGIN_MS = 60 * 1000;

export function isServiceWindowOpen(lastCustomerMsgAt: string | null, now: Date): boolean {
  if (!lastCustomerMsgAt) return false;
  const last = Date.parse(lastCustomerMsgAt);
  if (!Number.isFinite(last)) return false;
  return now.getTime() - last < SERVICE_WINDOW_MS - SAFETY_MARGIN_MS;
}
