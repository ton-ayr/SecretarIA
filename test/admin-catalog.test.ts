import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1Repo } from '../src/adapters/d1-repo.ts';
import { ScriptedLLM } from '../src/adapters/fake-llm.ts';
import { ConversationEngine } from '../src/core/engine.ts';
import { DEFAULT_PRICING } from '../src/core/pricing.ts';
import { runTestTurn, silentTeamNotifier } from '../src/core/test-chat.ts';
import { MemoryLogger } from '../src/shared/logger.ts';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';
import { adminApp } from './helpers/admin.ts';

let mem: LocalPlatform;
beforeAll(async () => {
  mem = await createMemoryDb({ seed: true });
});
afterAll(() => mem.dispose());

const B = SEED.barber.tenantId;
const D = SEED.dental.tenantId;

describe('painel: serviços e profissionais', () => {
  it('cria e edita serviço com preço e quem faz', async () => {
    const { post, get } = adminApp(mem.db);
    const res = await post(`/empresas/${B}/servicos`, {
      name: 'Sobrancelha',
      description: 'Na navalha.',
      durationMin: '15',
      bufferMin: '5',
      priceMode: 'fixed',
      price: '25,50',
      active: '1',
      professionalIds: ['01K6SEED00000000000000RA01'],
    });
    expect(res.headers.get('location')).toBe(`/empresas/${B}/servicos?ok=saved`);
    const list = await (await get(`/empresas/${B}/servicos`)).text();
    expect(list).toContain('Sobrancelha');
    expect(list).toContain('R$ 25,50');
    const row = await mem.db.prepare("SELECT id, price_cents, buffer_min FROM services WHERE name = 'Sobrancelha'").first<{ id: string }>();
    expect(row).toMatchObject({ price_cents: 2550, buffer_min: 5 });

    const edit = await (await get(`/empresas/${B}/servicos/${row!.id}`)).text();
    expect(edit).toContain('value="25,50"');
    const saved = await post(`/empresas/${B}/servicos/${row!.id}`, {
      name: 'Sobrancelha',
      durationMin: '20',
      bufferMin: '0',
      priceMode: 'on_request',
      price: '',
    });
    expect(saved.status).toBe(303);
    expect(await mem.db.prepare('SELECT price_mode, price_cents, active FROM services WHERE id = ?').bind(row!.id).first()).toEqual({
      price_mode: 'on_request',
      price_cents: null,
      active: 0,
    });
  });

  it('serviço de outra empresa: 404 e nada muda', async () => {
    const { post, get } = adminApp(mem.db);
    expect((await get(`/empresas/${D}/servicos/01K6SEED00000000000000SA01`)).status).toBe(404);
    const res = await post(`/empresas/${D}/servicos/01K6SEED00000000000000SA01`, {
      name: 'invasão',
      durationMin: '30',
      bufferMin: '0',
      priceMode: 'fixed',
      price: '1',
    });
    expect(res.status).toBe(404);
    expect(await mem.db.prepare("SELECT name FROM services WHERE id = '01K6SEED00000000000000SA01'").first()).toEqual({ name: 'Corte masculino' });
  });

  it('preço inválido: 422 com a mensagem', async () => {
    const res = await adminApp(mem.db).post(`/empresas/${B}/servicos`, { name: 'X', durationMin: '30', bufferMin: '0', priceMode: 'fixed', price: 'caro' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Informe o preço (ex.: 45,00).');
  });

  it('profissional com agenda Google própria', async () => {
    const { post, get } = adminApp(mem.db);
    await post(`/empresas/${B}/profissionais`, { name: 'Lia', title: 'Barbeira', active: '1' });
    const lia = await mem.db.prepare("SELECT id FROM professionals WHERE name = 'Lia'").first<{ id: string }>();
    const bad = await post(`/empresas/${B}/profissionais/${lia!.id}`, { name: 'Lia', title: 'Barbeira', active: '1', calendarId: 'não é email' });
    expect(bad.status).toBe(422);
    const ok = await post(`/empresas/${B}/profissionais/${lia!.id}`, { name: 'Lia', title: 'Barbeira', active: '1', calendarId: 'lia@gmail.com' });
    expect(ok.status).toBe(303);
    expect(await mem.db.prepare('SELECT google_calendar_id FROM professionals WHERE id = ?').bind(lia!.id).first()).toEqual({
      google_calendar_id: 'lia@gmail.com',
    });
    expect(await (await get(`/empresas/${B}/profissionais`)).text()).toContain('Barbeira Lia');
  });
});

describe('painel: horários e folgas', () => {
  it('horário da empresa e de um profissional', async () => {
    const { post, get } = adminApp(mem.db);
    const res = await post(`/empresas/${D}/horarios`, { professionalId: '', d1: '08:00-12:00, 13:00-18:00', d2: '8h às 18h' });
    expect(res.headers.get('location')).toBe(`/empresas/${D}/horarios?ok=saved`);
    const page = await (await get(`/empresas/${D}/horarios`)).text();
    expect(page).toContain('value="08:00-12:00, 13:00-18:00"');
    expect(page).toContain('value="08:00-18:00"');

    const prof = await mem.db.prepare('SELECT id FROM professionals WHERE tenant_id = ? LIMIT 1').bind(D).first<{ id: string }>();
    await post(`/empresas/${D}/horarios`, { professionalId: prof!.id, d3: '14:00-20:00' });
    expect(await mem.db.prepare('SELECT weekday, opens_min, closes_min FROM business_hours WHERE professional_id = ?').bind(prof!.id).all()).toMatchObject({
      results: [{ weekday: 3, opens_min: 840, closes_min: 1200 }],
    });
    // Profissional de outra empresa: 404.
    expect((await post(`/empresas/${B}/horarios`, { professionalId: prof!.id, d1: '09:00-10:00' })).status).toBe(404);
  });

  it('horário inválido: 422 e o que foi digitado volta', async () => {
    const res = await adminApp(mem.db).post(`/empresas/${D}/horarios`, { professionalId: '', d1: '18:00-08:00' });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('Use o formato 09:00-12:00, 13:00-18:00.');
    expect(html).toContain('value="18:00-08:00"');
  });

  it('folga do dia inteiro no fuso da empresa e remoção', async () => {
    const { post, get } = adminApp(mem.db);
    await post(`/empresas/${B}/folgas`, { professionalId: '', startDate: '2026-11-02', reason: 'Finados' });
    const page = await (await get(`/empresas/${B}/folgas`)).text();
    expect(page).toContain('02/11/2026 00:00');
    expect(page).toContain('03/11/2026 00:00');
    expect(page).toContain('Finados');
    const t = await mem.db.prepare("SELECT id FROM time_off WHERE reason = 'Finados'").first<{ id: string }>();
    const res = await post(`/empresas/${B}/folgas/${t!.id}/apagar`, {});
    expect(res.headers.get('location')).toBe(`/empresas/${B}/folgas?ok=removed`);
    expect(await mem.db.prepare("SELECT COUNT(*) AS n FROM time_off WHERE reason = 'Finados'").first()).toEqual({ n: 0 });
  });
});

describe('critério de aceite: empresa nova só pelo painel, conversando no chat de teste', () => {
  it('cadastra tudo pelo painel e o bot oferece os horários certos', async () => {
    const { post } = adminApp(mem.db);
    const created = await post('/empresas', { name: 'Cartas da Luna', segment: 'general', timezone: 'America/Sao_Paulo', address: 'Online', agentName: 'Luna' });
    const tenantId = /\/empresas\/([0-9A-Z]{26})/.exec(created.headers.get('location')!)![1]!;
    await post(`/empresas/${tenantId}/profissionais`, { name: 'Luna', title: 'Taróloga', active: '1' });
    await post(`/empresas/${tenantId}/servicos`, { name: 'Leitura de tarot', durationMin: '60', bufferMin: '0', priceMode: 'fixed', price: '120', active: '1' });
    // Terça das 14h às 18h.
    await post(`/empresas/${tenantId}/horarios`, { professionalId: '', d2: '14:00-18:00' });

    const repo = new D1Repo(mem.db);
    let t = Date.parse('2026-10-13T11:00:00.000Z'); // terça, 08:00 em São Paulo
    const clock = { now: () => new Date((t += 1000)) };
    const llm = new ScriptedLLM([
      { content: '', toolCalls: [{ id: 'c1', name: 'check_availability', arguments: JSON.stringify({ servico: 'tarot', data: 'hoje' }) }] },
    ]);
    const engine = new ConversationEngine({
      repo,
      llm,
      clock,
      logger: new MemoryLogger(),
      notifier: silentTeamNotifier,
      scheduling: { publicBaseUrl: 'https://bot.test' },
      config: { pricing: DEFAULT_PRICING, quotaLimits: {}, logHashKey: 'k' },
    });
    const r = await runTestTurn(tenantId, { text: 'tem horário de tarot hoje?' }, { repo, engine, clock });
    expect(r.reply!.text).toContain('Horários livres para *Leitura de tarot* (R$ 120,00) hoje');
    // Intervalo padrão de 15 min: 6 opções espalhadas entre 14:00 e 17:00 (a sessão de 60 min termina às 18:00).
    expect(r.reply!.options!.map((o) => o.title.slice(-5))).toEqual(['14:00', '14:30', '15:15', '15:45', '16:30', '17:00']);
    expect(llm.requests[0]!.messages[0]!.content).toContain('Luna');
  });
});
