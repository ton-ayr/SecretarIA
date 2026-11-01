import { describe, expect, it } from 'vitest';
import { computeSlots, DEFAULT_RULES, findSlot, pickOptions, type AvailabilityQuery } from '../src/core/availability.ts';
import { addDaysToKey, formatAppointmentTime, localDateKey, parseDateKey, weekdayOfKey, zonedTimeToUtc } from '../src/shared/time.ts';

const TZ = 'America/Sao_Paulo';
const ZE = { id: 'ze', name: 'Zé', title: null };
const RAFA = { id: 'rafa', name: 'Rafael', title: null };
// Casa: terça a sábado 09:00–12:00 (curto, para contar fácil).
const HOURS = [2, 3, 4, 5, 6].map((weekday) => ({ professionalId: null, weekday, opensMin: 540, closesMin: 720 }));

// Segunda, 13/10/2026, 08:00 em São Paulo.
const NOW = new Date('2026-10-13T11:00:00.000Z');

function q(over: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    dateKey: '2026-10-14', // quarta
    timezone: TZ,
    durationMin: 30,
    bufferMin: 0,
    professionals: [ZE],
    hours: HOURS,
    busy: [],
    rules: { ...DEFAULT_RULES, slotStepMin: 30 },
    now: NOW,
    ...over,
  };
}

const times = (r: { slots: Array<{ start: Date }> }) => r.slots.map((s) => formatAppointmentTime(s.start, TZ).slice(-5));

describe('fuso e datas locais', () => {
  it('converte horário local de São Paulo para UTC', () => {
    expect(zonedTimeToUtc('2026-10-14', 15 * 60, TZ).toISOString()).toBe('2026-10-14T18:00:00.000Z');
  });

  it('acerta horário de verão (Nova York, março)', () => {
    // 2026-03-08: Nova York muda de -05 para -04 às 02:00.
    expect(zonedTimeToUtc('2026-03-07', 10 * 60, 'America/New_York').toISOString()).toBe('2026-03-07T15:00:00.000Z');
    expect(zonedTimeToUtc('2026-03-09', 10 * 60, 'America/New_York').toISOString()).toBe('2026-03-09T14:00:00.000Z');
  });

  it('valida datas e calcula dia da semana', () => {
    expect(parseDateKey('2026-02-30')).toBeNull();
    expect(parseDateKey('14/10/2026')).toBeNull();
    expect(weekdayOfKey('2026-10-14')).toBe(3);
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(localDateKey(new Date('2026-10-14T02:00:00Z'), TZ)).toBe('2026-10-13');
  });
});

describe('horários livres', () => {
  it('gera horários no expediente onde o serviço cabe', () => {
    expect(times(computeSlots(q()))).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
    // 60 min não cabe começando às 11:30.
    expect(times(computeSlots(q({ durationMin: 60 })))).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  it('dia fechado, data passada e longe demais', () => {
    expect(computeSlots(q({ dateKey: '2026-10-18' })).reason).toBe('closed'); // domingo
    expect(computeSlots(q({ dateKey: '2026-10-12' })).reason).toBe('past');
    expect(computeSlots(q({ dateKey: '2026-12-31' })).reason).toBe('too_far');
  });

  it('respeita antecedência mínima', () => {
    // Agora: terça 14/10 09:20 (12:20 UTC), antecedência de 60 min → a partir de 10:20.
    const r = computeSlots(q({ now: new Date('2026-10-14T12:20:00.000Z') }));
    expect(times(r)).toEqual(['10:30', '11:00', '11:30']);
  });

  it('tira agendamentos (com intervalo), folgas e bloqueios da agenda Google', () => {
    const busy = [
      // agendamento 09:30–10:00 com 15 min de intervalo → ocupa até 10:15
      { professionalId: 'ze', start: '2026-10-14T12:30:00.000Z', end: '2026-10-14T13:15:00.000Z' },
      // bloqueio da empresa toda (Google) 11:00–11:30
      { professionalId: null, start: '2026-10-14T14:00:00.000Z', end: '2026-10-14T14:30:00.000Z' },
    ];
    expect(times(computeSlots(q({ busy })))).toEqual(['09:00', '10:30', '11:30']);
  });

  it('o intervalo do próprio serviço também conta', () => {
    const busy = [{ professionalId: 'ze', start: '2026-10-14T13:30:00.000Z', end: '2026-10-14T14:00:00.000Z' }]; // 10:30–11:00
    // Com 15 min de intervalo, começar às 10:00 ocuparia até 10:45 e bateria.
    expect(times(computeSlots(q({ busy, bufferMin: 15 })))).toEqual(['09:00', '09:30', '11:00', '11:30']);
  });

  it('expediente próprio do profissional substitui o da casa', () => {
    const hours = [...HOURS, { professionalId: 'rafa', weekday: 3, opensMin: 600, closesMin: 660 }];
    const r = computeSlots(q({ professionals: [RAFA], hours }));
    expect(times(r)).toEqual(['10:00', '10:30']);
  });

  it('sem preferência: cada horário uma vez, com o primeiro profissional livre', () => {
    const busy = [{ professionalId: 'ze', start: '2026-10-14T12:00:00.000Z', end: '2026-10-14T12:30:00.000Z' }]; // Zé ocupado 09:00
    const r = computeSlots(q({ professionals: [ZE, RAFA], busy }));
    const options = pickOptions(r.slots, 10);
    expect(options[0]).toMatchObject({ professionalId: 'rafa' });
    expect(options[1]).toMatchObject({ professionalId: 'ze' });
    expect(options).toHaveLength(6);
  });

  it('limita a quantidade espalhando ao longo do dia', () => {
    const r = computeSlots(q({ rules: { ...DEFAULT_RULES, slotStepMin: 15 } }));
    const picked = pickOptions(r.slots, 3);
    expect(picked.map((s) => formatAppointmentTime(s.start, TZ).slice(-5))).toEqual(['09:00', '10:15', '11:30']);
  });

  it('com hora de preferência: os mais próximos dela, em ordem', () => {
    const r = computeSlots(q({ rules: { ...DEFAULT_RULES, slotStepMin: 15 } }));
    const picked = pickOptions(r.slots, 4, zonedTimeToUtc('2026-10-14', 600, TZ));
    expect(picked.map((s) => formatAppointmentTime(s.start, TZ).slice(-5))).toEqual(['09:30', '09:45', '10:00', '10:15']);
    // Hora no fim do expediente: pega os últimos.
    const late = pickOptions(r.slots, 3, zonedTimeToUtc('2026-10-14', 720, TZ));
    expect(late.map((s) => formatAppointmentTime(s.start, TZ).slice(-5))).toEqual(['11:00', '11:15', '11:30']);
  });

  it('confere um horário específico (para marcar)', () => {
    expect(findSlot(q(), 'ze', zonedTimeToUtc('2026-10-14', 600, TZ))).not.toBeNull();
    expect(findSlot(q(), 'ze', zonedTimeToUtc('2026-10-14', 605, TZ))).toBeNull(); // fora da grade
    expect(findSlot(q(), 'ze', zonedTimeToUtc('2026-10-14', 750, TZ))).toBeNull(); // fora do expediente
  });

  it('dia todo cheio', () => {
    const busy = [{ professionalId: null, start: '2026-10-14T12:00:00.000Z', end: '2026-10-14T15:00:00.000Z' }];
    expect(computeSlots(q({ busy })).reason).toBe('full');
  });
});
