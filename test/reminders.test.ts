import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D1Repo } from '../src/adapters/d1-repo.ts';
import { ScriptedLLM } from '../src/adapters/fake-llm.ts';
import { ConversationEngine, type TurnResult } from '../src/core/engine.ts';
import { DEFAULT_PRICING } from '../src/core/pricing.ts';
import { REMINDER_TEMPLATE, sendDueReminders, type ReminderDeps } from '../src/core/reminders.ts';
import {
  WhatsAppError,
  type ButtonsMessage,
  type ListMessage,
  type TemplateMessage,
  type WhatsAppErrorKind,
  type WhatsAppSender,
} from '../src/ports/whatsapp.ts';
import { MemoryLogger } from '../src/shared/logger.ts';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';

let mem: LocalPlatform;
let repo: D1Repo;
let wa = 0;
// Terça, 13/10/2026, 08:00 em São Paulo.
const BOOKED_AT = Date.parse('2026-10-13T11:00:00.000Z');
// Quarta 14/10, 10:00 em São Paulo.
const STARTS = '2026-10-14T13:00:00.000Z';
const REF = `slot|01K6SEED00000000000000SA01|01K6SEED00000000000000RA02|${STARTS}`;

beforeAll(async () => {
  mem = await createMemoryDb({ seed: true });
  repo = new D1Repo(mem.db);
  await mem.db.prepare('UPDATE tenants SET reminders_enabled = 1 WHERE id = ?').bind(SEED.barber.tenantId).run();
});
afterAll(() => mem.dispose());
beforeEach(async () => {
  // Cada teste com a agenda livre.
  await mem.db.prepare("UPDATE appointments SET status = 'cancelled'").run();
});

class FakeSender implements WhatsAppSender {
  buttons: ButtonsMessage[] = [];
  templates: TemplateMessage[] = [];
  texts: string[] = [];
  failButtons: WhatsAppErrorKind | null = null;
  failTemplate: WhatsAppErrorKind | null = null;
  private n = 0;
  async sendText(_f: string, _t: string, body: string) {
    this.texts.push(body);
    return { waMessageId: `wamid.r.${++this.n}.${Date.now()}` };
  }
  async sendList(_f: string, _t: string, _l: ListMessage) {
    return { waMessageId: `wamid.r.${++this.n}.${Date.now()}` };
  }
  async sendButtons(_f: string, _t: string, m: ButtonsMessage) {
    if (this.failButtons) throw new WhatsAppError(this.failButtons, 'falhou', 400, 131047);
    this.buttons.push(m);
    return { waMessageId: `wamid.r.${++this.n}.${Date.now()}` };
  }
  async sendTemplate(_f: string, _t: string, m: TemplateMessage) {
    if (this.failTemplate) throw new WhatsAppError(this.failTemplate, 'falhou', 500);
    this.templates.push(m);
    return { waMessageId: `wamid.r.${++this.n}.${Date.now()}` };
  }
  async markReadWithTyping() {}
}

async function book(): Promise<{ code: string; id: string; conversationId: string }> {
  wa += 1;
  const waId = `5519977${String(wa).padStart(6, '0')}`;
  let t = BOOKED_AT;
  const engine = new ConversationEngine({
    repo,
    llm: new ScriptedLLM([]),
    clock: { now: () => new Date((t += 1000)) },
    logger: new MemoryLogger(),
    scheduling: { publicBaseUrl: 'https://bot.test' },
    config: { pricing: DEFAULT_PRICING, quotaLimits: {}, logHashKey: 'k' },
  });
  const turn = (replyId: string): Promise<TurnResult> =>
    engine.handleTurn({
      metaPhoneNumberId: SEED.barber.metaPhoneNumberId,
      waId,
      profileName: 'Maria Clara',
      messages: [{ text: 'opção', kind: 'interactive', replyId, waMessageId: `w.${waId}.${t}`, at: new Date(t).toISOString() }],
    });
  const booked = await turn(REF);
  const code = /Código: ([A-Z0-9]{6})/.exec(booked.reply!.text)![1]!;
  const rem = await turn(`rem|${code}`);
  expect(rem.reply!.text).toContain('🔔 Combinado!');
  const row = await mem.db
    .prepare('SELECT id, conversation_id, reminder_opt_in FROM appointments WHERE code = ?')
    .bind(code)
    .first<{ id: string; conversation_id: string; reminder_opt_in: number }>();
  expect(row!.reminder_opt_in).toBe(1);
  return { code, id: row!.id, conversationId: row!.conversation_id };
}

function deps(sender: FakeSender, at: string, template: ReminderDeps['template'] = null) {
  const logger = new MemoryLogger();
  const d: ReminderDeps = {
    ops: repo.schedulingOps,
    sender,
    saveMessage: ({ tenantId, ...record }) => repo.forTenant(tenantId).saveBotMessage(record),
    clock: { now: () => new Date(at) },
    logger,
    template,
  };
  return { d, logger };
}

