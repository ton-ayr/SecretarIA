import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';
import { adminApp, FakeBot } from './helpers/admin.ts';

let mem: LocalPlatform;
beforeAll(async () => {
  mem = await createMemoryDb({ seed: true });
  await mem.db
    .prepare("INSERT INTO meta_accounts (id, waba_id, access_token_enc, created_at) VALUES ('MA1', '100000000000010', 'cifrado', '2026-10-01T00:00:00.000Z')")
    .run();
});
afterAll(() => mem.dispose());

const B = SEED.barber.tenantId;
const D = SEED.dental.tenantId;

describe('painel: agenda', () => {
  it('salva as regras e recusa valores fora do limite', async () => {
    const { post, get } = adminApp(mem.db);
    const ok = await post(`/empresas/${D}/agenda`, { slotStepMin: '30', minAdvanceMin: '120', maxDaysAhead: '60', maxOptions: '5' });
    expect(ok.headers.get('location')).toBe(`/empresas/${D}/agenda?ok=saved`);
    expect(await mem.db.prepare('SELECT slot_step_min, max_options FROM scheduling_rules WHERE tenant_id = ?').bind(D).first()).toEqual({
      slot_step_min: 30,
      max_options: 5,
    });
    const bad = await post(`/empresas/${D}/agenda`, { slotStepMin: '1', minAdvanceMin: '0', maxDaysAhead: '60', maxOptions: '5' });
    expect(bad.status).toBe(422);
    expect(await (await get(`/empresas/${D}/agenda`)).text()).toContain('secretaria@projeto.iam.gserviceaccount.com');
  });

  it('só liga a agenda Google se o bot conseguir ler e escrever', async () => {
    const bot = new FakeBot();
    const { post } = adminApp(mem.db, { bot });
    bot.calendar = { read: true, write: false, busy: 0, problem: 'Li a agenda, mas não consegui criar evento.' };
    const refused = await post(`/empresas/${B}/agenda/google`, { calendarId: 'barbearia@gmail.com' });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toContain('não consegui criar evento');
    expect(await mem.db.prepare('SELECT google_calendar_id FROM tenants WHERE id = ?').bind(B).first()).toEqual({ google_calendar_id: null });

    bot.calendar = { read: true, write: true, busy: 2, problem: null };
    expect((await post(`/empresas/${B}/agenda/google`, { calendarId: 'barbearia@gmail.com' })).status).toBe(303);
    expect(await mem.db.prepare('SELECT google_calendar_id FROM tenants WHERE id = ?').bind(B).first()).toEqual({
      google_calendar_id: 'barbearia@gmail.com',
    });
    // Vazio desliga, sem testar.
    expect((await post(`/empresas/${B}/agenda/google`, { calendarId: '' })).status).toBe(303);
    expect(await mem.db.prepare('SELECT google_calendar_id FROM tenants WHERE id = ?').bind(B).first()).toEqual({ google_calendar_id: null });
  });

  it('botão Testar devolve só o pedaço do resultado (htmx)', async () => {
    const bot = new FakeBot();
    bot.calendar = { read: true, write: true, busy: 1, problem: null };
    const res = await adminApp(mem.db, { bot }).post(`/empresas/${B}/agenda/testar`, { calendarId: 'x@gmail.com' });
    const html = await res.text();
    expect(html).not.toContain('<html');
    expect(html).toContain('Leitura e escrita ok (1 bloqueio nos próximos 7 dias)');
  });
});

describe('painel: WhatsApp', () => {
  it('busca os números na conta Meta e liga um à empresa', async () => {
    const bot = new FakeBot();
    bot.metaNumbers = {
      numbers: [
        { id: '555000999', displayPhoneNumber: '+55 11 95555-0999', verifiedName: 'Sorriso', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED' },
      ],
    };
    const { get, post } = adminApp(mem.db, { bot });
    const page = await (await get(`/empresas/${D}/whatsapp?conta=MA1`)).text();
    expect(page).toContain('+55 11 95555-0999 — Sorriso (qualidade GREEN)');

    // Número que não está na conta: recusado.
    const fake = await post(`/empresas/${D}/whatsapp`, { metaAccountId: 'MA1', metaPhoneNumberId: '999999999' });
    expect(fake.status).toBe(422);

    const ok = await post(`/empresas/${D}/whatsapp`, { metaAccountId: 'MA1', metaPhoneNumberId: '555000999' });
    expect(ok.headers.get('location')).toBe(`/empresas/${D}/whatsapp?ok=phone-added`);
    expect(await mem.db.prepare("SELECT tenant_id, display_phone, kind, meta_account_id FROM phone_numbers WHERE meta_phone_number_id = '555000999'").first()).toEqual({
      tenant_id: D,
      display_phone: '+55 11 95555-0999',
      kind: 'whatsapp',
      meta_account_id: 'MA1',
    });

    // O mesmo número em outra empresa: 409.
    const dup = await adminApp(mem.db, { bot }).post(`/empresas/${B}/whatsapp`, { metaAccountId: 'MA1', metaPhoneNumberId: '555000999' });
    expect(dup.status).toBe(409);
    expect(await dup.text()).toContain('Esse número já está ligado a uma empresa.');
  });

  it('se a Meta falhar, dá para informar à mão; e dá para desligar o número', async () => {
    const bot = new FakeBot();
    bot.metaNumbers = { error: 'A Meta recusou a consulta (HTTP 401).' };
    const { get, post } = adminApp(mem.db, { bot });
    const page = await (await get(`/empresas/${D}/whatsapp?conta=MA1`)).text();
    expect(page).toContain('A Meta recusou a consulta (HTTP 401).');
    expect(page).toContain('name="manual"');
    const ok = await post(`/empresas/${D}/whatsapp`, { manual: '1', metaAccountId: 'MA1', metaPhoneNumberId: '555000777', displayPhone: '+55 11 95555-0777' });
    expect(ok.status).toBe(303);
    const phone = await mem.db.prepare("SELECT id FROM phone_numbers WHERE meta_phone_number_id = '555000777'").first<{ id: string }>();
    await post(`/empresas/${D}/whatsapp/${phone!.id}/status`, { status: 'disabled' });
    expect(await mem.db.prepare('SELECT status FROM phone_numbers WHERE id = ?').bind(phone!.id).first()).toEqual({ status: 'disabled' });
  });
});

describe('painel: equipe no Telegram', () => {
  it('gera link de uso único, mostra uma vez e permite remover', async () => {
    const { post, get } = adminApp(mem.db);
    const res = await post(`/empresas/${D}/equipe`, { label: 'Recepção' });
    expect(res.status).toBe(200);
    const html = await res.text();
    const code = /t\.me\/SecretariaTesteBot\?start=([A-Za-z0-9]{32})/.exec(html)?.[1];
    expect(code).toBeDefined();
    const row = await mem.db.prepare('SELECT id, label, active, link_expires_at FROM notification_channels WHERE link_code = ?').bind(code!).first<{ id: string }>();
    expect(row).toMatchObject({ label: 'Recepção', active: 0, link_expires_at: '2026-10-14T11:00:00.000Z' });
    // O link não reaparece na listagem.
    expect(await (await get(`/empresas/${D}/equipe`)).text()).not.toContain(code!);
    await post(`/empresas/${D}/equipe/${row!.id}/remover`, {});
    expect(await mem.db.prepare('SELECT COUNT(*) AS n FROM notification_channels WHERE link_code = ?').bind(code!).first()).toEqual({ n: 0 });
  });
});
