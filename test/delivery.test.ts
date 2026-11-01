import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1Repo, MAINTENANCE_SQL } from '../src/adapters/d1-repo.ts';
import type { DeliveryStatus } from '../src/ports/repo.ts';
import { encryptSecret, decryptSecret, generateKey } from '../src/shared/crypto.ts';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';

let mem: LocalPlatform;
let repo: D1Repo;
const T = SEED.barber;

beforeAll(async () => {
  mem = await createMemoryDb({ seed: true });
  repo = new D1Repo(mem.db);
});
afterAll(() => mem.dispose());

async function insertMessage(id: string, createdAt: string, opts: { tenant?: 'barber' | 'dental'; waId?: string; waMessageId?: string } = {}) {
  const t = SEED[opts.tenant ?? 'barber'];
  const waId = opts.waId ?? `wa-${id}`;
  const ctx = await repo.forTenant(t.tenantId).loadTurnContext({
    phoneNumberId: t.phoneNumberId,
    waId,
    profileName: null,
    now: createdAt,
    newContactId: `C-${id}`,
    newConversationId: `V-${id}`,
  });
  await mem.db
    .prepare(
      `INSERT INTO messages (id, tenant_id, conversation_id, direction, author, kind, body, wa_message_id, created_at)
       VALUES (?, ?, ?, 'out', 'bot', 'text', 'x', ?, ?)`,
    )
    .bind(id, t.tenantId, ctx!.conversation.id, opts.waMessageId ?? null, createdAt)
    .run();
  return ctx!;
}

const usage = () =>
  mem.db.prepare('SELECT * FROM usage_monthly WHERE phone_number_id = ? AND month = ?').bind(T.phoneNumberId, '2026-10').first<Record<string, number>>();

const status = (waMessageId: string, s: Partial<DeliveryStatus>): DeliveryStatus => ({
  waMessageId,
  status: 'delivered',
  at: '2026-10-03T12:00:05.000Z',
  errorCode: null,
  billable: false,
  category: null,
  ...s,
});

describe('envio e status de entrega', () => {
  it('liga a resposta ao wamid e conta a entrega uma vez só', async () => {
    await insertMessage('OUT1', '2026-10-03T12:00:00.000Z');
    const tenantRepo = repo.forTenant(T.tenantId);
    await tenantRepo.markSent('OUT1', 'wamid.OUT1');
    const before = (await usage())?.msgs_delivered ?? 0;

    await tenantRepo.recordDeliveryStatus(T.phoneNumberId, '2026-10', status('wamid.OUT1', {}));
    await tenantRepo.recordDeliveryStatus(T.phoneNumberId, '2026-10', status('wamid.OUT1', {})); // reentrega
    await tenantRepo.recordDeliveryStatus(T.phoneNumberId, '2026-10', status('wamid.OUT1', { status: 'read' }));

    expect((await usage())!.msgs_delivered).toBe(before + 1);
    const row = await mem.db.prepare('SELECT delivered_at FROM messages WHERE id = ?').bind('OUT1').first();
    expect(row).toEqual({ delivered_at: '2026-10-03T12:00:05.000Z' });
  });

  it('conta falha com o código da Meta', async () => {
    await insertMessage('OUT2', '2026-10-03T12:00:00.000Z', { waMessageId: 'wamid.OUT2' });
    const before = (await usage())?.msgs_failed ?? 0;
    await repo.forTenant(T.tenantId).recordDeliveryStatus(T.phoneNumberId, '2026-10', status('wamid.OUT2', { status: 'failed', errorCode: 131030 }));
    expect((await usage())!.msgs_failed).toBe(before + 1);
    const row = await mem.db.prepare('SELECT failed_code FROM messages WHERE id = ?').bind('OUT2').first();
    expect(row).toEqual({ failed_code: 131030 });
  });

  it('conta template cobrado por categoria, uma vez só', async () => {
    await insertMessage('OUT3', '2026-10-03T12:00:00.000Z', { waMessageId: 'wamid.OUT3' });
    const before = (await usage())?.templates_utility ?? 0;
    const st = status('wamid.OUT3', { status: 'sent', billable: true, category: 'utility' });
    await repo.forTenant(T.tenantId).recordDeliveryStatus(T.phoneNumberId, '2026-10', st);
    await repo.forTenant(T.tenantId).recordDeliveryStatus(T.phoneNumberId, '2026-10', { ...st, status: 'delivered' });
    expect((await usage())!.templates_utility).toBe(before + 1);
  });

  it('mensagem de serviço cobrada (desde 01/10/2026) conta à parte, uma vez só', async () => {
    await insertMessage('OUT6', '2026-10-03T12:00:00.000Z', { waMessageId: 'wamid.OUT6' });
    const u0 = await usage();
    const st = status('wamid.OUT6', { status: 'sent', billable: true, category: 'service' });
    await repo.forTenant(T.tenantId).recordDeliveryStatus(T.phoneNumberId, '2026-10', st);
    await repo.forTenant(T.tenantId).recordDeliveryStatus(T.phoneNumberId, '2026-10', { ...st, status: 'read' });
    const u1 = await usage();
    expect(u1!.service_billed).toBe((u0?.service_billed ?? 0) + 1);
    expect(u1!.templates_utility).toBe(u0?.templates_utility ?? 0);
  });

  it('mensagem de serviço (não cobrada) não conta como template', async () => {
    await insertMessage('OUT4', '2026-10-03T12:00:00.000Z', { waMessageId: 'wamid.OUT4' });
    const u0 = await usage();
    await repo
      .forTenant(T.tenantId)
      .recordDeliveryStatus(T.phoneNumberId, '2026-10', status('wamid.OUT4', { status: 'sent', billable: false, category: 'service' }));
    const u1 = await usage();
    expect(u1!.templates_utility).toBe(u0!.templates_utility);
    expect(u1!.service_billed).toBe(u0!.service_billed);
  });

  it('status de mensagem de outra empresa não altera nada', async () => {
    await insertMessage('OUT5', '2026-10-03T12:00:00.000Z', { tenant: 'dental', waMessageId: 'wamid.OUT5' });
    await repo.forTenant(T.tenantId).recordDeliveryStatus(T.phoneNumberId, '2026-10', status('wamid.OUT5', {}));
    const row = await mem.db.prepare('SELECT delivered_at FROM messages WHERE id = ?').bind('OUT5').first();
    expect(row).toEqual({ delivered_at: null });
  });
});