const reminderSentAt = async (id: string) =>
  (await mem.db.prepare('SELECT reminder_sent_at FROM appointments WHERE id = ?').bind(id).first<{ reminder_sent_at: string | null }>())!
    .reminder_sent_at;

describe('lembrete um dia antes', () => {
  it('dentro da janela: botões grátis, uma vez só, e fica no histórico', async () => {
    const a = await book();
    const sender = new FakeSender();
    // 23,5 h antes; o cliente falou há 2,5 h (janela aberta).
    const { d, logger } = deps(sender, '2026-10-13T13:30:00.000Z');
    expect(await sendDueReminders(d)).toEqual({ due: 1, free: 1, template: 0, skipped: 0, failed: 0 });
    expect(sender.buttons[0]!.body).toBe(
      '🔔 Oi, Maria! Lembrete: amanhã, quarta-feira, 14/10 às 10:00, você tem *Corte masculino* com Barbeiro Rafael em Barbearia do Zé.\nPodemos confirmar?',
    );
    expect(sender.buttons[0]!.buttons.map((b) => b.id)).toEqual([`confirm|${a.code}`, `resched|${a.code}`, `cancel|${a.code}`]);
    expect(await reminderSentAt(a.id)).toBe('2026-10-13T13:30:00.000Z');
    const saved = await mem.db
      .prepare("SELECT author, kind, body FROM messages WHERE conversation_id = ? AND kind = 'interactive' AND body LIKE '🔔%'")
      .bind(a.conversationId)
      .first();
    expect(saved).toMatchObject({ author: 'bot', kind: 'interactive' });
    expect(JSON.stringify(logger.lines)).not.toContain('Maria');

    // Próxima rodada do cron: nada de novo.
    const again = deps(sender, '2026-10-13T13:45:00.000Z');
    expect(await sendDueReminders(again.d)).toMatchObject({ due: 0, free: 0 });
    expect(sender.buttons).toHaveLength(1);
  });

  it('marcado há menos de 1 hora ou fora do intervalo: não manda', async () => {
    await book();
    const sender = new FakeSender();
    // 25 h antes: cedo demais.
    expect(await sendDueReminders(deps(sender, '2026-10-13T12:00:00.000Z').d)).toMatchObject({ due: 0 });
    // Marcado às 11:00Z; às 11:30Z ainda não passou 1 hora (e já está no intervalo).
    expect(await sendDueReminders(deps(sender, '2026-10-13T11:30:00.000Z').d)).toMatchObject({ due: 0 });
  });

  it('janela fechada: sem template não envia; com template envia o modelo', async () => {
    const a = await book();
    await mem.db.prepare("UPDATE conversations SET last_customer_msg_at = '2026-10-12T10:00:00.000Z' WHERE id = ?").bind(a.conversationId).run();
    const sender = new FakeSender();
    const off = deps(sender, '2026-10-13T13:30:00.000Z');
    expect(await sendDueReminders(off.d)).toMatchObject({ due: 1, skipped: 1 });
    expect(sender.buttons).toHaveLength(0);
    expect(off.logger.lines.map((l) => l.event)).toContain('reminder_skipped_no_template');

    // Libera o horário para marcar de novo, agora com template.
    await mem.db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").bind(a.id).run();
    const b = await book();
    await mem.db.prepare("UPDATE conversations SET last_customer_msg_at = '2026-10-12T10:00:00.000Z' WHERE id = ?").bind(b.conversationId).run();
    const on = deps(sender, '2026-10-13T13:30:00.000Z', REMINDER_TEMPLATE);
    expect(await sendDueReminders(on.d)).toMatchObject({ template: 1 });
    expect(sender.templates[0]).toEqual({
      name: 'lembrete_agendamento',
      language: 'pt_BR',
      bodyParams: ['Maria', 'Barbearia do Zé', 'Corte masculino com Barbeiro Rafael', 'amanhã, quarta-feira, 14/10 às 10:00'],
      quickReplyPayloads: [`confirm|${b.code}`, `resched|${b.code}`, `cancel|${b.code}`],
    });
  });

  it('janela fechou no meio do caminho: cai para o template', async () => {
    await book();
    const sender = new FakeSender();
    sender.failButtons = 'window_closed';
    expect(await sendDueReminders(deps(sender, '2026-10-13T13:30:00.000Z', REMINDER_TEMPLATE).d)).toMatchObject({ template: 1 });
    expect(sender.templates).toHaveLength(1);
  });

  it('erro passageiro libera para a próxima rodada; erro definitivo não repete', async () => {
    const a = await book();
    const sender = new FakeSender();
    sender.failButtons = 'server';
    const first = deps(sender, '2026-10-13T13:30:00.000Z');
    expect(await sendDueReminders(first.d)).toMatchObject({ failed: 1 });
    expect(await reminderSentAt(a.id)).toBeNull();
    expect(first.logger.lines.find((l) => l.event === 'reminder_failed')).toMatchObject({ retry: true });

    sender.failButtons = 'recipient';
    expect(await sendDueReminders(deps(sender, '2026-10-13T13:45:00.000Z').d)).toMatchObject({ failed: 1 });
    expect(await reminderSentAt(a.id)).not.toBeNull();
    sender.failButtons = null;
    expect(await sendDueReminders(deps(sender, '2026-10-13T14:00:00.000Z').d)).toMatchObject({ due: 0 });
  });

  it('conversa pelo número simulador (chat de teste do painel) não recebe lembrete', async () => {
    await book();
    await mem.db.prepare("UPDATE phone_numbers SET kind = 'test' WHERE id = ?").bind(SEED.barber.phoneNumberId).run();
    const sender = new FakeSender();
    expect(await sendDueReminders(deps(sender, '2026-10-13T13:30:00.000Z').d)).toMatchObject({ due: 0 });
    await mem.db.prepare("UPDATE phone_numbers SET kind = 'whatsapp' WHERE id = ?").bind(SEED.barber.phoneNumberId).run();
    expect(await sendDueReminders(deps(sender, '2026-10-13T13:30:00.000Z').d)).toMatchObject({ due: 1, free: 1 });
  });

  it('cancelado ou empresa com lembrete desligado: não manda', async () => {
    const a = await book();
    await mem.db.prepare('UPDATE tenants SET reminders_enabled = 0 WHERE id = ?').bind(SEED.barber.tenantId).run();
    const sender = new FakeSender();
    expect(await sendDueReminders(deps(sender, '2026-10-13T13:30:00.000Z').d)).toMatchObject({ due: 0 });
    await mem.db.prepare('UPDATE tenants SET reminders_enabled = 1 WHERE id = ?').bind(SEED.barber.tenantId).run();
    await mem.db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").bind(a.id).run();
    expect(await sendDueReminders(deps(sender, '2026-10-13T13:30:00.000Z').d)).toMatchObject({ due: 0 });
  });

  it('pedido de lembrete para horário muito próximo não promete o que não vai cumprir', async () => {
    wa += 1;
    const waId = `5519977${String(wa).padStart(6, '0')}`;
    let t = Date.parse('2026-10-14T01:00:00.000Z'); // 13/10 22:00 local; horário às 10:00 do dia 14
    const engine = new ConversationEngine({
      repo,
      llm: new ScriptedLLM([]),
      clock: { now: () => new Date((t += 1000)) },
      logger: new MemoryLogger(),
      scheduling: { publicBaseUrl: 'https://bot.test' },
      config: { pricing: DEFAULT_PRICING, quotaLimits: {}, logHashKey: 'k' },
    });
    const turn = (replyId: string) =>
      engine.handleTurn({
        metaPhoneNumberId: SEED.barber.metaPhoneNumberId,
        waId,
        profileName: 'Caio',
        messages: [{ text: 'opção', kind: 'interactive', replyId, waMessageId: `w.${waId}.${t}`, at: new Date(t).toISOString() }],
      });
    const booked = await turn(REF);
    const code = /Código: ([A-Z0-9]{6})/.exec(booked.reply!.text)![1]!;
    const rem = await turn(`rem|${code}`);
    expect(rem.reply!.text).toContain('Seu horário já está pertinho');
    const row = await mem.db.prepare('SELECT reminder_opt_in FROM appointments WHERE code = ?').bind(code).first();
    expect(row).toEqual({ reminder_opt_in: 0 });
  });
});

describe('nova tentativa da agenda Google', () => {
  it('só pega pendentes parados há mais de 5 minutos', async () => {
    const a = await book();
    await mem.db
      .prepare("UPDATE appointments SET status = 'booked', calendar_sync = 'failed', calendar_sync_attempts = 1, updated_at = ? WHERE id = ?")
      .bind('2026-10-13T11:00:00.000Z', a.id)
      .run();
    expect(await repo.schedulingOps.pendingCalendarSync(10, '2026-10-13T10:59:00.000Z')).toEqual([]);
    expect(await repo.schedulingOps.pendingCalendarSync(10, '2026-10-13T11:05:00.000Z')).toEqual([
      { appointmentId: a.id, tenantId: SEED.barber.tenantId },
    ]);
    await mem.db.prepare('UPDATE appointments SET calendar_sync_attempts = 5 WHERE id = ?').bind(a.id).run();
    expect(await repo.schedulingOps.pendingCalendarSync(10, '2026-10-13T11:05:00.000Z')).toEqual([]);
  });
});
