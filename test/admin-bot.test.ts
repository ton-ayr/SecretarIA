import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1Repo } from '../src/adapters/d1-repo.ts';
import { ScriptedLLM } from '../src/adapters/fake-llm.ts';
import { listWabaPhoneNumbers, MetaGraphError } from '../src/adapters/meta-graph.ts';
import { checkCalendarAccess } from '../src/core/calendar-check.ts';
import { ConversationEngine } from '../src/core/engine.ts';
import { eraseContactData } from '../src/core/erasure.ts';
import { DEFAULT_PRICING } from '../src/core/pricing.ts';
import { readOnlyCalendar, runTestTurn, silentTeamNotifier } from '../src/core/test-chat.ts';
import { TEST_WA_ID, testPhoneMetaId } from '../src/ports/admin.ts';
import type { ExternalBusy, ExternalCalendar, ExternalEvent } from '../src/ports/calendar.ts';
import { externalEventId } from '../src/ports/calendar.ts';
import { MemoryLogger } from '../src/shared/logger.ts';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';

class FakeCalendar implements ExternalCalendar {
  busyList: ExternalBusy[] = [];
  upserts: ExternalEvent[] = [];
  deletes: string[] = [];
  failBusy = false;
  failWrite = false;
  async busy() {
    if (this.failBusy) throw new Error('403');
    return this.busyList;
  }
  async upsertEvent(_c: string, e: ExternalEvent) {
    if (this.failWrite) throw new Error('403');
    this.upserts.push(e);
  }
  async deleteEvent(_c: string, id: string) {
    this.deletes.push(id);
  }
}

let mem: LocalPlatform;
let repo: D1Repo;
let clockMs = Date.parse('2026-10-13T11:00:00.000Z'); // terça, 08:00 em São Paulo
const clock = { now: () => new Date((clockMs += 1000)) };

beforeAll(async () => {
  mem = await createMemoryDb({ seed: true });
  repo = new D1Repo(mem.db);
});
afterAll(() => mem.dispose());

function engine(llm: ScriptedLLM, calendar?: ExternalCalendar) {
  return new ConversationEngine({
    repo,
    llm,
    clock,
    logger: new MemoryLogger(),
    notifier: silentTeamNotifier,
    scheduling: { calendar: readOnlyCalendar(calendar), publicBaseUrl: 'https://bot.test' },
    config: { pricing: DEFAULT_PRICING, quotaLimits: {}, logHashKey: 'k' },
  });
}

describe('chat de teste do painel', () => {
  it('conversa pelo número simulador, sem mandar nada nem escrever no Google', async () => {
    const calendar = new FakeCalendar();
    await mem.db.prepare("UPDATE tenants SET google_calendar_id = 'barbearia@gmail.com' WHERE id = ?").bind(SEED.barber.tenantId).run();
    const e = engine(new ScriptedLLM([{ content: 'Oi! Sou o Zeca. Como posso ajudar?' }]), calendar);
    const deps = { repo, engine: e, clock };

    const r1 = await runTestTurn(SEED.barber.tenantId, { text: 'oi' }, deps);
    expect(r1).toMatchObject({ outcome: 'replied', reply: { text: 'Oi! Sou o Zeca. Como posso ajudar?' }, handoff: false });
    const phone = await mem.db
      .prepare('SELECT kind, display_phone FROM phone_numbers WHERE meta_phone_number_id = ?')
      .bind(testPhoneMetaId(SEED.barber.tenantId))
      .first();
    expect(phone).toEqual({ kind: 'test', display_phone: 'Simulador' });

    // Toque num horário: marca de verdade no D1, mas não cria evento no Google.
    const ref = 'slot|01K6SEED00000000000000SA01|01K6SEED00000000000000RA02|2026-10-14T13:00:00.000Z';
    const r2 = await runTestTurn(SEED.barber.tenantId, { replyId: ref, title: 'qua 14/10 · 10:00' }, deps);
    expect(r2.action).toBe('booked');
    expect(r2.reply!.buttons!.map((b) => b.title)).toContain('📅 Salvar na agenda');
    expect(calendar.upserts).toEqual([]);

    // "Limpar teste": apaga a conversa e o horário (a agenda volta a ficar livre).
    const report = await eraseContactData(SEED.barber.tenantId, TEST_WA_ID, {
      repo,
      logger: new MemoryLogger(),
      wipeConversation: async () => {
        throw new Error('não deveria chamar o objeto da conversa no teste');
      },
    });
    expect(report).toMatchObject({ contacts: 1, conversations: 1, appointments: 1, stateWipeFailures: 0 });
    const left = await mem.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE wa_id = 'teste'").first();
    expect(left).toEqual({ n: 0 });
    await mem.db.prepare('UPDATE tenants SET google_calendar_id = NULL WHERE id = ?').bind(SEED.barber.tenantId).run();
  });

  it('mensagem vazia não chama a IA', async () => {
    const llm = new ScriptedLLM([]);
    const r = await runTestTurn(SEED.barber.tenantId, { text: '   ' }, { repo, engine: engine(llm), clock });
    expect(r.outcome).toBe('empty');
    expect(llm.requests).toHaveLength(0);
  });
});

