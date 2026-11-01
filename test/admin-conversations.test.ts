import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';
import { adminApp, FakeBot, ORIGIN } from './helpers/admin.ts';

let mem: LocalPlatform;
const B = SEED.barber.tenantId;
const D = SEED.dental.tenantId;

beforeAll(async () => {
  mem = await createMemoryDb({ seed: true });
  const db = mem.db;
  const at = '2026-10-12T15:00:00.000Z';
  await db.batch([
    db.prepare("INSERT INTO contacts (id, tenant_id, wa_id, profile_name, last_seen_at, created_at) VALUES ('CT1', ?1, '5519911112222', 'Ana', ?2, ?2)").bind(B, at),
    db
      .prepare("INSERT INTO conversations (id, tenant_id, phone_number_id, contact_id, status, paused_until, last_customer_msg_at, updated_at) VALUES ('01K6CONV000000000000000001', ?1, ?2, 'CT1', 'human', '2026-10-13T20:00:00.000Z', ?3, ?3)")
      .bind(B, SEED.barber.phoneNumberId, at),
    db
      .prepare("INSERT INTO messages (id, tenant_id, conversation_id, direction, author, kind, body, created_at) VALUES ('M1', ?1, '01K6CONV000000000000000001', 'in', 'customer', 'text', '<img src=x onerror=alert(1)> oi', ?2)")
      .bind(B, at),
    db
      .prepare("INSERT INTO messages (id, tenant_id, conversation_id, direction, author, kind, body, created_at) VALUES ('M2', ?1, '01K6CONV000000000000000001', 'out', 'human', 'text', 'Olá, Ana!', ?2)")
      .bind(B, '2026-10-12T15:01:00.000Z'),
    db
      .prepare("INSERT INTO usage_monthly (tenant_id, phone_number_id, month, msgs_in, replies_out, service_billed, templates_utility) VALUES (?1, ?2, '2026-10', 40, 38, 30, 2)")
      .bind(B, SEED.barber.phoneNumberId),
  ]);
});
afterAll(() => mem.dispose());

