import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_SQL, D1Repo, MAINTENANCE_SQL, MONITOR_SQL, OPS_SQL, TENANT_SQL } from '../src/adapters/d1-repo.ts';
import { SCHEDULING_OPS_SQL, SCHEDULING_SQL } from '../src/adapters/d1-scheduling.ts';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';

const BUSINESS_TABLES = [
  'phone_numbers',
  'agents',
  'professionals',
  'services',
  'professional_services',
  'business_hours',
  'contacts',
  'conversations',
  'messages',
  'usage_monthly',
  'turn_logs',
];

function tableRefs(sql: string): string[] {
  const refs: string[] = [];
  // "DO UPDATE SET" (upsert) não é referência a tabela.
  const re = /\b(?:FROM|JOIN|INTO|(?<!DO\s)UPDATE)\s+([a-z_]+)/gi;
  for (const m of sql.matchAll(re)) refs.push(m[1]!.toLowerCase());
  return refs;
}

describe('guarda de SQL multiempresa', () => {
  it.each(Object.entries(TENANT_SQL))('%s filtra por tenant_id', (_name, sql) => {
    const business = tableRefs(sql).filter((t) => BUSINESS_TABLES.includes(t));
    const tenantFilters = (sql.match(/tenant_id\s*=\s*\?1|tenant_id,|\?1,/g) ?? []).length;
    if (tableRefs(sql).includes('tenants')) {
      expect(sql).toMatch(/WHERE id = \?1/);
    }
    // Cada referência a tabela de negócio precisa de um filtro (ou valor) de tenant.
    expect(tenantFilters).toBeGreaterThanOrEqual(business.length);
  });

  it.each(Object.entries(SCHEDULING_SQL))('agenda: %s filtra por tenant_id', (_name, sql) => {
    const tables = [...BUSINESS_TABLES, 'appointments', 'time_off', 'scheduling_rules'];
    const refs = tableRefs(sql);
    if (refs.includes('tenants')) expect(sql).toMatch(/WHERE id = \?1|t\.id = \?1/);
    const business = refs.filter((t) => tables.includes(t));
    const filters = (sql.match(/tenant_id\s*=\s*\?1|\?1\s*[,)]/g) ?? []).length;
    expect(filters).toBeGreaterThanOrEqual(business.length);
  });

  it('agenda: só o cron, a sincronização e o link do cliente cruzam empresas', () => {
    expect(Object.keys(SCHEDULING_OPS_SQL).sort()).toEqual([
      'byCalendarToken',
      'claimReminder',
      'dueReminders',
      'pendingSync',
      'releaseReminder',
    ]);
  });

  it('limpeza diária usa o prazo da própria empresa de cada linha', () => {
    for (const sql of Object.values(MAINTENANCE_SQL)) expect(sql).toMatch(/\?1/);
  });

  it('monitoramento do operador só lê', () => {
    for (const sql of Object.values(MONITOR_SQL)) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('SQL sem empresa só no bootstrap e nas tabelas do operador', () => {
    // Pontos de entrada sem empresa (número da Meta, link e mensagens do Telegram).
    expect(Object.keys(BOOTSTRAP_SQL).sort()).toEqual(['chatLinked', 'findLinkCode', 'findRelay', 'lookupPhone']);
    for (const sql of Object.values(OPS_SQL)) {
      // erasure_requests: só a lista de pedidos (a exclusão é por empresa).
      expect(tableRefs(sql).every((t) => ['llm_daily_usage', 'meta_accounts', 'ops_settings', 'erasure_requests'].includes(t))).toBe(true);
    }
  });
});

describe('repositório D1', () => {
  let mem: LocalPlatform;
  let repo: D1Repo;
  const NOW = '2026-10-02T12:00:00.000Z';

  beforeAll(async () => {
    mem = await createMemoryDb({ seed: true });
    repo = new D1Repo(mem.db);
  });
  afterAll(() => mem.dispose());

  const load = (tenant: 'barber' | 'dental', waId: string, phoneOf: 'barber' | 'dental' = tenant) =>
    repo.forTenant(SEED[tenant].tenantId).loadTurnContext({
      phoneNumberId: SEED[phoneOf].phoneNumberId,
      waId,
      profileName: 'Cliente',
      now: NOW,
      newContactId: `C-${tenant}-${waId}`,
      newConversationId: `V-${tenant}-${waId}`,
    });

  it('acha a empresa pelo número da Meta', async () => {
    expect(await repo.lookupPhoneNumber(SEED.barber.metaPhoneNumberId)).toEqual({
      tenantId: SEED.barber.tenantId,
      phoneNumberId: SEED.barber.phoneNumberId,
      metaAccountId: null,
    });
    expect(await repo.lookupPhoneNumber('999')).toBeNull();
  });

  it('carrega só os dados da própria empresa', async () => {
    const a = await load('barber', '5511999990001');
    const b = await load('dental', '5511999990001');
    expect(a!.services.map((s) => s.name)).toEqual(['Barba', 'Corte + barba', 'Corte masculino', 'Pigmentação']);
    expect(b!.services.map((s) => s.name)).toEqual(['Avaliação', 'Clareamento', 'Limpeza', 'Restauração']);
    expect(a!.tenant.segment).toBe('general');
    expect(b!.tenant.segment).toBe('health');
    expect(b!.agent.bookingTerm).toBe('consulta');
    // Mesmo telefone em duas empresas = dois contatos diferentes.
    expect(a!.contact.id).not.toBe(b!.contact.id);
  });

  it('empresa B não consegue usar o número da empresa A', async () => {
    expect(await load('dental', '5511999990002', 'barber')).toBeNull();
    // Nem a conversa cruzada fica gravada.
    const cross = await mem.db
      .prepare('SELECT COUNT(*) AS n FROM conversations WHERE tenant_id = ? AND phone_number_id = ?')
      .bind(SEED.dental.tenantId, SEED.barber.phoneNumberId)
      .first();
    expect(cross).toEqual({ n: 0 });
  });

  it('número sem atendente próprio usa o atendente da empresa', async () => {
    await mem.db
      .prepare(
        "INSERT INTO phone_numbers (id, tenant_id, meta_phone_number_id, display_phone, kind, created_at) VALUES ('PH-SIM-B', ?, 'sim-b', 'Simulador', 'test', '2026-10-04T00:00:00.000Z')",
      )
      .bind(SEED.dental.tenantId)
      .run();
    const r = await repo.forTenant(SEED.dental.tenantId).loadTurnContext({
      phoneNumberId: 'PH-SIM-B',
      waId: 'teste',
      profileName: null,
      now: '2026-10-04T00:00:00.000Z',
      newContactId: 'CT-SIM-B',
      newConversationId: 'CV-SIM-B',
    });
    expect(r!.agent.bookingTerm).toBe('consulta');
    expect(r!.phoneNumberId).toBe('PH-SIM-B');
  });

  it('serviço "sob consulta" chega sem preço', async () => {
    const b = await load('dental', '5511999990003');
    const clareamento = b!.services.find((s) => s.name === 'Clareamento')!;
    expect(clareamento.priceMode).toBe('on_request');
    expect(clareamento.priceCents).toBeNull();
  });

  it('grava o turno e devolve o histórico em ordem', async () => {
    const ctx = await load('barber', '5511999990004');
    const tenantRepo = repo.forTenant(SEED.barber.tenantId);
    await tenantRepo.saveTurn({
      conversationId: ctx!.conversation.id,
      phoneNumberId: SEED.barber.phoneNumberId,
      month: '2026-10',
      messages: [
        { id: 'M1', direction: 'in', author: 'customer', kind: 'text', body: 'oi', waMessageId: 'wamid.1', createdAt: '2026-10-02T12:00:01.000Z' },
        { id: 'M2', direction: 'out', author: 'bot', kind: 'text', body: 'olá', waMessageId: null, createdAt: '2026-10-02T12:00:02.000Z' },
      ],
      lastCustomerMsgAt: '2026-10-02T12:00:01.000Z',
      now: NOW,
      usage: { msgsIn: 1, repliesOut: 1, llmRequests: 1, tokensIn: 100, tokensOut: 10, estCostUsdMicros: 21 },
      turnLog: {
        id: 'T1', startedAt: NOW, durationMs: 5, steps: [], provider: 'fake', model: 'm',
        toolCalls: 0, tokensIn: 100, tokensOut: 10, outcome: 'replied', errorCode: null,
      },
    });
    const again = await load('barber', '5511999990004');
    expect(again!.history.map((m) => m.body)).toEqual(['oi', 'olá']);
    expect(again!.unsummarizedCount).toBe(2);
    expect(again!.conversation.lastCustomerMsgAt).toBe('2026-10-02T12:00:01.000Z');

    const usage = await mem.db.prepare('SELECT * FROM usage_monthly WHERE phone_number_id = ?').bind(SEED.barber.phoneNumberId).first();
    expect(usage).toMatchObject({ msgs_in: 1, replies_out: 1, tokens_in: 100, est_cost_usd_micros: 21 });
  });

  it('a mesma mensagem da Meta não é gravada duas vezes', async () => {
    const ctx = await load('barber', '5511999990005');
    const tenantRepo = repo.forTenant(SEED.barber.tenantId);
    const record = (turnId: string, msgId: string) => ({
      conversationId: ctx!.conversation.id,
      phoneNumberId: SEED.barber.phoneNumberId,
      month: '2026-10',
      messages: [{ id: msgId, direction: 'in' as const, author: 'customer' as const, kind: 'text', body: 'oi', waMessageId: 'wamid.dup', createdAt: NOW }],
      lastCustomerMsgAt: NOW,
      now: NOW,
      usage: { msgsIn: 1, repliesOut: 0, llmRequests: 0, tokensIn: 0, tokensOut: 0, estCostUsdMicros: 0 },
      turnLog: { id: turnId, startedAt: NOW, durationMs: 1, steps: [], provider: null, model: null, toolCalls: 0, tokensIn: 0, tokensOut: 0, outcome: 'paused', errorCode: null },
    });
    await tenantRepo.saveTurn(record('T2', 'M3'));
    await tenantRepo.saveTurn(record('T3', 'M4'));
    const again = await load('barber', '5511999990005');
    expect(again!.history).toHaveLength(1);
  });

  it('soma o uso diário da IA e marca o alerta uma vez só', async () => {
    const day = '2026-10-02';
    await repo.ops.addLlmUsage(day, [{ provider: 'groq', model: 'm', requests: 1, tokens: 100 }]);
    const totals = await repo.ops.addLlmUsage(day, [{ provider: 'groq', model: 'm', requests: 2, tokens: 50 }]);
    expect(totals).toEqual([{ provider: 'groq', model: 'm', requests: 3, tokens: 150, alertSentAt: null }]);
    expect(await repo.ops.markQuotaAlert('groq', 'm', day, NOW)).toBe(true);
    expect(await repo.ops.markQuotaAlert('groq', 'm', day, NOW)).toBe(false);
  });
});