describe('token da Meta criptografado', () => {
  it('cifra, guarda e decifra com a chave', async () => {
    const key = generateKey();
    const sealed = await encryptSecret(key, 'EAAG-token-de-teste');
    expect(sealed).not.toContain('EAAG');
    await mem.db
      .prepare("INSERT INTO meta_accounts (id, waba_id, access_token_enc, created_at) VALUES ('MA1', 'waba-1', ?, '2026-10-03T00:00:00.000Z')")
      .bind(sealed)
      .run();
    const secret = await repo.ops.getMetaAccountSecret('MA1');
    expect(await decryptSecret(key, secret!.accessTokenEnc)).toBe('EAAG-token-de-teste');
  });

  it('cada cifragem usa um IV novo e chave errada não decifra', async () => {
    const key = generateKey();
    const a = await encryptSecret(key, 'x');
    const b = await encryptSecret(key, 'x');
    expect(a).not.toBe(b);
    await expect(decryptSecret(generateKey(), a)).rejects.toThrow();
  });

  it('recusa chave com tamanho errado', async () => {
    await expect(encryptSecret(btoa('curta'), 'x')).rejects.toThrow(/32 bytes/);
  });
});

describe('limpeza diária (LGPD)', () => {
  it('toda consulta de limpeza usa o prazo da própria empresa', () => {
    for (const [name, sql] of Object.entries(MAINTENANCE_SQL)) {
      if (name === 'deleteOldTurnLogs') continue; // prazo fixo de 30 dias, sem dado pessoal
      expect(sql, name).toMatch(/JOIN tenants t ON t\.id = (m|c|r|a)\.tenant_id/);
    }
  });

  it('apaga mensagens velhas pelo prazo de cada empresa e contatos inativos', async () => {
    // Barbearia guarda 7 dias; consultório passa a guardar 30.
    await mem.db.prepare('UPDATE tenants SET message_retention_days = 30 WHERE id = ?').bind(SEED.dental.tenantId).run();
    const now = '2026-10-20T06:00:00.000Z';
    await insertMessage('OLD-A', '2026-10-05T00:00:00.000Z', { waId: 'wa-ret-a' }); // 15 dias: apaga (7)
    await insertMessage('NEW-A', '2026-10-18T00:00:00.000Z', { waId: 'wa-ret-a2' }); // 2 dias: fica
    await insertMessage('OLD-B', '2026-10-05T00:00:00.000Z', { tenant: 'dental', waId: 'wa-ret-b' }); // 15 dias: fica (30)

    // Contato sem atividade há mais de 365 dias.
    await insertMessage('STALE', '2025-01-01T00:00:00.000Z', { waId: 'wa-stale' });
    await mem.db.prepare("UPDATE messages SET created_at = '2026-10-19T00:00:00.000Z' WHERE id = 'STALE'").run();

    const report = await repo.ops.runRetention(now);
    const ids = (await mem.db.prepare("SELECT id FROM messages WHERE id IN ('OLD-A','NEW-A','OLD-B','STALE')").all()).results.map(
      (r) => (r as { id: string }).id,
    );
    expect(ids.sort()).toEqual(['NEW-A', 'OLD-B']);
    expect(report.contacts).toBeGreaterThanOrEqual(1);
    const stale = await mem.db.prepare("SELECT COUNT(*) n FROM contacts WHERE wa_id = 'wa-stale'").first<{ n: number }>();
    expect(stale!.n).toBe(0);
  });
});

