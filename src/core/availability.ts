import type { BusinessHour, Professional } from '../ports/domain.ts';
import type { BusyInterval, SchedulingRules } from '../ports/scheduling.ts';
import { addDaysToKey, localDateKey, weekdayOfKey, zonedTimeToUtc } from '../shared/time.ts';

/**
 * Horários livres de um serviço numa data, no fuso da empresa
 * (ARQUITETURA §8). Função pura: recebe tudo e devolve os horários.
 *
 * 1. expediente do profissional (ou da casa, se ele não tiver próprio);
 * 2. tira folgas, agendamentos (com o intervalo depois do serviço) e
 *    horários ocupados na agenda Google;
 * 3. gera horários a cada `slotStepMin` onde o serviço cabe no expediente;
 * 4. aplica antecedência mínima e limite de dias;
 * 5. devolve até `maxOptions`, espalhados ao longo do dia.
 */

export type { BusyInterval, SchedulingRules };

export const DEFAULT_RULES: SchedulingRules = { slotStepMin: 15, minAdvanceMin: 60, maxDaysAhead: 30, maxOptions: 6 };

export interface AvailabilityQuery {
  dateKey: string;
  timezone: string;
  durationMin: number;
  bufferMin: number;
  /** Profissionais aptos, na ordem de preferência. */
  professionals: Professional[];
  hours: BusinessHour[];
  busy: BusyInterval[];
  rules: SchedulingRules;
  now: Date;
}

export interface Slot {
  professionalId: string;
  start: Date;
  end: Date;
  /** Fim do serviço + intervalo (o que ocupa a agenda). */
  blockEnd: Date;
}

export type NoSlotReason = 'closed' | 'past' | 'too_far' | 'full';

export interface AvailabilityResult {
  slots: Slot[];
  reason: NoSlotReason | null;
}

function windowsFor(professionalId: string, weekday: number, hours: BusinessHour[]): Array<[number, number]> {
  const own = hours.filter((h) => h.professionalId === professionalId);
  const source = own.length > 0 ? own : hours.filter((h) => h.professionalId === null);
  return source
    .filter((h) => h.weekday === weekday)
    .map((h): [number, number] => [h.opensMin, h.closesMin])
    .sort((a, b) => a[0] - b[0]);
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/** Todos os horários válidos (sem limitar quantidade). */
export function computeSlots(q: AvailabilityQuery): AvailabilityResult {
  const today = localDateKey(q.now, q.timezone);
  if (q.dateKey < today) return { slots: [], reason: 'past' };
  if (q.dateKey > addDaysToKey(today, q.rules.maxDaysAhead)) return { slots: [], reason: 'too_far' };

  const weekday = weekdayOfKey(q.dateKey);
  const earliest = q.now.getTime() + q.rules.minAdvanceMin * 60_000;
  const busy = q.busy.map((b) => ({ p: b.professionalId, s: Date.parse(b.start), e: Date.parse(b.end) }));
  let anyWindow = false;
  const slots: Slot[] = [];

  for (const prof of q.professionals) {
    const windows = windowsFor(prof.id, weekday, q.hours);
    if (windows.length) anyWindow = true;
    for (const [open, close] of windows) {
      for (let m = open; m + q.durationMin <= close; m += q.rules.slotStepMin) {
        const start = zonedTimeToUtc(q.dateKey, m, q.timezone);
        const s = start.getTime();
        if (s < earliest) continue;
        const end = s + q.durationMin * 60_000;
        const blockEnd = end + q.bufferMin * 60_000;
        const taken = busy.some((b) => (b.p === null || b.p === prof.id) && overlaps(s, blockEnd, b.s, b.e));
        if (!taken) slots.push({ professionalId: prof.id, start, end: new Date(end), blockEnd: new Date(blockEnd) });
      }
    }
  }
  if (!anyWindow) return { slots: [], reason: 'closed' };
  slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { slots, reason: slots.length ? null : 'full' };
}

/**
 * Horários para mostrar ao cliente. Sem preferência de profissional, cada
 * horário aparece uma vez (com o primeiro profissional livre); depois, no
 * máximo `maxOptions`, espalhados do começo ao fim do dia.
 */
export function pickOptions(slots: Slot[], maxOptions: number, near?: Date): Slot[] {
  const byTime = new Map<number, Slot>();
  for (const s of slots) if (!byTime.has(s.start.getTime())) byTime.set(s.start.getTime(), s);
  const unique = [...byTime.values()];
  if (unique.length <= maxOptions) return unique;
  // Cliente disse um horário: os mais próximos dele, em ordem.
  if (near) {
    const t = near.getTime();
    const distance = (s: Slot) => Math.abs(s.start.getTime() - t);
    return [...unique]
      .sort((a, b) => distance(a) - distance(b) || a.start.getTime() - b.start.getTime())
      .slice(0, maxOptions)
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  }
  const picked: Slot[] = [];
  for (let i = 0; i < maxOptions; i++) {
    picked.push(unique[Math.round((i * (unique.length - 1)) / (maxOptions - 1))]!);
  }
  return picked;
}

/** O horário pedido (profissional + início) é válido agora? */
export function findSlot(q: AvailabilityQuery, professionalId: string, start: Date): Slot | null {
  const { slots } = computeSlots({ ...q, professionals: q.professionals.filter((p) => p.id === professionalId) });
  return slots.find((s) => s.start.getTime() === start.getTime()) ?? null;
}