describe('painel: conversas', () => {
  it('lista as conversas da semana, só da própria empresa', async () => {
    const { get } = adminApp(mem.db);
    const list = await (await get(`/empresas/${B}/conversas`)).text();
    expect(list).toContain('Ana');
    expect(list).toContain('+55 19 91111-2222');
    expect(list).toContain('com a equipe até 13/10 17:00');
    expect(await (await get(`/empresas/${D}/conversas`)).text()).not.toContain('Ana');
  });

  it('mostra as mensagens escapadas (texto do cliente nunca vira HTML)', async () => {
    const html = await (await adminApp(mem.db).get(`/empresas/${B}/conversas/01K6CONV000000000000000001`)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; oi');
    expect(html).toContain('Equipe · 12/10 12:01');
    expect(html).toContain('Reativar o bot');
  });

  it('reativar chama o bot; conversa de outra empresa dá 404', async () => {
    const bot = new FakeBot();
    const { post } = adminApp(mem.db, { bot });
    expect((await post(`/empresas/${D}/conversas/01K6CONV000000000000000001/reativar`, {})).status).toBe(404);
    expect(bot.calls).toEqual([]);
    const res = await post(`/empresas/${B}/conversas/01K6CONV000000000000000001/reativar`, {});
    expect(res.headers.get('location')).toBe(`/empresas/${B}/conversas/01K6CONV000000000000000001?ok=resumed`);
    expect(bot.calls).toEqual([['resumeConversation', B, '01K6CONV000000000000000001']]);
  });

  it('apagar contato exige confirmação e usa o telefone do banco', async () => {
    const bot = new FakeBot();
    const { post } = adminApp(mem.db, { bot });
    await post(`/empresas/${B}/conversas/01K6CONV000000000000000001/apagar`, { waId: '5500000000000' });
    expect(bot.calls).toEqual([]);
    const res = await post(`/empresas/${B}/conversas/01K6CONV000000000000000001/apagar`, { confirm: '1', waId: '5500000000000' });
    expect(res.headers.get('location')).toBe(`/empresas/${B}/conversas?ok=erased`);
    expect(bot.calls).toEqual([['eraseContact', B, '5519911112222']]);
  });

  it('medidor mostra as cobradas pela Meta e a estimativa em reais', async () => {
    const html = await (await adminApp(mem.db).get(`/empresas/${B}/medidor`)).text();
    expect(html).toContain('10/2026');
    expect(html).toContain('R$ 1,12'); // 32 × R$ 0,035
  });
});

describe('exibição das mensagens', () => {
  it('esconde a referência interna do toque e formata *negrito* sem HTML cru', async () => {
    const { displayBody, WaText } = await import('../src/admin/views/test-chat.tsx');
    expect(displayBody('customer', 'qua 14/10 · 10:00 (slot|S|P|2026-10-14T13:00:00.000Z)')).toBe('qua 14/10 · 10:00');
    expect(displayBody('customer', '📅 Salvar na agenda (cal|ABC123)')).toBe('📅 Salvar na agenda');
    expect(displayBody('customer', 'meu horário (das 10h)')).toBe('meu horário (das 10h)');
    expect(displayBody('bot', 'x (slot|a|b|c)')).toBe('x (slot|a|b|c)');
    const html = String(await WaText({ text: '*<b>oi</b>* e *Corte*' }));
    expect(html).toBe('<strong>&lt;b&gt;oi&lt;/b&gt;</strong> e <strong>Corte</strong>');
  });
});

describe('painel: chat de teste', () => {
  it('htmx: devolve a fala do cliente, a do bot, as opções e um formulário limpo', async () => {
    const bot = new FakeBot();
    bot.testReplies = [
      {
        outcome: 'replied',
        reply: {
          text: 'Horários livres para *Corte masculino* amanhã.',
          options: [{ id: 'slot|S|P|2026-10-14T13:00:00.000Z', title: 'qua 14/10 · 10:00', description: 'com Barbeiro Zé' }],
          listButton: 'Ver horários',
        },
        action: null,
        handoff: false,
        errorCode: null,
      },
    ];
    const { app } = adminApp(mem.db, { bot });
    const res = await app.request(`${ORIGIN}/empresas/${B}/testar`, {
      method: 'POST',
      body: new URLSearchParams({ text: 'tem corte amanhã?' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'hx-request': 'true' },
    });
    const html = await res.text();
    expect(html).not.toContain('<html');
    expect(html).toContain('<div class="bubble me">tem corte amanhã?</div>');
    // *negrito* do WhatsApp vira <strong>, sem HTML cru.
    expect(html).toContain('Horários livres para <strong>Corte masculino</strong> amanhã.');
    expect(html).toContain('name="replyId" value="slot|S|P|2026-10-14T13:00:00.000Z"');
    expect(html).toContain('hx-swap-oob="true"');
    expect(bot.calls[0]).toEqual(['testTurn', B, { text: 'tem corte amanhã?' }]);
  });

  it('toque numa opção manda o id e o título; marcação gera aviso do teste', async () => {
    const bot = new FakeBot();
    bot.testReplies = [{ outcome: 'replied', reply: { text: '✅ Agendado!' }, action: 'booked', handoff: false, errorCode: null }];
    const { app } = adminApp(mem.db, { bot });
    const res = await app.request(`${ORIGIN}/empresas/${B}/testar`, {
      method: 'POST',
      body: new URLSearchParams({ replyId: 'slot|S|P|X', title: 'qua 14/10 · 10:00' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'hx-request': 'true' },
    });
    const html = await res.text();
    expect(bot.calls[0]).toEqual(['testTurn', B, { replyId: 'slot|S|P|X', title: 'qua 14/10 · 10:00' }]);
    expect(html).toContain('Horário marcado de verdade na agenda');
  });

  it('sem JavaScript, volta para a página; erro do bot vira aviso', async () => {
    const bot = new FakeBot();
    const { post, app } = adminApp(mem.db, { bot });
    const plain = await post(`/empresas/${B}/testar`, { text: 'oi' });
    expect(plain.status).toBe(303);
    bot.testTurn = async () => {
      throw new Error('bot fora');
    };
    const res = await app.request(`${ORIGIN}/empresas/${B}/testar`, {
      method: 'POST',
      body: new URLSearchParams({ text: 'oi' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'hx-request': 'true' },
    });
    expect(await res.text()).toContain('Não consegui falar com o bot agora.');
  });

  it('página mostra o histórico do teste e "Limpar teste" chama o bot', async () => {
    const db = mem.db;
    await db.batch([
      db.prepare("INSERT INTO phone_numbers (id, tenant_id, meta_phone_number_id, display_phone, kind, created_at) VALUES ('PH-SIM-B', ?1, ?2, 'Simulador', 'test', '2026-10-12T00:00:00.000Z')").bind(B, `sim-${B}`),
      db.prepare("INSERT INTO contacts (id, tenant_id, wa_id, profile_name, last_seen_at, created_at) VALUES ('CT-T', ?1, 'teste', 'Cliente Teste', '2026-10-12T00:00:00.000Z', '2026-10-12T00:00:00.000Z')").bind(B),
      db.prepare("INSERT INTO conversations (id, tenant_id, phone_number_id, contact_id, updated_at) VALUES ('01K6CONV0000000000000TESTE', ?1, 'PH-SIM-B', 'CT-T', '2026-10-12T00:00:00.000Z')").bind(B),
      db.prepare("INSERT INTO messages (id, tenant_id, conversation_id, direction, author, kind, body, created_at) VALUES ('MT1', ?1, '01K6CONV0000000000000TESTE', 'in', 'customer', 'text', 'olá bot', '2026-10-12T00:00:01.000Z')").bind(B),
    ]);
    const bot = new FakeBot();
    const { get, post } = adminApp(mem.db, { bot });
    const page = await (await get(`/empresas/${B}/testar`)).text();
    expect(page).toContain('olá bot');
    const res = await post(`/empresas/${B}/testar/limpar`, {});
    expect(res.headers.get('location')).toBe(`/empresas/${B}/testar?ok=test-cleared`);
    expect(bot.calls).toEqual([['resetTest', B]]);
  });
});
