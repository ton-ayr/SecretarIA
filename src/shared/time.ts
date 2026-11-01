// Datas guardadas em UTC (ISO 8601). Exibição sempre no fuso da empresa.

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const WEEKDAYS_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday] ?? '';
}

export function weekdayShort(weekday: number): string {
  return WEEKDAYS_SHORT[weekday] ?? '';
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: EN_WEEKDAYS.indexOf(parts.weekday ?? ''),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "terça-feira, 14/10/2026 15:00" no fuso informado. */
export function formatLocalDateTime(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${weekdayName(p.weekday)}, ${pad(p.day)}/${pad(p.month)}/${p.year} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** Minutos desde 00:00 → "09:30". */
export function formatMinutes(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

/** "2026-10" em UTC. */
export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** "2026-10-02" em UTC (as cotas diárias dos provedores viram em UTC). */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---- Datas locais da empresa (agenda) ----

/** "2026-10-14" no fuso da empresa. */
export function localDateKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Valida "AAAA-MM-DD" (data real). */
export function parseDateKey(key: string): { year: number; month: number; day: number } | null {
  const m = DATE_KEY.exec(key);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function addDaysToKey(key: string, days: number): string {
  const p = parseDateKey(key)!;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return d.toISOString().slice(0, 10);
}

/** Dia da semana (0 = domingo) de uma data local "AAAA-MM-DD". */
export function weekdayOfKey(key: string): number {
  const p = parseDateKey(key)!;
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Diferença (ms) entre o relógio local do fuso e o UTC naquele instante. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const p = localParts(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(instantMs / 60_000) * 60_000;
}

/**
 * Converte "data local + minutos desde 00:00" no fuso da empresa para o
 * instante UTC. Duas passadas acertam a mudança de horário de verão.
 */
export function zonedTimeToUtc(dateKey: string, minutes: number, timeZone: string): Date {
  const p = parseDateKey(dateKey)!;
  const wall = Date.UTC(p.year, p.month - 1, p.day, 0, minutes);
  let guess = wall - zoneOffsetMs(wall, timeZone);
  guess = wall - zoneOffsetMs(guess, timeZone);
  return new Date(guess);
}

/** Minutos desde 00:00 no fuso da empresa. */
export function localMinutes(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

/** "ter 14/10" */
export function formatShortDate(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${weekdayShort(p.weekday).toLowerCase()} ${pad(p.day)}/${pad(p.month)}`;
}

/** "terça-feira, 14/10 às 15:00" */
export function formatAppointmentTime(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${weekdayName(p.weekday)}, ${pad(p.day)}/${pad(p.month)} às ${pad(p.hour)}:${pad(p.minute)}`;
}
