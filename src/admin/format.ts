import type { HourInterval } from '../ports/admin.ts';
import type { Segment } from '../ports/domain.ts';
import { formatBRL } from '../shared/money.ts';
import { formatWaId } from '../shared/phone.ts';
import { formatMinutes, localParts } from '../shared/time.ts';

// Formatação só para exibir no painel (pt-BR, fuso da empresa).

const pad = (n: number) => String(n).padStart(2, '0');

export function fmtDateTime(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  const p = localParts(new Date(iso), timeZone);
  return `${pad(p.day)}/${pad(p.month)}/${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function fmtShort(iso: string | null, timeZone: string): string {
  if (!iso) return '—';
  const p = localParts(new Date(iso), timeZone);
  return `${pad(p.day)}/${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function fmtPhone(waId: string): string {
  return /^\d+$/.test(waId) ? formatWaId(waId) : waId;
}

export function intervalsText(intervals: HourInterval[]): string {
  return intervals.map((i) => `${formatMinutes(i.opensMin)}-${formatMinutes(i.closesMin)}`).join(', ');
}

export function fmtInt(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function fmtUsdMicros(micros: number): string {
  return `US$ ${(micros / 1_000_000).toFixed(4).replace('.', ',')}`;
}

/** Custo estimado da Meta: mensagens × preço em milésimos de real. */
export function fmtMetaCost(messages: number, brlMilliPerMessage: number): string {
  return formatBRL(Math.round((messages * brlMilliPerMessage) / 10));
}

export function fmtMonth(month: string): string {
  const [y, m] = month.split('-');
  return `${m}/${y}`;
}

export const SEGMENT_LABEL: Record<Segment, string> = { general: 'Geral', health: 'Saúde' };
export const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
