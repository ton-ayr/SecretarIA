import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_OPS_SQL, ADMIN_SQL, D1AdminRepo } from '../src/adapters/d1-admin.ts';
import { testPhoneMetaId } from '../src/ports/admin.ts';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';

const BUSINESS_TABLES = [
  'phone_numbers',
  'agents',
  'professionals',
  'services',
  'professional_services',
  'business_hours',
  'time_off',
  'scheduling_rules',
  'contacts',
  'conversations',
  'messages',
  'usage_monthly',
  'notification_channels',
  'appointments',
];

function tableRefs(sql: string): string[] {
  const re = /\b(?:FROM|JOIN|INTO|(?<!DO\s)UPDATE)\s+([a-z_]+)/gi;
  return [...sql.matchAll(re)].map((m) => m[1]!.toLowerCase());
}

describe('guarda de SQL multiempresa do painel', () => {
  it.each(Object.entries(ADMIN_SQL))('%s filtra por tenant_id', (_name, sql) => {
    const refs = tableRefs(sql);
    if (refs.includes('tenants')) expect(sql).toMatch(/WHERE id = \?1|INSERT INTO tenants \(id,[^)]*\) VALUES \(\?1,/);
    const business = refs.filter((t) => BUSINESS_TABLES.includes(t));
    const filters = (sql.match(/tenant_id\s*=\s*\?1|\?1\s*[,)]/g) ?? []).length;
    expect(filters).toBeGreaterThanOrEqual(business.length);
  });

  it('só a visão do operador cruza empresas, e só para listar e somar', () => {
    expect(Object.keys(ADMIN_OPS_SQL).sort()).toEqual(['listMetaAccounts', 'listTenants', 'listUsage', 'llmUsage']);
    for (const sql of Object.values(ADMIN_OPS_SQL)) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
});

describe('repositório do painel', () => {
  let mem: LocalPlatform;
  let admin: D1AdminRepo;
  const NOW = '2026-10-04T12:00:00.000Z';
  const barber = () => admin.forTenant(SEED.barber.tenantId);
  const dental = () => admin.forTenant(SEED.dental.tenantId);

  beforeAll(async () => {
    mem = await createMemoryDb({ seed: true });
    admin = new D1AdminRepo(mem.db);
  });
  afterAll(() => mem.dispose());

  it('cria empresa com simulador, atendente e regras padrão', async () => {
    const id = await admin.ops.createTenant(
      { name: 'Cartas da Luna', segment: 'general', timezone: 'America/Sao_Paulo', address: null, agentName: 'Luna' },
      NOW,
    );
    const t = admin.forTenant(id);
    expect(await t.getTenant()).toMatchObject({ name: 'Cartas da Luna', status: 'active', remindersEnabled: false });
    expect(await t.getAgent()).toMatchObject({ name: 'Luna', bookingTerm: 'horário', professionalTerm: 'profissional' });
    expect(await t.getRules()).toEqual({ slotStepMin: 15, minAdvanceMin: 60, maxDaysAhead: 30, maxOptions: 6 });
    expect(await t.listPhones()).toEqual([
      expect.objectContaining({ kind: 'test', metaPhoneNumberId: testPhoneMetaId(id), displayPhone: 'Simulador' }),
    ]);
    expect(await t.overview()).toEqual({ services: 0, professionals: 0, hours: 0, numbers: 0, channels: 0, testMessages: 0, agentReady: false });
    const list = await admin.ops.listTenants();
    expect(list.find((x) => x.id === id)).toMatchObject({ numbers: 0, services: 0 });
    expect(list.find((x) => x.id === SEED.barber.tenantId)).toMatchObject({ numbers: 1, services: 4, professionals: 2, agentReady: true, testMessages: 0 });
  });

  it('segmento saúde já nasce com "consulta"', async () => {
    const id = await admin.ops.createTenant(
      { name: 'Clínica X', segment: 'health', timezone: 'America/Sao_Paulo', address: 'Rua A, 1', agentName: 'Bia' },
      NOW,
    );
    expect(await admin.forTenant(id).getAgent()).toMatchObject({ bookingTerm: 'consulta' });
  });

  it('edita dados e atendente só da própria empresa', async () => {
    const t = barber();
    const before = (await t.getTenant())!;
    await t.updateTenant({ ...before, remindersEnabled: true, address: 'Rua Nova, 1' });
    expect(await t.getTenant()).toMatchObject({ remindersEnabled: true, address: 'Rua Nova, 1' });
    await t.updateTenant({ ...before });

    const agent = (await t.getAgent())!;
    expect(await t.updateAgent(agent.id, { ...agent, tone: 'Bem direto.' })).toBe(true);
    expect((await t.getAgent())!.tone).toBe('Bem direto.');
    // Atendente de outra empresa: nada muda.
    expect(await dental().updateAgent(agent.id, { ...agent, tone: 'invasão' })).toBe(false);
    expect((await t.getAgent())!.tone).toBe('Bem direto.');
  });

  it('serviço com quem faz; profissional de outra empresa é ignorado', async () => {
    const t = barber();
    const profs = await t.listProfessionals();
    const dentalProf = (await dental().listProfessionals())[0]!;
    const id = await t.saveService(null, {
      name: 'Sobrancelha',
      description: '',
      durationMin: 15,
      bufferMin: 5,
      priceMode: 'fixed',
      priceCents: 2000,
      active: true,
      professionalIds: [profs[0]!.id, dentalProf.id],
    });
    const saved = (await t.listServices()).find((s) => s.id === id)!;
    expect(saved).toMatchObject({ name: 'Sobrancelha', priceCents: 2000, professionalIds: [profs[0]!.id] });
    // Outra empresa não altera o serviço.
    expect(await dental().saveService(id, { ...saved, name: 'invasão' })).toBeNull();
    // Desativar mantém o histórico.
    await t.saveService(id, { ...saved, active: false, professionalIds: [] });
    expect((await t.listServices()).find((s) => s.id === id)).toMatchObject({ active: false, professionalIds: [] });
  });

  it('profissional: cria, edita e agenda própria', async () => {
    const t = barber();
    const id = (await t.saveProfessional(null, { name: 'Lia', title: 'Barbeira', active: true }))!;
    await t.setProfessionalCalendar(id, 'lia@gmail.com');
    expect((await t.listProfessionals()).find((p) => p.id === id)).toMatchObject({
      name: 'Lia',
      googleCalendarId: 'lia@gmail.com',
      serviceIds: [],
    });
    expect(await dental().saveProfessional(id, { name: 'x', title: null, active: true })).toBeNull();
  });

  it('horários: troca os da casa e os de um profissional', async () => {
    const t = barber();
    const prof = (await t.listProfessionals())[0]!;
    await t.replaceHours(null, { 2: [{ opensMin: 540, closesMin: 720 }, { opensMin: 780, closesMin: 1080 }], 6: [{ opensMin: 480, closesMin: 720 }] });
    await t.replaceHours(prof.id, { 3: [{ opensMin: 600, closesMin: 900 }] });
    const hours = await t.listHours();
    expect(hours.filter((h) => h.professionalId === null)).toHaveLength(3);
    expect(hours.filter((h) => h.professionalId === prof.id)).toEqual([
      { professionalId: prof.id, weekday: 3, opensMin: 600, closesMin: 900 },
    ]);
    // Profissional de outra empresa: nada gravado.
    await dental().replaceHours(prof.id, { 1: [{ opensMin: 60, closesMin: 120 }] });
    expect((await t.listHours()).filter((h) => h.professionalId === prof.id)).toHaveLength(1);
    expect((await dental().listHours()).some((h) => h.professionalId === prof.id)).toBe(false);
  });

  it('folgas e regras da agenda', async () => {
    const t = barber();
    const prof = (await t.listProfessionals())[0]!;
    const id = await t.addTimeOff({ professionalId: prof.id, startsAt: '2026-10-20T12:00:00.000Z', endsAt: '2026-10-20T15:00:00.000Z', reason: 'médico' });
    expect(await t.listTimeOff(NOW)).toEqual([expect.objectContaining({ id, reason: 'médico' })]);
    expect(await dental().addTimeOff({ professionalId: prof.id, startsAt: NOW, endsAt: '2026-10-05T00:00:00.000Z', reason: null })).toBeNull();
    await dental().deleteTimeOff(id!);
    expect(await t.listTimeOff(NOW)).toHaveLength(1);
    await t.deleteTimeOff(id!);
    expect(await t.listTimeOff(NOW)).toHaveLength(0);

    await t.saveRules({ slotStepMin: 30, minAdvanceMin: 120, maxDaysAhead: 15, maxOptions: 4 });
    expect(await t.getRules()).toEqual({ slotStepMin: 30, minAdvanceMin: 120, maxDaysAhead: 15, maxOptions: 4 });
  });

  it('número: liga à conta Meta e não aceita número já usado', async () => {
    await mem.db
      .prepare("INSERT INTO meta_accounts (id, waba_id, created_at) VALUES ('MA1', '100000000000010', ?)")
      .bind(NOW)
      .run();
    const t = dental();
    expect(await t.addPhone({ metaAccountId: 'MA1', metaPhoneNumberId: '555000111', displayPhone: '+55 11 95555-0000' }, NOW)).toBe(true);
    // Mesmo número da Meta em outra empresa: recusado.
    expect(await barber().addPhone({ metaAccountId: 'MA1', metaPhoneNumberId: '555000111', displayPhone: 'x' }, NOW)).toBe(false);
    // Conta Meta inexistente: recusado.
    expect(await t.addPhone({ metaAccountId: 'NAO', metaPhoneNumberId: '555000222', displayPhone: 'x' }, NOW)).toBe(false);
    const phone = (await t.listPhones()).find((p) => p.metaPhoneNumberId === '555000111')!;
    await t.setPhoneStatus(phone.id, 'disabled');
    expect((await t.listPhones()).find((p) => p.id === phone.id)!.status).toBe('disabled');
    expect((await admin.ops.listMetaAccounts())[0]).toMatchObject({ wabaId: '100000000000010', hasToken: false, numbers: 1 });
  });

  it('canais do Telegram: link de uso único e remoção', async () => {
    const t = barber();
    await t.createChannelLink('Recepção', 'codigo-unico-123', '2026-10-05T12:00:00.000Z', NOW);
    const ch = (await t.listChannels()).find((c) => c.label === 'Recepção')!;
    expect(ch).toMatchObject({ active: false, linkExpiresAt: '2026-10-05T12:00:00.000Z' });
    await dental().removeChannel(ch.id);
    expect((await t.listChannels()).some((c) => c.id === ch.id)).toBe(true);
    await t.removeChannel(ch.id);
    expect((await t.listChannels()).some((c) => c.id === ch.id)).toBe(false);
  });

  it('conversas e medidor só da própria empresa', async () => {
    const db = mem.db;
    await db.batch([
      db.prepare("INSERT INTO contacts (id, tenant_id, wa_id, profile_name, last_seen_at, created_at) VALUES ('CT1', ?1, '5519911112222', 'Ana', ?2, ?2)").bind(SEED.barber.tenantId, NOW),
      db.prepare("INSERT INTO conversations (id, tenant_id, phone_number_id, contact_id, updated_at) VALUES ('CV1', ?1, ?2, 'CT1', ?3)").bind(SEED.barber.tenantId, SEED.barber.phoneNumberId, NOW),
      db.prepare("INSERT INTO messages (id, tenant_id, conversation_id, direction, author, kind, body, created_at) VALUES ('M1', ?1, 'CV1', 'in', 'customer', 'text', 'oi', ?2)").bind(SEED.barber.tenantId, NOW),
      db.prepare("INSERT INTO usage_monthly (tenant_id, phone_number_id, month, msgs_in, replies_out, service_billed) VALUES (?1, ?2, '2026-10', 3, 3, 2)").bind(SEED.barber.tenantId, SEED.barber.phoneNumberId),
    ]);
    const list = await barber().listConversations('2026-09-27T00:00:00.000Z');
    expect(list).toEqual([expect.objectContaining({ id: 'CV1', contactName: 'Ana', status: 'bot', phoneKind: 'whatsapp' })]);
    expect(await dental().listConversations('2026-09-27T00:00:00.000Z')).toEqual([]);
    expect(await dental().getConversation('CV1')).toBeNull();
    expect((await barber().getConversation('CV1'))!.messages).toEqual([expect.objectContaining({ body: 'oi', author: 'customer' })]);

    expect(await barber().listUsage('2026-10')).toEqual([expect.objectContaining({ msgsIn: 3, serviceBilled: 2, kind: 'whatsapp' })]);
    expect(await dental().listUsage('2026-10')).toEqual([]);
    expect(await admin.ops.listUsage('2026-10')).toEqual([expect.objectContaining({ tenantName: 'Barbearia do Zé', msgsIn: 3 })]);
  });
});
