import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1Repo } from '../src/adapters/d1-repo.ts';
import { ScriptedLLM } from '../src/adapters/fake-llm.ts';
import { ConversationEngine, type TurnInput, type TurnResult } from '../src/core/engine.ts';
import { DEFAULT_PRICING } from '../src/core/pricing.ts';
import { parseDateArg, parseTimeArg } from '../src/core/scheduling.ts';
import type { ExternalBusy, ExternalCalendar, ExternalEvent } from '../src/ports/calendar.ts';
import { externalEventId } from '../src/ports/calendar.ts';
import type { BookingNotice, HandoffNotifier } from '../src/ports/notifier.ts';
import { MemoryLogger } from '../src/shared/logger.ts';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';

const TZ = 'America/Sao_Paulo';
// Terça, 13/10/2026, 08:00 em São Paulo. A barbearia abre terça a sábado.
let clockMs = Date.parse('2026-10-13T11:00:00.000Z');
let mem: LocalPlatform;
let repo: D1Repo;
let wa = 0;

beforeAll(async () => {
  mem = await createMemoryDb({ seed: true });
  repo = new D1Repo(mem.db);
});
afterAll(() => mem.dispose());

class FakeCalendar implements ExternalCalendar {
  busyList: ExternalBusy[] = [];
  upserts: Array<{ calendarId: string; event: ExternalEvent }> = [];
  deletes: Array<{ calendarId: string; eventId: string }> = [];
  async busy() {
    return this.busyList;
  }
  async upsertEvent(calendarId: string, event: ExternalEvent) {
    this.upserts.push({ calendarId, event });
  }
  async deleteEvent(calendarId: string, eventId: string) {
    this.deletes.push({ calendarId, eventId });
  }
}

class FakeTeam implements HandoffNotifier {
  bookings: BookingNotice[] = [];
  async notifyHandoff() {
    return 1;
  }
  async relayCustomerMessages() {
    return 1;
  }
  async notifyBooking(n: BookingNotice) {
    this.bookings.push(n);
    return 1;
  }
}

function setup(llm = new ScriptedLLM([]), calendar?: FakeCalendar) {
  const team = new FakeTeam();
  const engine = new ConversationEngine({
    repo,
    llm,
    clock: { now: () => new Date((clockMs += 1_000)) },
    logger: new MemoryLogger(),
    notifier: team,
    scheduling: { calendar, publicBaseUrl: 'https://bot.test' },
    config: { pricing: DEFAULT_PRICING, quotaLimits: {}, logHashKey: 'k' },
  });
  return { engine, llm, team };
}

function newWa() {
  wa += 1;
  return `5519988${String(wa).padStart(6, '0')}`;
}

function text(waId: string, body: string, profileName: string | null = 'Caio'): TurnInput {
  return {
    metaPhoneNumberId: SEED.barber.metaPhoneNumberId,
    waId,
    profileName,
    messages: [{ text: body, waMessageId: `w.${waId}.${clockMs}`, at: new Date(clockMs).toISOString() }],
  };
}

function tap(waId: string, replyId: string, title = 'opção', profileName: string | null = 'Caio'): TurnInput {
  return {
    metaPhoneNumberId: SEED.barber.metaPhoneNumberId,
    waId,
    profileName,
    messages: [
      { text: title, kind: 'interactive', replyId, waMessageId: `t.${waId}.${clockMs}`, at: new Date(clockMs).toISOString() },
    ],
  };
}

const callTool = (name: string, args: Record<string, unknown>) => ({
  content: '',
  toolCalls: [{ id: `c-${name}`, name, arguments: JSON.stringify(args) }],
});

const codeOf = (r: TurnResult) => /Código: ([A-Z0-9]{6})/.exec(r.reply!.text)?.[1] ?? '';

async function appointment(code: string) {
  return mem.db.prepare('SELECT * FROM appointments WHERE code = ?').bind(code).first<Record<string, unknown>>();
}

