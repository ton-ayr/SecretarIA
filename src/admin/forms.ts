import type {
  AgentUpdate,
  HourInterval,
  NewPhone,
  NewTenant,
  ProfessionalInput,
  ServiceInput,
  TenantUpdate,
  TimeOffInput,
  WeekHours,
} from '../ports/admin.ts';
import type { PriceMode, Segment } from '../ports/domain.ts';
import type { SchedulingRules } from '../ports/scheduling.ts';
import { parseDateKey, zonedTimeToUtc } from '../shared/time.ts';

/**
 * Validação dos formulários do painel (no servidor, sempre). Cada função
 * devolve o valor pronto para gravar ou os erros por campo, em pt-BR.
 */

export type FormValues = Record<string, string | string[]>;
export type Parsed<T> = { ok: T } | { errors: Record<string, string> };

/** Fusos do Brasil (IANA). */
export const TIMEZONES = [
  'America/Sao_Paulo',
  'America/Bahia',
  'America/Fortaleza',
  'America/Recife',
  'America/Maceio',
  'America/Belem',
  'America/Araguaina',
  'America/Santarem',
  'America/Manaus',
  'America/Cuiaba',
  'America/Campo_Grande',
  'America/Porto_Velho',
  'America/Boa_Vista',
  'America/Rio_Branco',
  'America/Noronha',
] as const;

/** Nomes amigáveis dos fusos (o valor gravado continua o IANA). */
export const TIMEZONE_LABELS: Record<(typeof TIMEZONES)[number], string> = {
  'America/Sao_Paulo': 'Brasília — SP, RJ, MG, ES, Sul, GO, DF (UTC−3)',
  'America/Bahia': 'Bahia (UTC−3)',
  'America/Fortaleza': 'Fortaleza — CE, RN, PB, PI, MA (UTC−3)',
  'America/Recife': 'Recife — PE (UTC−3)',
  'America/Maceio': 'Maceió — AL, SE (UTC−3)',
  'America/Belem': 'Belém — PA (leste), AP (UTC−3)',
  'America/Araguaina': 'Araguaína — TO (UTC−3)',
  'America/Santarem': 'Santarém — PA (oeste) (UTC−3)',
  'America/Manaus': 'Manaus — AM (UTC−4)',
  'America/Cuiaba': 'Cuiabá — MT (UTC−4)',
  'America/Campo_Grande': 'Campo Grande — MS (UTC−4)',
  'America/Porto_Velho': 'Porto Velho — RO (UTC−4)',
  'America/Boa_Vista': 'Boa Vista — RR (UTC−4)',
  'America/Rio_Branco': 'Rio Branco — AC (UTC−5)',
  'America/Noronha': 'Fernando de Noronha (UTC−2)',
};

export const CALENDAR_ID_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function first(form: FormValues, key: string): string {
  const v = form[key];
  return (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
}

export function all(form: FormValues, key: string): string[] {
  const v = form[key];
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => x.trim()).filter(Boolean);
}

class Checker {
  readonly errors: Record<string, string> = {};

  text(form: FormValues, key: string, label: string, opts: { max: number; required?: boolean }): string {
    const value = first(form, key).replace(/\r\n/g, '\n');
    if (opts.required && !value) this.errors[key] = `Informe ${label}.`;
    else if (value.length > opts.max) this.errors[key] = `${capitalize(label)}: até ${opts.max} caracteres.`;
    return value;
  }

