import type { Clock, Logger } from '../ports/runtime.ts';
import type { DueReminder, SchedulingOps } from '../ports/scheduling.ts';
import { WhatsAppError, type TemplateMessage, type WhatsAppSender } from '../ports/whatsapp.ts';
import { ulid } from '../shared/ids.ts';
import { addDaysToKey, formatAppointmentTime, localDateKey, monthKey } from '../shared/time.ts';
import { buildButtonsMessage } from './interactive.ts';
import { isServiceWindowOpen } from './window.ts';

/**
 * Lembrete um dia antes, para quem pediu ("🔔 Lembrete aqui") em empresa
 * com lembretes ligados. Roda no cron a cada 15 minutos.
 * - Janela de 24 h aberta: mensagem com botões (grátis).
 * - Fechada: template aprovado `lembrete_agendamento` (cobrado pela Meta).
 * O envio é reservado antes (claim), então dois crons não mandam em dobro.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Agendamentos que começam entre 23 h e 24 h 15 min a partir de agora. */
export const REMINDER_WINDOW = { fromMs: 23 * HOUR_MS, toMs: 24 * HOUR_MS + 15 * 60 * 1000 };
/** Marcado (ou remarcado) há menos disso: o cliente acabou de ver tudo. */
export const REMINDER_MIN_AGE_MS = HOUR_MS;

export const REMINDER_TEMPLATE = { name: 'lembrete_agendamento', language: 'pt_BR' } as const;

/**
 * Lembretes por rodada do cron. No plano grátis cada invocação tem 50
 * subrequisições, e consulta ao D1 conta: ~4 por lembrete (reserva, envio,
 * histórico) + busca e token. O que sobrar vai na rodada seguinte.
 */
export const REMINDER_BATCH = 8;

export interface ReminderMessageRecord {
  tenantId: string;
  conversationId: string;
  phoneNumberId: string;
  messageId: string;
  kind: 'interactive' | 'template';
  body: string;
  waMessageId: string;
  now: string;
  month: string;
}

export interface ReminderDeps {
  ops: SchedulingOps;
  sender: WhatsAppSender;
  /** Guarda o lembrete no histórico (a IA vê o contexto se o cliente responder). */
  saveMessage(record: ReminderMessageRecord): Promise<void>;
  clock: Clock;
  logger: Logger;
  /** Template aprovado; null = fora da janela não envia. */
  template: { name: string; language: string } | null;
}

export interface ReminderReport {
  due: number;
  free: number;
  template: number;
  skipped: number;
  failed: number;
}

function whenText(r: DueReminder, now: Date): string {
  const when = formatAppointmentTime(new Date(r.startsAt), r.timezone);
  const tomorrow = addDaysToKey(localDateKey(now, r.timezone), 1);
  return localDateKey(new Date(r.startsAt), r.timezone) === tomorrow ? `amanhã, ${when}` : when;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'tudo bem';
}

/** Texto e botões do lembrete dentro da janela (grátis). */
export function reminderReply(r: DueReminder, now: Date) {
  return {
    text: `🔔 Oi, ${firstName(r.customerName)}! Lembrete: ${whenText(r, now)}, você tem *${r.serviceName}* com ${r.professionalLabel} em ${r.tenantName}.\nPodemos confirmar?`,
    buttons: [
      { id: `confirm|${r.code}`, title: '✅ Confirmar' },
      { id: `resched|${r.code}`, title: '🔁 Remarcar' },
      { id: `cancel|${r.code}`, title: '❌ Cancelar' },
    ],
  };
}

/** Parâmetro de template: sem quebra de linha, tabulação ou 4+ espaços. */
function param(s: string, fallback: string): string {
  const clean = s.replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || fallback;
}

/**
 * Template aprovado na Meta (ver docs/OPERACAO.md):
 * "Olá, {{1}}! Lembrete do seu horário em {{2}}: {{3}}, {{4}}. Podemos confirmar?"
 * Botões de resposta rápida: Confirmar, Remarcar, Cancelar.
 */
export function reminderTemplate(r: DueReminder, now: Date, t: { name: string; language: string }): TemplateMessage {
  return {
    name: t.name,
    language: t.language,
    bodyParams: [
      param(firstName(r.customerName), 'cliente'),
      param(r.tenantName, 'nosso espaço'),
      param(`${r.serviceName} com ${r.professionalLabel}`, 'seu atendimento'),
      param(whenText(r, now), 'em breve'),
    ],
    quickReplyPayloads: [`confirm|${r.code}`, `resched|${r.code}`, `cancel|${r.code}`],
  };
}