describe('datas e horas dos argumentos', () => {
  const now = new Date('2026-10-13T11:00:00.000Z');
  it('entende AAAA-MM-DD, hoje, amanhã, DD/MM e dia da semana', () => {
    expect(parseDateArg('2026-10-20', now, TZ)).toBe('2026-10-20');
    expect(parseDateArg('hoje', now, TZ)).toBe('2026-10-13');
    expect(parseDateArg('Amanhã', now, TZ)).toBe('2026-10-14');
    expect(parseDateArg('15/10', now, TZ)).toBe('2026-10-15');
    expect(parseDateArg('sábado', now, TZ)).toBe('2026-10-17');
    expect(parseDateArg('31/02', now, TZ)).toBeNull();
    // Como o cliente fala (hoje é terça, 13/10).
    expect(parseDateArg('quarta-feira', now, TZ)).toBe('2026-10-14');
    expect(parseDateArg('na quarta', now, TZ)).toBe('2026-10-14');
    expect(parseDateArg('terça', now, TZ)).toBe('2026-10-13');
    expect(parseDateArg('próxima terça', now, TZ)).toBe('2026-10-20');
    expect(parseDateArg('terça que vem', now, TZ)).toBe('2026-10-20');
    expect(parseDateArg('depois de amanhã', now, TZ)).toBe('2026-10-15');
    expect(parseDateArg('dia 15', now, TZ)).toBe('2026-10-15');
    expect(parseDateArg('dia 2', now, TZ)).toBe('2026-11-02');
    expect(parseDateArg('15/10/2026', now, TZ)).toBe('2026-10-15');
    expect(parseDateArg('semana que vem', now, TZ)).toBeNull();
    expect(parseDateArg('constructor', now, TZ)).toBeNull();
    expect(parseDateArg('tomorrow', now, TZ)).toBe('2026-10-14');
    expect(parseTimeArg('15 h 30')).toBe(930);
    expect(parseTimeArg(`1${' '.repeat(5000)}x`)).toBeNull();
    expect(parseTimeArg('15:30')).toBe(930);
    expect(parseTimeArg('9h')).toBe(540);
    expect(parseTimeArg('25:00')).toBeNull();
  });
});