describe('limpeza das tabelas da passagem para humano', () => {
  it('apaga vínculos velhos do Telegram e tudo de contatos inativos', async () => {
    const now = '2026-10-20T06:00:00.000Z';
    // Conversa recente com um vínculo velho (15 dias) e um novo.
    const recent = await insertMessage('HO-1', '2026-10-19T00:00:00.000Z', { waId: 'wa-ho-recent' });
    const tenantRepo = repo.forTenant(SEED.barber.tenantId);
    await mem.db
      .prepare(
        `INSERT INTO telegram_relays (tenant_id, chat_ref, tg_message_id, conversation_id, created_at) VALUES
         (?1, 'chat-a', 1, ?2, '2026-10-05T00:00:00.000Z'), (?1, 'chat-a', 2, ?2, '2026-10-19T00:00:00.000Z')`,
      )
      .bind(SEED.barber.tenantId, recent.conversation.id)
      .run();

    // Contato inativo há mais de 1 ano, com passagem para humano e vínculo.
    const stale = await insertMessage('HO-2', '2025-01-01T00:00:00.000Z', { waId: 'wa-ho-stale' });
    await mem.db
      .prepare(
        `INSERT INTO handoffs (id, tenant_id, conversation_id, reason, created_at) VALUES ('H-STALE', ?1, ?2, 'customer_request', '2025-01-01T00:00:00.000Z')`,
      )
      .bind(SEED.barber.tenantId, stale.conversation.id)
      .run();
    await tenantRepo.addTelegramRelays([{ chatRef: 'chat-b', tgMessageId: 9, conversationId: stale.conversation.id }], '2026-10-19T00:00:00.000Z');

    await repo.ops.runRetention(now);

    const relays = await mem.db.prepare("SELECT tg_message_id FROM telegram_relays WHERE chat_ref IN ('chat-a', 'chat-b')").all();
    expect(relays.results).toEqual([{ tg_message_id: 2 }]);
    expect(await mem.db.prepare("SELECT COUNT(*) n FROM handoffs WHERE id = 'H-STALE'").first()).toEqual({ n: 0 });
    expect(await mem.db.prepare("SELECT COUNT(*) n FROM contacts WHERE wa_id = 'wa-ho-stale'").first()).toEqual({ n: 0 });
  });
});

describe('busca do número da Meta', () => {
  it('não guarda "não encontrado" em cache: número recém-cadastrado já responde', async () => {
    const { resolveRoute } = await import('../src/bot/services.ts');
    expect(await resolveRoute(repo, '555000111')).toBeNull();
    await mem.db
      .prepare(
        "INSERT INTO phone_numbers (id, tenant_id, meta_phone_number_id, display_phone, created_at) VALUES ('PN-NEW', ?, '555000111', '+55 11 0000-0000', '2026-10-03T00:00:00.000Z')",
      )
      .bind(SEED.barber.tenantId)
      .run();
    expect(await resolveRoute(repo, '555000111')).toMatchObject({ tenantId: SEED.barber.tenantId, phoneNumberId: 'PN-NEW' });
  });
});