  int(form: FormValues, key: string, label: string, min: number, max: number): number {
    const raw = first(form, key);
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max) {
      this.errors[key] = `${capitalize(label)}: um número de ${min} a ${max}.`;
      return min;
    }
    return n;
  }

  oneOf<T extends string>(form: FormValues, key: string, label: string, options: readonly T[]): T {
    const value = first(form, key) as T;
    if (!options.includes(value)) {
      this.errors[key] = `Escolha ${label}.`;
      return options[0]!;
    }
    return value;
  }

  done<T>(value: T): Parsed<T> {
    return Object.keys(this.errors).length ? { errors: this.errors } : { ok: value };
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const nullIfEmpty = (s: string): string | null => (s ? s : null);
const SEGMENTS: readonly Segment[] = ['general', 'health'];

export function parseNewTenant(form: FormValues): Parsed<NewTenant> {
  const c = new Checker();
  const name = c.text(form, 'name', 'o nome da empresa', { max: 80, required: true });
  const segment = c.oneOf(form, 'segment', 'o segmento', SEGMENTS);
  const timezone = c.oneOf(form, 'timezone', 'o fuso horário', TIMEZONES);
  const address = c.text(form, 'address', 'o endereço', { max: 200 });
  const agentName = c.text(form, 'agentName', 'o nome do atendente', { max: 40, required: true });
  return c.done({ name, segment, timezone, address: nullIfEmpty(address), agentName });
}

export function parseTenantSettings(form: FormValues): Parsed<TenantUpdate> {
  const c = new Checker();
  const name = c.text(form, 'name', 'o nome da empresa', { max: 80, required: true });
  const segment = c.oneOf(form, 'segment', 'o segmento', SEGMENTS);
  const timezone = c.oneOf(form, 'timezone', 'o fuso horário', TIMEZONES);
  const address = c.text(form, 'address', 'o endereço', { max: 200 });
  const status = c.oneOf(form, 'status', 'a situação', ['active', 'suspended'] as const);
  const messageRetentionDays = c.int(form, 'messageRetentionDays', 'dias de mensagens', 1, 30);
  const contactRetentionDays = c.int(form, 'contactRetentionDays', 'dias de contatos', 30, 730);
  return c.done({
    name,
    segment,
    timezone,
    address: nullIfEmpty(address),
    status,
    remindersEnabled: first(form, 'remindersEnabled') === '1',
    messageRetentionDays,
    contactRetentionDays,
  });
}

export function parseAgent(form: FormValues): Parsed<AgentUpdate> {
  const c = new Checker();
  return c.done({
    name: c.text(form, 'name', 'o nome do atendente', { max: 40, required: true }),
    tone: c.text(form, 'tone', 'o tom', { max: 300 }),
    instructions: c.text(form, 'instructions', 'as instruções', { max: 2000 }),
    knowledgeBase: c.text(form, 'knowledgeBase', 'as informações da empresa', { max: 4000 }),
    bookingTerm: c.text(form, 'bookingTerm', 'como chamar o agendamento', { max: 30, required: true }),
    professionalTerm: c.text(form, 'professionalTerm', 'como chamar o profissional', { max: 30, required: true }),
    maxReplyChars: c.int(form, 'maxReplyChars', 'o tamanho da resposta', 200, 1000),
    handoffResumeHours: c.int(form, 'handoffResumeHours', 'as horas com a equipe', 1, 72),
  });
}

/** "45", "45,9", "1.234,56", "45.90" → centavos. */
export function parseMoney(raw: string): number | null {
  const s = raw.replace(/^R\$\s*/i, '').trim();
  if (!s) return null;
  let normalized: string;
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(s)) normalized = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d+(,\d{1,2})?$/.test(s)) normalized = s.replace(',', '.');
  else if (/^\d+(\.\d{1,2})?$/.test(s)) normalized = s;
  else return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function parseService(form: FormValues, validProfessionalIds: ReadonlySet<string>): Parsed<ServiceInput> {
  const c = new Checker();
  const name = c.text(form, 'name', 'o nome do serviço', { max: 60, required: true });
  const description = c.text(form, 'description', 'a descrição', { max: 300 });
  const durationMin = c.int(form, 'durationMin', 'a duração (min)', 5, 600);
  const bufferMin = c.int(form, 'bufferMin', 'o intervalo depois (min)', 0, 240);
  const priceMode = c.oneOf<PriceMode>(form, 'priceMode', 'como mostrar o preço', ['fixed', 'from', 'on_request']);
  let priceCents: number | null = null;
  if (priceMode !== 'on_request') {
    priceCents = parseMoney(first(form, 'price'));
    if (priceCents === null || priceCents > 10_000_000) c.errors.price = 'Informe o preço (ex.: 45,00).';
  }
  const professionalIds = all(form, 'professionalIds').filter((id) => validProfessionalIds.has(id));
  return c.done({
    name,
    description,
    durationMin,
    bufferMin,
    priceMode,
    priceCents,
    active: first(form, 'active') === '1',
    professionalIds,
  });
}

export function parseProfessional(form: FormValues): Parsed<ProfessionalInput> {
  const c = new Checker();
  const name = c.text(form, 'name', 'o nome', { max: 60, required: true });
  const title = c.text(form, 'title', 'o título', { max: 30 });
  return c.done({ name, title: nullIfEmpty(title), active: first(form, 'active') === '1' });
}