describe('exclusão dos dados de um contato (LGPD)', () => {
  it('apaga D1, eventos da agenda e o estado da conversa', async () => {
    const waId = '5519933334444';
    const calendar = new FakeCalendar();
    await mem.db.prepare("UPDATE tenants SET google_calendar_id = 'barbearia@gmail.com' WHERE id = ?").bind(SEED.barber.tenantId).run();
    const real = new ConversationEngine({
      repo,
      llm: new ScriptedLLM([{ content: 'Oi!' }]),
      clock,
      logger: new MemoryLogger(),
      scheduling: { calendar, publicBaseUrl: 'https://bot.test' },
      config: { pricing: DEFAULT_PRICING, quotaLimits: {}, logHashKey: 'k' },
    });
    const at = () => new Date(clockMs).toISOString();
    await real.handleTurn({ metaPhoneNumberId: SEED.barber.metaPhoneNumberId, waId, profileName: 'Bia', messages: [{ text: 'oi', waMessageId: 'w.e1', at: at() }] });
    const booked = await real.handleTurn({
      metaPhoneNumberId: SEED.barber.metaPhoneNumberId,
      waId,
      profileName: 'Bia',
      messages: [
        { text: 'opção', kind: 'interactive', replyId: 'slot|01K6SEED00000000000000SA02|01K6SEED00000000000000RA01|2026-10-15T14:00:00.000Z', waMessageId: 'w.e2', at: at() },
      ],
    });
    await real.runPostJobs(booked.postJobs);
    expect(calendar.upserts).toHaveLength(1);
    const apptId = String((await mem.db.prepare("SELECT id FROM appointments WHERE customer_name = 'Bia'").first<{ id: string }>())!.id);

    const wiped: string[] = [];
    const report = await eraseContactData(SEED.barber.tenantId, waId, {
      repo,
      calendar,
      logger: new MemoryLogger(),
      wipeConversation: async (meta, wa) => {
        wiped.push(`${meta}:${wa}`);
      },
    });
    expect(report).toMatchObject({ contacts: 1, conversations: 1, appointments: 1, calendarEvents: 1, calendarFailures: 0 });
    expect(report.messages).toBeGreaterThanOrEqual(4);
    expect(calendar.deletes).toEqual([externalEventId(apptId)]);
    expect(wiped).toEqual([`${SEED.barber.metaPhoneNumberId}:${waId}`]);

    // Nenhuma linha com esse telefone sobra no D1.
    for (const [table, where] of [
      ['contacts', 'wa_id = ?'],
      ['conversations', 'contact_id IN (SELECT id FROM contacts WHERE wa_id = ?)'],
      ['appointments', "customer_name = 'Bia' OR ? = ''"],
    ] as const) {
      const r = await mem.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(waId).first();
      expect(r, table).toEqual({ n: 0 });
    }
    const msgs = await mem.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = 'oi' AND conversation_id NOT IN (SELECT id FROM conversations)").first();
    expect(msgs).toEqual({ n: 0 });
    await mem.db.prepare('UPDATE tenants SET google_calendar_id = NULL WHERE id = ?').bind(SEED.barber.tenantId).run();
  });

  it('outra empresa não apaga o contato de ninguém', async () => {
    const waId = '5519955556666';
    await mem.db
      .prepare("INSERT INTO contacts (id, tenant_id, wa_id, last_seen_at, created_at) VALUES ('CT-X', ?, ?, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')")
      .bind(SEED.barber.tenantId, waId)
      .run();
    const report = await eraseContactData(SEED.dental.tenantId, waId, { repo, logger: new MemoryLogger(), wipeConversation: async () => {} });
    expect(report.contacts).toBe(0);
    expect(await mem.db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE wa_id = ?').bind(waId).first()).toEqual({ n: 1 });
  });

  it('pedido do terminal some junto com os dados', async () => {
    const waId = '5519977778888';
    await mem.db.batch([
      mem.db.prepare("INSERT INTO contacts (id, tenant_id, wa_id, last_seen_at, created_at) VALUES ('CT-Y', ?, ?, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')").bind(SEED.barber.tenantId, waId),
      mem.db.prepare("INSERT INTO erasure_requests (id, tenant_id, wa_id, requested_at) VALUES ('ER1', ?, ?, '2026-10-13T00:00:00.000Z')").bind(SEED.barber.tenantId, waId),
    ]);
    expect(await repo.ops.pendingErasures(3)).toEqual([{ tenantId: SEED.barber.tenantId, waId }]);
    await eraseContactData(SEED.barber.tenantId, waId, { repo, logger: new MemoryLogger(), wipeConversation: async () => {} });
    expect(await repo.ops.pendingErasures(3)).toEqual([]);
  });
});

describe('teste de acesso à agenda Google', () => {
  const now = new Date('2026-10-13T11:00:00.000Z');
  it('lê, escreve e apaga o evento de teste', async () => {
    const cal = new FakeCalendar();
    cal.busyList = [{ start: '2026-10-14T12:00:00Z', end: '2026-10-14T13:00:00Z' }];
    expect(await checkCalendarAccess(cal, 'x@gmail.com', now)).toEqual({ read: true, write: true, busy: 1, problem: null });
    expect(cal.deletes).toEqual([cal.upserts[0]!.id]);
  });
  it('explica o problema de leitura e de escrita', async () => {
    const cal = new FakeCalendar();
    cal.failBusy = true;
    expect(await checkCalendarAccess(cal, 'x@gmail.com', now)).toMatchObject({ read: false, problem: expect.stringContaining('compartilhada') });
    cal.failBusy = false;
    cal.failWrite = true;
    expect(await checkCalendarAccess(cal, 'x@gmail.com', now)).toMatchObject({ read: true, write: false, problem: expect.stringContaining('Fazer alterações') });
  });
});

describe('números da conta Meta', () => {
  it('lê a lista da Graph API', async () => {
    let url = '';
    let auth = '';
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      auth = new Headers(init?.headers).get('authorization') ?? '';
      return Response.json({
        data: [
          { id: '100000000000020', display_phone_number: '+1 555-000-0100', verified_name: 'Teste', quality_rating: 'GREEN', code_verification_status: 'VERIFIED' },
          { id: 'invalido', display_phone_number: 'x' },
        ],
      });
    }) as typeof fetch;
    const numbers = await listWabaPhoneNumbers({ graphVersion: 'v26.0', token: 'tok', wabaId: '100000000000010', fetchFn });
    expect(url).toBe(
      'https://graph.facebook.com/v26.0/100000000000010/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status&limit=50',
    );
    expect(auth).toBe('Bearer tok');
    expect(numbers).toEqual([
      { id: '100000000000020', displayPhoneNumber: '+1 555-000-0100', verifiedName: 'Teste', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED' },
    ]);
  });
  it('erro da Meta vira MetaGraphError com o status', async () => {
    const fetchFn = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    await expect(listWabaPhoneNumbers({ graphVersion: 'v26.0', token: 't', wabaId: '100000000000010', fetchFn })).rejects.toMatchObject({
      status: 401,
    });
    await expect(listWabaPhoneNumbers({ graphVersion: 'v26.0', token: 't', wabaId: '../x', fetchFn })).rejects.toBeInstanceOf(MetaGraphError);
  });
});