function templateBody(t: TemplateMessage): string {
  const [name, place, what, when] = t.bodyParams;
  return `Olá, ${name}! Lembrete do seu horário em ${place}: ${what}, ${when}. Podemos confirmar?`;
}

/** Erro passageiro: libera a reserva e o próximo cron tenta de novo. */
const TRANSIENT = new Set(['rate_limit', 'server', 'network']);

type Sent = { kind: 'interactive' | 'template'; body: string; waMessageId: string };

/** Dentro da janela: botões (grátis). Fora: template, se configurado. */
async function deliver(r: DueReminder, now: Date, deps: ReminderDeps): Promise<Sent | null> {
  const { sender, template } = deps;
  const viaTemplate = async (): Promise<Sent> => {
    const t = reminderTemplate(r, now, template!);
    const res = await sender.sendTemplate(r.metaPhoneNumberId, r.waId, t);
    return { kind: 'template', body: templateBody(t), waMessageId: res.waMessageId };
  };
  if (!isServiceWindowOpen(r.lastCustomerMsgAt, now)) return template ? viaTemplate() : null;

  const reply = reminderReply(r, now);
  const buttons = buildButtonsMessage(reply);
  try {
    const res = buttons
      ? await sender.sendButtons(r.metaPhoneNumberId, r.waId, buttons)
      : await sender.sendText(r.metaPhoneNumberId, r.waId, reply.text);
    return { kind: 'interactive', body: reply.text, waMessageId: res.waMessageId };
  } catch (err) {
    // Janela fechou no meio do caminho: vai de template, se houver.
    if (err instanceof WhatsAppError && err.kind === 'window_closed' && template) return viaTemplate();
    throw err;
  }
}

async function remindOne(r: DueReminder, now: Date, deps: ReminderDeps): Promise<'free' | 'template' | 'skipped' | 'failed'> {
  const { ops, logger } = deps;
  const logBase = { tenant_id: r.tenantId, appointment_id: r.appointmentId };
  if (!(await ops.claimReminder(r.appointmentId, now.toISOString()))) return 'skipped';

  let sent: Sent | null;
  try {
    sent = await deliver(r, now, deps);
  } catch (err) {
    const kind = err instanceof WhatsAppError ? err.kind : 'network';
    const retry = TRANSIENT.has(kind);
    if (retry) await ops.releaseReminder(r.appointmentId);
    logger.error('reminder_failed', {
      ...logBase,
      error_code: kind,
      meta_code: err instanceof WhatsAppError ? err.metaCode : undefined,
      retry,
    });
    return 'failed';
  }
  if (!sent) {
    logger.warn('reminder_skipped_no_template', logBase);
    return 'skipped';
  }

  logger.info('reminder_sent', { ...logBase, kind: sent.kind });
  try {
    await deps.saveMessage({
      tenantId: r.tenantId,
      conversationId: r.conversationId,
      phoneNumberId: r.phoneNumberId,
      messageId: ulid(now.getTime()),
      kind: sent.kind,
      body: sent.body,
      waMessageId: sent.waMessageId,
      now: now.toISOString(),
      month: monthKey(now),
    });
  } catch (err) {
    // Já saiu: só registra (não reenviar).
    logger.error('reminder_save_failed', { ...logBase, error_code: err instanceof Error ? err.name : 'unknown' });
  }
  return sent.kind === 'template' ? 'template' : 'free';
}

export async function sendDueReminders(deps: ReminderDeps): Promise<ReminderReport> {
  const now = deps.clock.now();
  const due = await deps.ops.dueReminders(
    new Date(now.getTime() + REMINDER_WINDOW.fromMs).toISOString(),
    new Date(now.getTime() + REMINDER_WINDOW.toMs).toISOString(),
    new Date(now.getTime() - REMINDER_MIN_AGE_MS).toISOString(),
    REMINDER_BATCH,
  );
  const report: ReminderReport = { due: due.length, free: 0, template: 0, skipped: 0, failed: 0 };
  // Um por vez: poucos por rodada e sem estourar o limite da Meta.
  for (const r of due) report[await remindOne(r, now, deps)] += 1;
  return report;
}
