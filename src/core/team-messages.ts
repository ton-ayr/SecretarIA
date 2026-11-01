import type { BookingNotice, HandoffRequest, RelayRequest } from '../ports/notifier.ts';
import { stripReplyRef } from './interactive.ts';
import { formatWaId } from '../shared/phone.ts';
import { REASON_LABELS } from './handoff.ts';

// Mensagens que a equipe recebe no Telegram (HTML do Telegram: só <, > e &
// precisam ser escapados). Texto do cliente sempre passa por escapeHtml.

const TELEGRAM_MAX = 4096;
const LINE_MAX = 400;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function who(contactName: string | null, waId: string): string {
  return `${escapeHtml(contactName ?? 'Cliente')} · ${formatWaId(waId)}`;
}

function fit(text: string): string {
  return text.length > TELEGRAM_MAX ? `${text.slice(0, TELEGRAM_MAX - 1)}…` : text;
}

export function formatHandoffAlert(req: HandoffRequest): string {
  const lines = [
    `🔔 <b>${escapeHtml(req.tenantName)}</b> · ${REASON_LABELS[req.reason]}`,
    `👤 ${who(req.contactName, req.waId)}`,
  ];
  if (req.summary) lines.push('', `📝 ${escapeHtml(clip(req.summary, LINE_MAX))}`);
  if (req.recentCustomerMessages.length) {
    lines.push('', '💬 Últimas mensagens:');
    for (const m of req.recentCustomerMessages) lines.push(`» ${escapeHtml(clip(stripReplyRef(m), LINE_MAX))}`);
  }
  lines.push('', 'Use <b>Responder</b> nesta mensagem para falar com o cliente pelo WhatsApp.');
  return fit(lines.join('\n'));
}

export function formatRelay(req: RelayRequest): string {
  const lines = [`💬 <b>${escapeHtml(req.contactName ?? 'Cliente')}</b> · ${escapeHtml(req.tenantName)}`];
  for (const m of req.messages) lines.push(escapeHtml(clip(stripReplyRef(m), LINE_MAX * 2)));
  return fit(lines.join('\n'));
}

const BOOKING_TITLES: Record<BookingNotice['change'], string> = {
  created: '📅 <b>Novo agendamento</b>',
  rescheduled: '🔁 <b>Agendamento remarcado</b>',
  cancelled: '❌ <b>Agendamento cancelado</b>',
};

export function formatBookingNotice(n: BookingNotice): string {
  return fit(
    [
      `${BOOKING_TITLES[n.change]} · ${escapeHtml(n.tenantName)}`,
      `🔹 ${escapeHtml(n.serviceName)} com ${escapeHtml(n.professionalLabel)}`,
      `🕒 ${escapeHtml(n.when)}`,
      `👤 ${who(n.contactName, n.waId)}`,
      `Código: ${escapeHtml(n.code)}`,
    ].join('\n'),
  );
}

export const TELEGRAM_TEXTS = {
  linked: (tenant: string) =>
    `Pronto! Os avisos da <b>${escapeHtml(tenant)}</b> vão chegar aqui.\nPara responder um cliente, use <b>Responder</b> na mensagem dele e escreva normalmente.`,
  operatorLinked: 'Pronto! Os alertas do operador da SecretárIA vão chegar aqui.',
  invalidLink: 'Este link é inválido ou já expirou. Peça um novo link.',
  notLinked: 'Este bot envia avisos da SecretárIA para as empresas cadastradas.',
  howToReply: 'Para falar com um cliente, use <b>Responder</b> na mensagem dele (arraste a mensagem para o lado) e escreva.',
  relayNotFound: 'Não encontrei a conversa dessa mensagem. Responda uma mensagem de cliente enviada por mim.',
  chatUnlinked: 'Este chat não está mais vinculado a essa empresa.',
  onlyText: 'Por enquanto só consigo repassar mensagens de texto.',
  windowClosed:
    '⚠️ Não entreguei: o cliente não fala com este número há mais de 24 horas, e o WhatsApp só permite mensagem livre dentro desse prazo.',
  sendFailed: '⚠️ Não consegui entregar agora. Tente de novo em alguns minutos.',
  resumed: 'Pronto! O bot voltou a responder este cliente.',
  conversationNotFound: 'Conversa não encontrada.',
} as const;
