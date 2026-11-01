import { describe, expect, it } from 'vitest';
import {
  parseAgent,
  parseCalendarId,
  parseClock,
  parseIntervals,
  parseMetaAccount,
  parseMoney,
  parseNewTenant,
  parsePhone,
  parseRules,
  parseService,
  parseTenantSettings,
  parseTimeOff,
  parseWeekHours,
  type Parsed,
} from '../src/admin/forms.ts';

const errorsOf = (r: Parsed<unknown>) => ('errors' in r ? Object.keys(r.errors).sort() : []);

describe('formulários do painel', () => {
  it('empresa nova: obrigatórios, segmento e fuso da lista', () => {
    expect(
      parseNewTenant({ name: ' Cartas da Luna ', segment: 'general', timezone: 'America/Sao_Paulo', address: '', agentName: 'Luna' }),
    ).toEqual({ ok: { name: 'Cartas da Luna', segment: 'general', timezone: 'America/Sao_Paulo', address: null, agentName: 'Luna' } });
    const bad = parseNewTenant({ name: '', segment: 'pet', timezone: 'Europe/Paris', agentName: '' });
    expect(errorsOf(bad)).toEqual(['agentName', 'name', 'segment', 'timezone']);
  });

  it('configurações: lembretes, situação e prazos de retenção', () => {
    const r = parseTenantSettings({
      name: 'X',
      segment: 'health',
      timezone: 'America/Manaus',
      address: 'Rua A',
      status: 'suspended',
      remindersEnabled: '1',
      messageRetentionDays: '7',
      contactRetentionDays: '365',
    });
    expect(r).toMatchObject({ ok: { segment: 'health', status: 'suspended', remindersEnabled: true, messageRetentionDays: 7 } });
    expect(errorsOf(parseTenantSettings({ name: 'X', segment: 'general', timezone: 'America/Sao_Paulo', status: 'active', messageRetentionDays: '90', contactRetentionDays: '5' }))).toEqual([
      'contactRetentionDays',
      'messageRetentionDays',
    ]);
  });

  it('atendente: limites de tamanho', () => {
    const base = { name: 'Luna', bookingTerm: 'consulta', professionalTerm: 'taróloga', maxReplyChars: '500', handoffResumeHours: '12' };
    expect(parseAgent(base)).toMatchObject({ ok: { name: 'Luna', instructions: '', maxReplyChars: 500 } });
    expect(errorsOf(parseAgent({ ...base, knowledgeBase: 'x'.repeat(4001), maxReplyChars: '50' }))).toEqual(['knowledgeBase', 'maxReplyChars']);
  });

  it('dinheiro em reais vira centavos', () => {
    expect(parseMoney('45')).toBe(4500);
    expect(parseMoney('45,9')).toBe(4590);
    expect(parseMoney('R$ 1.234,56')).toBe(123456);
    expect(parseMoney('45.90')).toBe(4590);
    expect(parseMoney('0')).toBe(0);
    expect(parseMoney('quarenta')).toBeNull();
    expect(parseMoney('45,999')).toBeNull();
  });

  it('serviço: preço conforme o modo e só profissionais da empresa', () => {
    const profs = new Set(['P1', 'P2']);
    const r = parseService(
      { name: 'Tarot', durationMin: '60', bufferMin: '10', priceMode: 'fixed', price: '120,00', active: '1', professionalIds: ['P1', 'INVASOR'] },
      profs,
    );
    expect(r).toEqual({
      ok: { name: 'Tarot', description: '', durationMin: 60, bufferMin: 10, priceMode: 'fixed', priceCents: 12000, active: true, professionalIds: ['P1'] },
    });
    expect(parseService({ name: 'Mapa', durationMin: '90', bufferMin: '0', priceMode: 'on_request', price: '' }, profs)).toMatchObject({
      ok: { priceCents: null, active: false, professionalIds: [] },
    });
    expect(errorsOf(parseService({ name: 'X', durationMin: '0', bufferMin: '0', priceMode: 'from', price: '' }, profs))).toEqual(['durationMin', 'price']);
  });

  it('horários: formatos que o operador digita', () => {
    expect(parseClock('9')).toBe(540);
    expect(parseClock('9h30')).toBe(570);
    expect(parseClock('24:00')).toBe(1440);
    expect(parseClock('24:30')).toBeNull();
    expect(parseIntervals('09:00-12:00, 13:00-18:00')).toEqual([
      { opensMin: 540, closesMin: 720 },
      { opensMin: 780, closesMin: 1080 },
    ]);
    expect(parseIntervals('9h às 12h e 14h às 18h')).toEqual([
      { opensMin: 540, closesMin: 720 },
      { opensMin: 840, closesMin: 1080 },
    ]);
    expect(parseIntervals('')).toEqual([]);
    expect(parseIntervals('12:00-09:00')).toBeNull(); // fim antes do início
    expect(parseIntervals('09:00-12:00, 11:00-13:00')).toBeNull(); // sobreposição
    const week = parseWeekHours({ d1: '', d2: '09:00-18:00', d6: '08:00-12:00', d3: 'manhã' });
    expect(errorsOf(week)).toEqual(['d3']);
    expect(parseWeekHours({ d2: '09:00-18:00' })).toEqual({ ok: { 2: [{ opensMin: 540, closesMin: 1080 }] } });
  });

  it('folga: no fuso da empresa; sem hora vale o dia inteiro', () => {
    const profs = new Set(['P1']);
    expect(parseTimeOff({ professionalId: '', startDate: '2026-10-20', reason: 'feriado' }, 'America/Sao_Paulo', profs)).toEqual({
      ok: { professionalId: null, startsAt: '2026-10-20T03:00:00.000Z', endsAt: '2026-10-21T03:00:00.000Z', reason: 'feriado' },
    });
    expect(
      parseTimeOff({ professionalId: 'P1', startDate: '2026-10-20', startTime: '14:00', endDate: '2026-10-20', endTime: '16:00' }, 'America/Sao_Paulo', profs),
    ).toMatchObject({ ok: { professionalId: 'P1', startsAt: '2026-10-20T17:00:00.000Z', endsAt: '2026-10-20T19:00:00.000Z' } });
    expect(errorsOf(parseTimeOff({ professionalId: 'X', startDate: '2026-10-20', startTime: '16:00', endTime: '14:00' }, 'America/Sao_Paulo', profs))).toEqual([
      'endDate',
      'professionalId',
    ]);
  });

  it('regras, agenda Google, número e conta Meta', () => {
    expect(parseRules({ slotStepMin: '30', minAdvanceMin: '120', maxDaysAhead: '60', maxOptions: '6' })).toEqual({
      ok: { slotStepMin: 30, minAdvanceMin: 120, maxDaysAhead: 60, maxOptions: 6 },
    });
    expect(errorsOf(parseRules({ slotStepMin: '1', minAdvanceMin: '-5', maxDaysAhead: '0', maxOptions: '20' }))).toHaveLength(4);
    expect(parseCalendarId({ calendarId: 'abc@group.calendar.google.com' })).toEqual({ ok: 'abc@group.calendar.google.com' });
    expect(parseCalendarId({ calendarId: '' })).toEqual({ ok: null });
    expect(errorsOf(parseCalendarId({ calendarId: "x'; DROP" }))).toEqual(['calendarId']);
    expect(parsePhone({ metaAccountId: 'MA1', metaPhoneNumberId: '100000000000020', displayPhone: '+1 555 000 0100' }, new Set(['MA1']))).toMatchObject({
      ok: { metaPhoneNumberId: '100000000000020' },
    });
    expect(errorsOf(parsePhone({ metaAccountId: 'X', metaPhoneNumberId: 'abc', displayPhone: '1' }, new Set(['MA1'])))).toHaveLength(3);
    expect(parseMetaAccount({ wabaId: '100000000000010', token: 'EAAG' + 'x'.repeat(40) })).toMatchObject({ ok: { wabaId: '100000000000010' } });
    expect(errorsOf(parseMetaAccount({ wabaId: 'x', token: 'curto' }))).toEqual(['token', 'wabaId']);
  });
});