/** "9", "09:30", "9h", "9h30" → minutos desde 00:00 (24:00 vale como fim do dia). */
export function parseClock(raw: string): number | null {
  const m = /^(\d{1,2})(?:[:h](\d{2})?)?h?$/.exec(raw.trim().toLowerCase().replace(/\s/g, ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59 || h > 24 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

/** "09:00-12:00, 13:00-18:00" → intervalos em ordem, sem sobreposição. */
export function parseIntervals(raw: string): HourInterval[] | null {
  const text = raw.trim();
  if (!text) return [];
  const intervals: HourInterval[] = [];
  for (const part of text.split(/[,;]|\s+e\s+/)) {
    const [a, b, extra] = part.split(/\s*(?:-|–|às|as|até)\s*/i);
    if (a === undefined || b === undefined || extra !== undefined) return null;
    const opensMin = parseClock(a);
    const closesMin = parseClock(b);
    if (opensMin === null || closesMin === null || closesMin <= opensMin) return null;
    intervals.push({ opensMin, closesMin });
  }
  intervals.sort((x, y) => x.opensMin - y.opensMin);
  for (let i = 1; i < intervals.length; i++) if (intervals[i]!.opensMin < intervals[i - 1]!.closesMin) return null;
  return intervals;
}

/** Campos d0…d6 (domingo a sábado), cada um com os intervalos do dia. */
export function parseWeekHours(form: FormValues): Parsed<WeekHours> {
  const c = new Checker();
  const week: WeekHours = {};
  for (let day = 0; day <= 6; day++) {
    const intervals = parseIntervals(first(form, `d${day}`));
    if (intervals === null) c.errors[`d${day}`] = 'Use o formato 09:00-12:00, 13:00-18:00.';
    else if (intervals.length) week[day] = intervals;
  }
  return c.done(week);
}

export function parseTimeOff(form: FormValues, timeZone: string, validProfessionalIds: ReadonlySet<string>): Parsed<TimeOffInput> {
  const c = new Checker();
  const professional = first(form, 'professionalId');
  if (professional && !validProfessionalIds.has(professional)) c.errors.professionalId = 'Escolha quem fica de folga.';
  const at = (dateKey: string, time: string, field: string, fallback: number) => {
    const minutes = time ? parseClock(time) : fallback;
    if (!parseDateKey(dateKey) || minutes === null) {
      c.errors[field] = 'Informe data e hora.';
      return null;
    }
    return zonedTimeToUtc(dateKey, minutes, timeZone);
  };
  // Sem hora: o dia inteiro.
  const start = at(first(form, 'startDate'), first(form, 'startTime'), 'startDate', 0);
  const end = at(first(form, 'endDate') || first(form, 'startDate'), first(form, 'endTime'), 'endDate', 24 * 60);
  if (start && end && end <= start) c.errors.endDate = 'O fim precisa ser depois do início.';
  const reason = c.text(form, 'reason', 'o motivo', { max: 100 });
  return c.done({
    professionalId: professional || null,
    startsAt: start?.toISOString() ?? '',
    endsAt: end?.toISOString() ?? '',
    reason: nullIfEmpty(reason),
  });
}

export function parseRules(form: FormValues): Parsed<SchedulingRules> {
  const c = new Checker();
  return c.done({
    slotStepMin: c.int(form, 'slotStepMin', 'o intervalo entre horários (min)', 5, 120),
    minAdvanceMin: c.int(form, 'minAdvanceMin', 'a antecedência mínima (min)', 0, 10_080),
    maxDaysAhead: c.int(form, 'maxDaysAhead', 'os dias à frente', 1, 365),
    maxOptions: c.int(form, 'maxOptions', 'as opções na lista', 1, 10),
  });
}

/** ID de agenda Google (um e-mail) ou vazio para desligar. */
export function parseCalendarId(form: FormValues, key = 'calendarId'): Parsed<string | null> {
  const c = new Checker();
  const value = first(form, key);
  if (value && (!CALENDAR_ID_RE.test(value) || value.length > 200)) c.errors[key] = 'O ID da agenda é um e-mail.';
  return c.done(value || null);
}

export function parsePhone(form: FormValues, validMetaAccountIds: ReadonlySet<string>): Parsed<NewPhone> {
  const c = new Checker();
  const metaAccountId = first(form, 'metaAccountId');
  if (!validMetaAccountIds.has(metaAccountId)) c.errors.metaAccountId = 'Escolha a conta Meta.';
  const metaPhoneNumberId = first(form, 'metaPhoneNumberId');
  if (!/^\d{5,30}$/.test(metaPhoneNumberId)) c.errors.metaPhoneNumberId = 'O Phone Number ID tem só números.';
  const displayPhone = first(form, 'displayPhone');
  if (!/^[+\d\s()-]{8,25}$/.test(displayPhone)) c.errors.displayPhone = 'Informe o número como aparece (ex.: +55 11 91234-5678).';
  return c.done({ metaAccountId, metaPhoneNumberId, displayPhone });
}

export function parseMetaAccount(form: FormValues): Parsed<{ wabaId: string; token: string }> {
  const c = new Checker();
  const wabaId = first(form, 'wabaId');
  if (!/^\d{5,30}$/.test(wabaId)) c.errors.wabaId = 'O ID da conta (WABA) tem só números.';
  const token = first(form, 'token');
  if (!/^[A-Za-z0-9_-]{20,1000}$/.test(token)) c.errors.token = 'Cole o token permanente do usuário do sistema.';
  return c.done({ wabaId, token });
}

export function parseChannelLabel(form: FormValues): Parsed<string | null> {
  const c = new Checker();
  const label = c.text(form, 'label', 'o nome de quem recebe', { max: 30 }).replace(/[^\p{L}\p{N} ]/gu, '');
  return c.done(nullIfEmpty(label));
}