describe('agenda pela conversa', () => {
  it('ver horários: o servidor manda a lista (a IA não escreve horários)', async () => {
    const { engine, llm } = setup(new ScriptedLLM([callTool('check_availability', { servico: 'corte masculino', data: '2026-10-14' })]));
    const r = await engine.handleTurn(text(newWa(), 'tem horário amanhã pra corte?'));
    expect(llm.requests).toHaveLength(1);
    expect(r.reply!.text).toContain('Horários livres para *Corte masculino* (R$ 45,00) amanhã (14/10)');
    expect(r.reply!.listButton).toBe('Ver horários');
    expect(r.reply!.options).toHaveLength(6);
    expect(r.reply!.options![0]).toMatchObject({ title: 'qua 14/10 · 09:00' });
    expect(r.reply!.options![0]!.id).toMatch(/^slot\|01K6SEED00000000000000SA01\|.+\|2026-10-14T12:00:00\.000Z$/);
    expect(r.action).toBeNull();
    expect(llm.requests[0]!.messages[0]!.content).toContain('amanhã qua 14/10 = 2026-10-14');
  });

  it('ver horários perto da hora pedida', async () => {
    const { engine } = setup(new ScriptedLLM([callTool('check_availability', { servico: 'Barba', data: '2026-10-21', hora: '15:00' })]));
    const r = await engine.handleTurn(text(newWa(), 'barba quarta 21 lá pelas 15h?'));
    const times = r.reply!.options!.map((o) => o.title.slice(-5));
    expect(times).toContain('15:00');
    expect(times.every((t) => t >= '13:30' && t <= '16:30')).toBe(true);
    expect(r.reply!.text).not.toContain('não tenho vaga');

    // Hora ocupada (folga dos dois às 15:00–16:00): avisa e mostra as vizinhas.
    await mem.db
      .prepare(
        "INSERT INTO time_off (id, tenant_id, professional_id, starts_at, ends_at) VALUES ('OFF-T1', ?, NULL, '2026-10-21T18:00:00.000Z', '2026-10-21T19:00:00.000Z')",
      )
      .bind(SEED.barber.tenantId)
      .run();
    const busy = await setup(
      new ScriptedLLM([callTool('check_availability', { servico: 'Barba', data: '2026-10-21', hora: '15:00' })]),
    ).engine.handleTurn(text(newWa(), 'barba quarta 21 às 15h?'));
    expect(busy.reply!.text).toMatch(/^Às 15:00 não tenho vaga\. Horários livres para \*Barba\*/);
    expect(busy.reply!.options!.map((o) => o.title.slice(-5))).not.toContain('15:00');
  });

  it('toque no horário marca na hora, sem IA, com resumo e botões', async () => {
    const { engine, llm, team } = setup();
    const waId = newWa();
    const ref = `slot|01K6SEED00000000000000SA01|01K6SEED00000000000000RA02|2026-10-14T13:00:00.000Z`;
    const r = await engine.handleTurn(tap(waId, ref, 'ter 14/10 · 10:00'));
    expect(llm.requests).toHaveLength(0);
    expect(r.action).toBe('booked');
    expect(r.reply!.text).toContain('✅ Agendado!');
    expect(r.reply!.text).toContain('*Corte masculino* com Barbeiro Rafael');
    expect(r.reply!.text).toContain('quarta-feira, 14/10 às 10:00');
    expect(r.reply!.text).toContain('R$ 45,00');
    expect(r.reply!.text).toContain('Rua das Palmeiras, 120');
    // Lembretes desligados na empresa: só "salvar na agenda" e "não precisa".
    expect(r.reply!.buttons!.map((b) => b.title)).toEqual(['📅 Salvar na agenda', 'Não precisa']);

    const a = await appointment(codeOf(r));
    expect(a).toMatchObject({ status: 'booked', customer_name: 'Caio', starts_at: '2026-10-14T13:00:00.000Z', calendar_sync: 'none' });
    expect(r.postJobs).toEqual([{ kind: 'notify_booking', tenantId: SEED.barber.tenantId, appointmentId: a!.id, change: 'created' }]);
    await engine.runPostJobs(r.postJobs);
    expect(team.bookings[0]).toMatchObject({ change: 'created', serviceName: 'Corte masculino', when: 'quarta-feira, 14/10 às 10:00' });
  });

  it('o mesmo cliente pedindo de novo o mesmo horário: "Já está marcado", sem duplicar', async () => {
    const waId = newWa();
    const ref = `slot|01K6SEED00000000000000SA01|01K6SEED00000000000000RA01|2026-10-24T13:00:00.000Z`;
    const first = await setup().engine.handleTurn(tap(waId, ref));
    const again = await setup(
      new ScriptedLLM([callTool('book', { servico: 'Corte masculino', data: '2026-10-24', hora: '10:00' })]),
    ).engine.handleTurn(text(waId, 'corte masculino mesmo'));
    expect(again.action).toBeNull();
    expect(again.postJobs).toEqual([]);
    expect(again.reply!.text).toContain('✅ Já está marcado!');
    expect(codeOf(again)).toBe(codeOf(first));
  });

  it('dois clientes no mesmo horário: só o primeiro marca', async () => {
    const { engine } = setup();
    const ref = `slot|01K6SEED00000000000000SA02|01K6SEED00000000000000RA01|2026-10-15T14:00:00.000Z`;
    const first = await engine.handleTurn(tap(newWa(), ref));
    const second = await engine.handleTurn(tap(newWa(), ref));
    expect(first.action).toBe('booked');
    expect(second.action).toBeNull();
    expect(second.reply!.text).toContain('Esse horário não está disponível.');
    expect(second.reply!.options!.some((o) => o.id === ref)).toBe(false);
  });

  it('sem nome conhecido, a IA pergunta antes de marcar', async () => {
    const { engine, llm } = setup(
      new ScriptedLLM([
        callTool('book', { servico: 'barba', data: '2026-10-16', hora: '11:00' }),
        { content: 'Claro! Qual o seu nome para eu marcar?' },
      ]),
    );
    const r = await engine.handleTurn(text(newWa(), 'quero barba sexta às 11h', null));
    expect(r.action).toBeNull();
    expect(r.reply!.text).toBe('Claro! Qual o seu nome para eu marcar?');
    const toolMsg = llm.requests[1]!.messages.at(-1)!;
    expect(toolMsg.content).toContain('nome_necessario');
  });

  it('marcação pela IA com data e hora, guardando o nome informado', async () => {
    const { engine } = setup(
      new ScriptedLLM([callTool('book', { servico: 'Barba', data: '2026-10-16', hora: '11:00', profissional: 'Barbeiro Zé', nome_cliente: 'Ana Paula' })]),
    );
    const waId = newWa();
    const r = await engine.handleTurn(text(waId, 'sou a Ana Paula, quero barba sexta 11h com o Zé', null));
    expect(r.action).toBe('booked');
    expect(r.reply!.text).toContain('com Barbeiro Zé');
    const contact = await mem.db.prepare('SELECT display_name FROM contacts WHERE wa_id = ?').bind(waId).first();
    expect(contact).toEqual({ display_name: 'Ana Paula' });
  });

  it('nome dito por texto vale para a marcação por toque (bug do teste real)', async () => {
    const waId = newWa();
    // 1) Cliente corrige o nome; a IA guarda e responde.
    const first = setup(
      new ScriptedLLM([callTool('save_customer_name', { nome: 'Luna Reis' }), { content: 'Prazer, Luna! Qual serviço e dia?' }]),
    );
    const r1 = await first.engine.handleTurn(text(waId, 'na verdade meu nome é Luna Reis', 'Caio'));
    expect(r1.reply!.text).toBe('Prazer, Luna! Qual serviço e dia?');
    // 2) Toque num horário da lista: marca sem IA, com o nome informado.
    const booked = await setup().engine.handleTurn(
      tap(waId, `slot|01K6SEED00000000000000SA02|01K6SEED00000000000000RA02|2026-10-23T13:00:00.000Z`, 'opção', 'Caio'),
    );
    expect((await appointment(codeOf(booked)))!.customer_name).toBe('Luna Reis');

    // nome_cliente em check_availability também guarda.
    const waId2 = newWa();
    await setup(
      new ScriptedLLM([callTool('check_availability', { servico: 'Barba', data: '2026-10-23', nome_cliente: 'Ana' })]),
    ).engine.handleTurn(text(waId2, 'sou a Ana, tem barba sexta 23?', 'Caio'));
    const contact = await mem.db.prepare('SELECT display_name FROM contacts WHERE wa_id = ?').bind(waId2).first();
    expect(contact).toEqual({ display_name: 'Ana' });
  });

  it('serviço ambíguo volta para a IA perguntar', async () => {
    const { engine, llm } = setup(
      new ScriptedLLM([callTool('check_availability', { servico: 'corte', data: '2026-10-14' }), { content: 'Corte masculino ou corte + barba?' }]),
    );
    const r = await engine.handleTurn(text(newWa(), 'quero um corte amanhã'));
    expect(r.reply!.text).toBe('Corte masculino ou corte + barba?');
    expect(llm.requests[1]!.messages.at(-1)!.content).toContain('Serviço ambíguo');
  });

  it('dia fechado: sugere os próximos dias em botões; tocar mostra os horários', async () => {
    const { engine } = setup(new ScriptedLLM([callTool('check_availability', { servico: 'Corte masculino', data: '2026-10-19' })]));
    const waId = newWa();
    const r = await engine.handleTurn(text(waId, 'tem segunda dia 19?'));
    expect(r.reply!.text).toContain('Não atendemos na segunda-feira, 19/10.');
    expect(r.reply!.buttons!.map((b) => b.title)).toEqual(['ter 20/10', 'qua 21/10', 'qui 22/10']);
    const day = await setup().engine.handleTurn(tap(waId, r.reply!.buttons![0]!.id, 'ter 20/10'));
    expect(day.reply!.text).toContain('na terça-feira, 20/10');
    expect(day.reply!.options!.length).toBeGreaterThan(0);
  });

  it('botões depois de marcar: salvar na agenda, lembrete e cancelar', async () => {
    const { engine } = setup();
    const waId = newWa();
    const booked = await engine.handleTurn(tap(waId, `slot|01K6SEED00000000000000SA03|01K6SEED00000000000000RA01|2026-10-17T13:00:00.000Z`));
    const code = codeOf(booked);
    const a = await appointment(code);

    const cal = await engine.handleTurn(tap(waId, `cal|${code}`, '📅 Salvar na agenda'));
    expect(cal.reply!.text).toContain(`https://bot.test/a/${a!.calendar_token}`);
    expect(await repo.schedulingOps.findByCalendarToken(String(a!.calendar_token))).toEqual({
      status: 'booked',
      startsAt: '2026-10-17T13:00:00.000Z',
      endsAt: a!.ends_at,
      serviceName: 'Corte + barba',
      professionalLabel: 'Barbeiro Zé',
      tenantName: expect.any(String),
      address: expect.stringContaining('Rua das Palmeiras'),
      timezone: TZ,
    });
    expect(await repo.schedulingOps.findByCalendarToken('naoexiste0000000000000')).toBeNull();

    const remOff = await engine.handleTurn(tap(waId, `rem|${code}`));
    expect(remOff.reply!.text).toContain('ainda não estão disponíveis');
    await mem.db.prepare('UPDATE tenants SET reminders_enabled = 1 WHERE id = ?').bind(SEED.barber.tenantId).run();
    const remOn = await engine.handleTurn(tap(waId, `rem|${code}`));
    expect(remOn.reply!.text).toContain('🔔 Combinado!');
    expect((await appointment(code))!.reminder_opt_in).toBe(1);
    await mem.db.prepare('UPDATE tenants SET reminders_enabled = 0 WHERE id = ?').bind(SEED.barber.tenantId).run();

    // Outro cliente não mexe no agendamento de ninguém.
    const intruder = await engine.handleTurn(tap(newWa(), `cancel|${code}`));
    expect(intruder.action).toBeNull();
    expect((await appointment(code))!.status).toBe('booked');

    const cancel = await engine.handleTurn(tap(waId, `cancel|${code}`, 'Cancelar'));
    expect(cancel.action).toBe('cancelled');
    expect(cancel.reply!.text).toContain('Cancelado: *Corte + barba*');
    expect((await appointment(code))!.status).toBe('cancelled');
  });

  it('meus horários e remarcação pela IA', async () => {
    const waId = newWa();
    const booked = await setup().engine.handleTurn(
      tap(waId, `slot|01K6SEED00000000000000SA01|01K6SEED00000000000000RA02|2026-10-17T14:00:00.000Z`),
    );
    const code = codeOf(booked);

    const list = await setup(new ScriptedLLM([callTool('list_my_appointments', {})])).engine.handleTurn(text(waId, 'quais meus horários?'));
    expect(list.reply!.text).toContain(`(código ${code})`);
    expect(list.reply!.buttons!.map((b) => b.id)).toEqual([`resched|${code}`, `cancel|${code}`]);

    const { engine } = setup(new ScriptedLLM([callTool('reschedule', { codigo: code, data: '2026-10-17', hora: '15:00' })]));
    const r = await engine.handleTurn(text(waId, 'pode passar pras 15h?'));
    expect(r.action).toBe('rescheduled');
    expect(r.reply!.text).toContain('🔁 Remarcado!');
    expect(r.reply!.text).toContain('sábado, 17/10 às 15:00');
    expect((await appointment(code))!.status).toBe('cancelled');
    const newCode = codeOf(r);
    expect(await appointment(newCode)).toMatchObject({ status: 'booked', starts_at: '2026-10-17T18:00:00.000Z' });
  });

  it('agenda Google: bloqueios tiram horários e eventos são criados e apagados', async () => {
    await mem.db.prepare("UPDATE tenants SET google_calendar_id = 'barbearia@gmail.com' WHERE id = ?").bind(SEED.barber.tenantId).run();
    const calendar = new FakeCalendar();
    // Dono bloqueou 09:00–12:00 de quinta (22/10) no Google.
    calendar.busyList = [{ start: '2026-10-22T09:00:00-03:00', end: '2026-10-22T12:00:00-03:00' }];
    const { engine } = setup(new ScriptedLLM([callTool('check_availability', { servico: 'Barba', data: '2026-10-22' })]), calendar);
    const waId = newWa();
    const r = await engine.handleTurn(text(waId, 'barba quinta 22?'));
    expect(r.reply!.options![0]!.title).toBe('qui 22/10 · 12:00');

    const booked = await setup(new ScriptedLLM([]), calendar).engine.handleTurn(tap(waId, r.reply!.options![0]!.id));
    const a = await appointment(codeOf(booked));
    expect(a!.calendar_sync).toBe('pending');
    const e1 = setup(new ScriptedLLM([]), calendar).engine;
    await e1.runPostJobs(booked.postJobs);
    expect(calendar.upserts[0]).toMatchObject({
      calendarId: 'barbearia@gmail.com',
      event: { id: externalEventId(String(a!.id)), summary: 'Barba · Caio', timeZone: TZ, start: '2026-10-22T15:00:00.000Z' },
    });
    expect((await appointment(codeOf(booked)))!.calendar_sync).toBe('synced');

    const cancel = await e1.handleTurn(tap(waId, `cancel|${codeOf(booked)}`));
    await e1.runPostJobs(cancel.postJobs);
    expect(calendar.deletes).toEqual([{ calendarId: 'barbearia@gmail.com', eventId: externalEventId(String(a!.id)) }]);
    await mem.db.prepare('UPDATE tenants SET google_calendar_id = NULL WHERE id = ?').bind(SEED.barber.tenantId).run();
  });
});
