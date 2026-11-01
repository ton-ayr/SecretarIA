import type { ExternalBusy, ExternalCalendar } from '../ports/calendar.ts';
import type { Professional, Service, TurnContext } from '../ports/domain.ts';
import type { Clock, Logger, LogFields } from '../ports/runtime.ts';
import type { AppointmentView, BusyInterval, SchedulingRepo } from '../ports/scheduling.ts';
import { randomToken } from '../shared/crypto.ts';
import { ulid } from '../shared/ids.ts';
import {
  addDaysToKey,
  formatAppointmentTime,
  formatMinutes,
  formatShortDate,
  localDateKey,
  localMinutes,
  parseDateKey,
  weekdayOfKey,
  weekdayName,
  zonedTimeToUtc,
} from '../shared/time.ts';
import { computeSlots, findSlot, pickOptions, type AvailabilityQuery, type Slot } from './availability.ts';
import { formatServicePrice, professionalLabel } from './catalog.ts';
import { REMINDER_MIN_AGE_MS, REMINDER_WINDOW } from './reminders.ts';
import type { Reply, ReplyButton } from './engine.ts';
import { sanitizeName } from './prompt.ts';
import type { Tool, ToolResult } from './tools.ts';

/**
 * Agenda pela conversa (ARQUITETURA §8). A IA só interpreta o pedido
 * e preenche os argumentos; o que o cliente lê sobre horários, marcação,
 * remarcação e cancelamento é sempre texto do servidor (`final`), montado a
 * partir do banco. Assim a IA não tem como inventar disponibilidade.
 */

export type SchedulingAction = 'booked' | 'rescheduled' | 'cancelled';
export type BookingChange = 'created' | 'rescheduled' | 'cancelled';

/** Trabalho para depois do envio: agenda Google e aviso à equipe. */
export type PostJob =
  | { kind: 'calendar_sync'; tenantId: string; appointmentId: string }
  | { kind: 'notify_booking'; tenantId: string; appointmentId: string; change: BookingChange };

export interface SchedulingEnv {
  repo: SchedulingRepo;
  calendar?: ExternalCalendar;
  clock: Clock;
  logger: Logger;
  /** Endereço público do Worker (link "salvar na agenda"). */
  publicBaseUrl: string;
  /** Dá para chamar a equipe (sugestão quando não há horários). */
  handoffAvailable: boolean;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const SEARCH_DAYS = 8;

function appointmentCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TITLE_WORDS = new Set(['dr', 'dra', 'doutor', 'doutora', 'sr', 'sra', 'senhor', 'senhora', 'o', 'a', 'com']);
const ANY_PROFESSIONAL = /^(qualquer|sem preferencia|tanto faz|nenhuma preferencia|qualquer um|qualquer uma)$/;

export function slotRef(serviceId: string, professionalId: string, start: Date): string {
  return `slot|${serviceId}|${professionalId}|${start.toISOString()}`;
}

function parseSlotRef(ref: string): { serviceId: string; professionalId: string; start: Date } | null {
  const [kind, serviceId, professionalId, iso] = ref.split('|');
  if (kind !== 'slot' || !serviceId || !professionalId || !iso || Number.isNaN(Date.parse(iso))) return null;
  return { serviceId, professionalId, start: new Date(iso) };
}

/** "15:00", "15h", "15h30", "15" → minutos desde 00:00. */
export function parseTimeArg(text: string): number | null {
  // Sem espaços antes do regex: nada de retrocesso com texto estranho.
  const m = /^(\d{1,2})(?:[:h](\d{2})?)?h?$/.exec(text.toLowerCase().replace(/\s/g, '').slice(0, 10));
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

const WEEKDAYS_NORM = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const RELATIVE_DAYS = new Map([
  ['hoje', 0],
  ['amanha', 1],
  ['depois de amanha', 2],
  // A IA às vezes manda em inglês.
  ['today', 0],
  ['tomorrow', 1],
]);

/**
 * Dia como o cliente falou → data local da empresa (AAAA-MM-DD). Aceita
 * "AAAA-MM-DD", "hoje", "amanhã", "depois de amanhã", "DD/MM", "dia 15",
 * "quarta", "quarta-feira", "na quarta", "próxima quarta", "quarta que vem".
 * A conta é do servidor: a IA erra dia da semana com facilidade.
 */
export function parseDateArg(text: string, now: Date, timeZone: string): string | null {
  const today = localDateKey(now, timeZone);
  const raw = text.trim();
  if (parseDateKey(raw)) return raw;
  let n = normalize(raw.slice(0, 40)).replace(/^(n[ao]s?|nest[ae]|ness[ae]|est[ae]|ess[ae]) /, '');
  // "próxima quarta" / "quarta que vem": a partir de amanhã.
  const next = n.startsWith('proxim') || n.endsWith(' que vem');
  if (next) n = n.replace(/^proxim[ao] /, '').replace(/ que vem$/, '');
  const offset = RELATIVE_DAYS.get(n);
  if (offset !== undefined) return addDaysToKey(today, offset);
  return dayMonthKey(n, today) ?? dayOfMonthKey(n, today) ?? weekdayKey(n, today, next ? 1 : 0);
}

/** "15 10" ou "15 10 2026" (de "15/10"): no passado sem ano = ano que vem. */
function dayMonthKey(n: string, today: string): string | null {
  const dm = /^(\d{1,2}) (\d{1,2})(?: (\d{4}))?$/.exec(n);
  if (!dm) return null;
  const year = dm[3] ? Number(dm[3]) : Number(today.slice(0, 4));
  let key = `${year}-${dm[2]!.padStart(2, '0')}-${dm[1]!.padStart(2, '0')}`;
  if (!parseDateKey(key)) return null;
  if (!dm[3] && key < today) key = `${year + 1}${key.slice(4)}`;
  return parseDateKey(key) ? key : null;
}

/** "dia 15" / "15": o próximo dia 15 (este mês ou o seguinte). */
function dayOfMonthKey(n: string, today: string): string | null {
  const day = /^(?:dia )?(\d{1,2})$/.exec(n);
  if (!day) return null;
  for (let i = 0; i < 62; i++) {
    const key = addDaysToKey(today, i);
    if (Number(key.slice(8)) === Number(day[1])) return key;
  }
  return null;
}

/** "quarta", "quarta feira": a próxima a partir de hoje (+fromDay). */
function weekdayKey(n: string, today: string, fromDay: number): string | null {
  const wd = WEEKDAYS_NORM.findIndex((w) => n.startsWith(w));
  if (wd < 0) return null;
  for (let i = fromDay; i < fromDay + 7; i++) {
    const key = addDaysToKey(today, i);
    if (weekdayOfKey(key) === wd) return key;
  }
  return null;
}

/** Argumento de texto da IA (número vira texto; objeto e afins, vazio). */
function argText(v: unknown): string {
  if (typeof v === 'string') return v;
  return typeof v === 'number' ? String(v) : '';
}

const DATE_ARG_HELP = 'Dia com as palavras do cliente ("hoje", "amanhã", "quarta", "dia 15", "15/10") ou AAAA-MM-DD. O sistema converte.';
const DATE_ARG_ERROR = 'Não entendi a data. Passe como o cliente disse ("amanhã", "quarta", "15/10") ou AAAA-MM-DD.';

type Found<T> = { ok: T } | { error: string };

export class SchedulingAssistant {
  constructor(
    private readonly ctx: TurnContext,
    private readonly env: SchedulingEnv,
    private readonly logBase: LogFields,
  ) {}

  private get tz(): string {
    return this.ctx.tenant.timezone;
  }

  // ---------------------------------------------------------------- ferramentas

  tools(): Tool[] {
    return [
      {
        def: {
          name: 'check_availability',
          description:
            'Mostra ao cliente os horários livres de um serviço num dia. O sistema envia a lista de horários direto ao cliente.',
          parameters: {
            type: 'object',
            properties: {
              servico: { type: 'string', description: 'Nome do serviço, como está nos dados da empresa.' },
              data: { type: 'string', description: DATE_ARG_HELP },
              profissional: { type: 'string', description: 'Nome do profissional, se o cliente tiver preferência.' },
              hora: { type: 'string', description: 'HH:MM, se o cliente disse um horário de preferência (mostra os mais próximos).' },
              nome_cliente: { type: 'string', description: 'Nome do cliente, se ele acabou de informar ou corrigir.' },
            },
            required: ['servico', 'data'],
          },
        },
        run: (args) => this.checkAvailability(args),
      },
      {
        def: {
          name: 'book',
          description:
            'Marca um horário. Use a "ref" de um horário oferecido ou informe serviço, data e hora. O sistema confere de novo se está livre e confirma ao cliente.',
          parameters: {
            type: 'object',
            properties: {
              ref: { type: 'string', description: 'Referência do horário escolhido (começa com "slot|").' },
              servico: { type: 'string' },
              data: { type: 'string', description: DATE_ARG_HELP },
              hora: { type: 'string', description: 'HH:MM' },
              profissional: { type: 'string' },
              nome_cliente: { type: 'string', description: 'Nome do cliente, se ele informou.' },
            },
          },
        },
        run: (args) => this.book(args),
      },
      {
        def: {
          name: 'save_customer_name',
          description:
            'Guarda o nome que o cliente informou ou corrigiu (usado nas marcações). Use só se não for chamar outra ferramenta com nome_cliente neste momento.',
          parameters: {
            type: 'object',
            properties: { nome: { type: 'string', description: 'Nome como o cliente disse.' } },
            required: ['nome'],
          },
        },
        run: async (args) =>
          (await this.rememberName(args.nome))
            ? { ok: true, content: JSON.stringify({ nome_salvo: true }) }
            : this.error('Nome inválido. Pergunte de novo como o cliente se chama.'),
      },
      {
        def: {
          name: 'list_my_appointments',
          description: 'Mostra ao cliente os horários que ele tem marcados (com o código de cada um).',
          parameters: { type: 'object', properties: {} },
        },
        run: () => this.listMine(),
      },
      {
        def: {
          name: 'reschedule',
          description: 'Remarca um horário do cliente pelo código. Informe o novo horário pela "ref" ou por data e hora.',
          parameters: {
            type: 'object',
            properties: {
              codigo: { type: 'string', description: 'Código do agendamento (ex.: K7Q2XM).' },
              ref: { type: 'string' },
              data: { type: 'string', description: DATE_ARG_HELP },
              hora: { type: 'string', description: 'HH:MM' },
              profissional: { type: 'string' },
            },
            required: ['codigo'],
          },
        },
        run: (args) => this.reschedule(args),
      },
      {
        def: {
          name: 'cancel',
          description: 'Cancela um horário do cliente pelo código. Só use se o cliente pediu para cancelar.',
          parameters: {
            type: 'object',
            properties: { codigo: { type: 'string', description: 'Código do agendamento.' } },
            required: ['codigo'],
          },
        },
        run: (args) => this.cancel(args),
      },
    ];
  }

  /** Toques em lista ou botão. null = a IA cuida (ex.: remarcar). */
  async handleReply(replyId: string): Promise<ToolResult | null> {
    const [kind, code] = replyId.split('|');
    switch (kind) {
      case 'slot':
        // Sem nome do cliente, a IA pergunta antes de marcar.
        return this.customerName(undefined) ? this.book({ ref: replyId }) : null;
      case 'day': {
        const [, serviceId, professionalId, dateKey] = replyId.split('|');
        const service = this.ctx.services.find((s) => s.id === serviceId);
        if (!service || !dateKey) return null;
        const prof = this.ctx.professionals.find((p) => p.id === professionalId) ?? null;
        return this.availabilityReply(service, prof, dateKey);
      }
      case 'cal':
        return this.withAppointment(code, (a) => this.calendarLinkReply(a));
      case 'rem':
        return this.withAppointment(code, (a) => this.reminderOptIn(a));
      case 'skip':
        return this.final({ text: 'Perfeito! Te esperamos. Se precisar de algo, é só chamar.' });
      case 'confirm':
        return this.withAppointment(code, async (a) => {
          await this.env.repo.confirm(a.id, this.ctx.contact.id, this.nowIso());
          return this.final({ text: `✅ Presença confirmada: *${a.serviceName}*, ${this.when(a.startsAt)}. Até lá!` });
        });
      case 'cancel':
        return this.cancel({ codigo: code ?? '' });
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------- ações

  private async checkAvailability(args: Record<string, unknown>): Promise<ToolResult> {
    await this.rememberName(args.nome_cliente);
    const service = this.resolveService(argText(args.servico));
    if ('error' in service) return this.error(service.error);
    const prof = this.resolveProfessional(args.profissional, service.ok);
    if ('error' in prof) return this.error(prof.error);
    const dateKey = parseDateArg(argText(args.data), this.now(), this.tz);
    if (!dateKey) return this.error(DATE_ARG_ERROR);
    const minutes = typeof args.hora === 'string' && args.hora.trim() ? parseTimeArg(args.hora) : null;
    const near = minutes === null ? undefined : zonedTimeToUtc(dateKey, minutes, this.tz);
    return this.availabilityReply(service.ok, prof.ok, dateKey, near);
  }

  private async availabilityReply(
    service: Service,
    prof: Professional | null,
    dateKey: string,
    near?: Date,
  ): Promise<ToolResult> {
    const data = await this.loadBusy(dateKey, SEARCH_DAYS);
    const query = this.query(service, prof, dateKey, data);
    const result = computeSlots(query);
    const options = pickOptions(result.slots, data.rules.maxOptions, near);
    if (options.length) {
      const reply = this.slotsReply(service, prof, dateKey, options);
      // Pediu uma hora que não está livre: diz isso antes das alternativas.
      if (near && !options.some((s) => s.start.getTime() === near.getTime())) {
        reply.text = `Às ${formatMinutes(localMinutes(near, this.tz))} não tenho vaga. ${reply.text}`;
      }
      return this.final(reply, { slots: options.length });
    }

    // Sem horário: sugere os próximos dias com vaga (botões).
    const nextDays: string[] = [];
    for (let i = 1; i < SEARCH_DAYS && nextDays.length < 3; i++) {
      const key = addDaysToKey(dateKey, i);
      if (computeSlots({ ...query, dateKey: key }).slots.length) nextDays.push(key);
    }
    const reasons: Record<string, string> = {
      closed: `Não atendemos ${this.dayPhrase(dateKey)}.`,
      full: `Não tenho mais horários livres para *${service.name}* ${this.dayPhrase(dateKey)}.`,
      past: 'Essa data já passou.',
      too_far: `Por aqui consigo marcar até ${data.rules.maxDaysAhead} dias à frente.`,
    };
    const lead = reasons[result.reason ?? 'full'] ?? reasons.full!;
    if (nextDays.length === 0) {
      const tail = this.env.handoffAvailable
        ? ' Não encontrei horários nos próximos dias. Quer que eu chame a equipe?'
        : ' Não encontrei horários nos próximos dias.';
      return this.final({ text: lead + tail }, { slots: 0 });
    }
    return this.final(
      {
        text: `${lead} Tenho horários nestes dias. Qual prefere?`,
        buttons: nextDays.map((key) => ({
          id: `day|${service.id}|${prof?.id ?? ''}|${key}`,
          title: formatShortDate(zonedTimeToUtc(key, 12 * 60, this.tz), this.tz),
        })),
      },
      { slots: 0 },
    );
  }

  private async book(args: Record<string, unknown>): Promise<ToolResult> {
    const target = this.resolveTarget(args);
    if ('error' in target) return this.error(target.error);
    const { service, prof, dateKey, minutes } = target.ok;
    await this.rememberName(args.nome_cliente);
    const name = this.customerName(undefined);
    if (!name) return this.error('nome_necessario: pergunte o nome do cliente antes de marcar.');

    // Pedido repetido (IA chamou de novo ou toque duplo): mostra o que já está marcado.
    const startIso = zonedTimeToUtc(dateKey, minutes, this.tz).toISOString();
    const mine = await this.env.repo.listUpcoming(this.ctx.contact.id, this.nowIso());
    const same = mine.find(
      (a) => a.serviceId === service.id && a.startsAt === startIso && (!prof || a.professionalId === prof.id),
    );
    if (same) {
      return { ok: true, content: JSON.stringify({ ja_marcado: true, codigo: same.code }), final: this.bookedReply('✅ Já está marcado!', same) };
    }

    const data = await this.loadBusy(dateKey, 1);
    const slot = this.pickSlot(service, prof, dateKey, minutes, data);
    if (!slot) return this.unavailable(service, prof, dateKey, data, minutes);

    const appointment = this.newAppointment(service, slot, name, false, data.calendars);
    if (!(await this.env.repo.insertAppointment(appointment))) return this.unavailable(service, prof, dateKey, data, minutes);
    this.env.logger.info('appointment_booked', { ...this.logBase, appointment_id: appointment.id });
    const view = this.viewOf(appointment.id, appointment.code, service, slot, appointment.calendarToken);
    return {
      ok: true,
      content: JSON.stringify({ marcado: true, codigo: appointment.code }),
      final: this.bookedReply('✅ Agendado!', view),
      action: 'booked',
      effects: this.effects(appointment.id, 'created', appointment.calendarSync === 'pending'),
    };
  }

  private async listMine(): Promise<ToolResult> {
    const list = await this.env.repo.listUpcoming(this.ctx.contact.id, this.nowIso());
    if (list.length === 0) {
      return this.final({ text: 'Você não tem horários marcados no momento. Quer marcar um?' });
    }
    const lines = list.map(
      (a) => `• *${a.serviceName}* com ${a.professionalLabel}, ${this.when(a.startsAt)} (código ${a.code})`,
    );
    const reply: Reply = {
      text: `Seus horários marcados:\n${lines.join('\n')}\n\nQuer remarcar ou cancelar algum?`,
    };
    if (list.length === 1) {
      reply.buttons = [
        { id: `resched|${list[0]!.code}`, title: 'Remarcar' },
        { id: `cancel|${list[0]!.code}`, title: 'Cancelar' },
      ];
    }
    return this.final(reply);
  }

  private async reschedule(args: Record<string, unknown>): Promise<ToolResult> {
    const old = await this.activeAppointment(argText(args.codigo));
    if ('error' in old) return this.error(old.error);
    const target = this.resolveTarget({ ...args, servico: args.servico ?? old.ok.serviceName }, old.ok.professionalId);
    if ('error' in target) return this.error(target.error);
    const { service, prof, dateKey, minutes } = target.ok;

    const data = await this.loadBusy(dateKey, 1);
    // O horário antigo não pode bloquear o novo.
    data.busy = data.busy.filter((b) => !(b.professionalId === old.ok.professionalId && b.start === old.ok.startsAt));
    const slot = this.pickSlot(service, prof, dateKey, minutes, data);
    if (!slot) return this.unavailable(service, prof, dateKey, data, minutes);

    const name = this.customerName(undefined) ?? 'Cliente';
    const appointment = this.newAppointment(service, slot, name, old.ok.reminderOptIn, data.calendars);
    if (!(await this.env.repo.rescheduleAppointment(old.ok.id, appointment))) {
      return this.unavailable(service, prof, dateKey, data, minutes);
    }
    this.env.logger.info('appointment_rescheduled', { ...this.logBase, appointment_id: appointment.id });
    const view = this.viewOf(appointment.id, appointment.code, service, slot, appointment.calendarToken);
    return {
      ok: true,
      content: JSON.stringify({ remarcado: true, codigo: appointment.code }),
      final: this.bookedReply('🔁 Remarcado!', view),
      action: 'rescheduled',
      effects: [
        { kind: 'calendar_sync', tenantId: this.ctx.tenant.id, appointmentId: old.ok.id },
        ...this.effects(appointment.id, 'rescheduled', appointment.calendarSync === 'pending'),
      ],
    };
  }

  private async cancel(args: Record<string, unknown>): Promise<ToolResult> {
    const appt = await this.activeAppointment(argText(args.codigo));
    if ('error' in appt) return this.error(appt.error);
    if (!(await this.env.repo.cancelAppointment(appt.ok.id, this.ctx.contact.id, this.nowIso()))) {
      return this.error('Não foi possível cancelar: o horário já não está ativo.');
    }
    this.env.logger.info('appointment_cancelled', { ...this.logBase, appointment_id: appt.ok.id });
    return {
      ok: true,
      content: JSON.stringify({ cancelado: true }),
      final: {
        text: `Cancelado: *${appt.ok.serviceName}* com ${appt.ok.professionalLabel}, ${this.when(appt.ok.startsAt)}. Se quiser marcar outro horário, é só falar.`,
      },
      action: 'cancelled',
      effects: [
        { kind: 'calendar_sync', tenantId: this.ctx.tenant.id, appointmentId: appt.ok.id },
        { kind: 'notify_booking', tenantId: this.ctx.tenant.id, appointmentId: appt.ok.id, change: 'cancelled' },
      ],
    };
  }

  private async reminderOptIn(a: AppointmentView): Promise<ToolResult> {
    if (!this.ctx.tenant.remindersEnabled) {
      return this.final({
        text: 'Os lembretes por aqui ainda não estão disponíveis. Você pode salvar o horário na agenda do celular, que ela te avisa.',
        buttons: [{ id: `cal|${a.code}`, title: '📅 Salvar na agenda' }],
      });
    }
    if (Date.parse(a.startsAt) - this.now().getTime() < REMINDER_WINDOW.toMs + REMINDER_MIN_AGE_MS) {
      return this.final({ text: `Seu horário já está pertinho (${this.when(a.startsAt)}), então não precisa de lembrete. Te esperamos!` });
    }
    await this.env.repo.setReminderOptIn(a.id, this.ctx.contact.id, this.nowIso());
    return this.final({ text: '🔔 Combinado! Um dia antes eu te mando um lembrete por aqui.' });
  }

  private calendarLinkReply(a: AppointmentView): ToolResult {
    let base = this.env.publicBaseUrl;
    while (base.endsWith('/')) base = base.slice(0, -1);
    const url = `${base}/a/${a.calendarToken}`;
    return this.final({
      text: `📅 Toque no link para salvar na agenda do seu celular:\n${url}\n\nNo Android abre o Google Agenda; no iPhone, o Calendário. A agenda te avisa antes do horário.`,
    });
  }

  // ----------------------------------------------------------------- apoio

  private now(): Date {
    return this.env.clock.now();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private when(iso: string): string {
    return formatAppointmentTime(new Date(iso), this.tz);
  }

  private dayPhrase(dateKey: string): string {
    const today = localDateKey(this.now(), this.tz);
    const [, mm, dd] = dateKey.split('-');
    if (dateKey === today) return `hoje (${dd}/${mm})`;
    if (dateKey === addDaysToKey(today, 1)) return `amanhã (${dd}/${mm})`;
    return `na ${weekdayName(weekdayOfKey(dateKey))}, ${dd}/${mm}`;
  }

  private final(reply: Reply, extra: Record<string, unknown> = {}): ToolResult {
    return { ok: true, content: JSON.stringify({ mostrado_ao_cliente: true, ...extra }), final: reply };
  }

  private error(message: string): ToolResult {
    return { ok: false, content: JSON.stringify({ erro: message }) };
  }

  /**
   * Nome informado pelo cliente: grava no contato na hora (o toque na lista
   * marca sem IA e usa este nome). Devolve o nome limpo, ou null.
   */
  private async rememberName(raw: unknown): Promise<string | null> {
    const clean = typeof raw === 'string' ? sanitizeName(raw) : null;
    if (!clean) return null;
    if (clean !== this.ctx.contact.displayName) {
      await this.env.repo.setContactName(this.ctx.contact.id, clean);
      this.ctx.contact.displayName = clean;
    }
    return clean;
  }

  private customerName(raw: unknown): string | null {
    if (typeof raw === 'string') {
      const clean = sanitizeName(raw);
      if (clean) return clean;
    }
    return this.ctx.contact.displayName ?? sanitizeName(this.ctx.contact.profileName);
  }

  private resolveService(name: string): Found<Service> {
    const n = normalize(name);
    const all = this.ctx.services;
    const names = all.map((s) => s.name).join(', ');
    if (!n) return { error: `Qual serviço? Opções: ${names}.` };
    const exact = all.filter((s) => normalize(s.name) === n);
    if (exact.length === 1) return { ok: exact[0]! };
    const partial = all.filter((s) => normalize(s.name).includes(n) || n.includes(normalize(s.name)));
    if (partial.length === 1) return { ok: partial[0]! };
    if (partial.length > 1) return { error: `Serviço ambíguo. Pergunte qual destes: ${partial.map((s) => s.name).join(', ')}.` };
    return { error: `Serviço não encontrado. Os serviços são: ${names}.` };
  }

  private eligible(service: Service): Professional[] {
    const ids = new Set(service.professionalIds);
    return ids.size ? this.ctx.professionals.filter((p) => ids.has(p.id)) : this.ctx.professionals;
  }

  private resolveProfessional(raw: unknown, service: Service): Found<Professional | null> {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: null };
    const titles = new Set(this.ctx.professionals.flatMap((p) => normalize(p.title ?? '').split(' ')));
    const n = normalize(raw)
      .split(' ')
      .filter((w) => !TITLE_WORDS.has(w) && !titles.has(w))
      .join(' ');
    if (!n || ANY_PROFESSIONAL.test(normalize(raw))) return { ok: null };
    const eligible = this.eligible(service);
    const match = (p: Professional) => {
      const name = normalize(p.name);
      return name === n || name.startsWith(n) || name.split(' ')[0] === n.split(' ')[0];
    };
    const found = eligible.filter(match);
    if (found.length === 1) return { ok: found[0]! };
    const other = this.ctx.professionals.find(match);
    const who = eligible.map((p) => professionalLabel(p)).join(', ');
    if (other) return { error: `${professionalLabel(other)} não faz ${service.name}. Quem faz: ${who}.` };
    return { error: `Profissional não encontrado. Quem faz ${service.name}: ${who}.` };
  }

  /** Destino de book/reschedule: pela ref ou por serviço + data + hora. */
  private resolveTarget(
    args: Record<string, unknown>,
    keepProfessionalId?: string,
  ): Found<{ service: Service; prof: Professional | null; dateKey: string; minutes: number }> {
    if (typeof args.ref === 'string' && args.ref) {
      const ref = parseSlotRef(args.ref);
      const service = ref && this.ctx.services.find((s) => s.id === ref.serviceId);
      const prof = ref && this.ctx.professionals.find((p) => p.id === ref.professionalId);
      if (!ref || !service || !prof) return { error: 'Referência de horário inválida. Ofereça os horários de novo.' };
      return {
        ok: { service, prof, dateKey: localDateKey(ref.start, this.tz), minutes: localMinutes(ref.start, this.tz) },
      };
    }
    const service = this.resolveService(argText(args.servico));
    if ('error' in service) return service;
    const kept = keepProfessionalId && !args.profissional ? this.ctx.professionals.find((p) => p.id === keepProfessionalId) : undefined;
    const prof: Found<Professional | null> =
      kept && this.eligible(service.ok).includes(kept) ? { ok: kept } : this.resolveProfessional(args.profissional, service.ok);
    if ('error' in prof) return prof;
    const dateKey = parseDateArg(argText(args.data), this.now(), this.tz);
    if (!dateKey) return { error: DATE_ARG_ERROR };
    const minutes = parseTimeArg(argText(args.hora));
    if (minutes === null) return { error: 'Hora inválida. Use HH:MM.' };
    return { ok: { service: service.ok, prof: prof.ok, dateKey, minutes } };
  }

  private async activeAppointment(code: string): Promise<Found<AppointmentView>> {
    const appt = code ? await this.env.repo.findByCode(this.ctx.contact.id, code.trim()) : null;
    if (!appt) return { error: 'Código não encontrado. Use list_my_appointments para ver os códigos do cliente.' };
    if (appt.status !== 'booked' && appt.status !== 'confirmed') return { error: 'Esse agendamento já foi cancelado ou concluído.' };
    if (Date.parse(appt.startsAt) < this.now().getTime()) return { error: 'Esse horário já passou.' };
    return { ok: appt };
  }

  private async withAppointment(code: string | undefined, fn: (a: AppointmentView) => Promise<ToolResult> | ToolResult) {
    const appt = code ? await this.env.repo.findByCode(this.ctx.contact.id, code) : null;
    if (!appt) return this.final({ text: 'Não encontrei esse agendamento. Quer ver seus horários marcados?' });
    if (appt.status === 'cancelled') return this.final({ text: 'Esse horário foi cancelado. Quer marcar outro?' });
    return fn(appt);
  }

  /** Agendamentos, folgas e ocupados da agenda Google no período. */
  private async loadBusy(dateKey: string, days: number) {
    const from = zonedTimeToUtc(dateKey, 0, this.tz).toISOString();
    const to = zonedTimeToUtc(addDaysToKey(dateKey, days), 0, this.tz).toISOString();
    const snap = await this.env.repo.loadSnapshot(from, to);
    const busy: BusyInterval[] = [...snap.busy];
    const calendar = this.env.calendar;
    if (calendar) {
      const targets: Array<{ id: string; professionalId: string | null }> = [];
      if (snap.calendars.tenant) targets.push({ id: snap.calendars.tenant, professionalId: null });
      for (const [professionalId, id] of Object.entries(snap.calendars.byProfessional)) {
        if (id !== snap.calendars.tenant) targets.push({ id, professionalId });
      }
      const results = await Promise.all(
        targets.map(async (t) => {
          try {
            return (await calendar.busy(t.id, from, to)).map((b) => this.toBusy(b, t.professionalId));
          } catch (err) {
            // Falha no Google não trava a agenda: segue com os dados do sistema.
            this.env.logger.warn('calendar_busy_failed', {
              ...this.logBase,
              error_code: err instanceof Error ? err.name : 'unknown',
            });
            return [];
          }
        }),
      );
      for (const list of results) busy.push(...list);
    }
    return { rules: snap.rules, busy, calendars: snap.calendars };
  }

  private toBusy(b: ExternalBusy, professionalId: string | null): BusyInterval {
    if ('allDayStart' in b) {
      return {
        professionalId,
        start: zonedTimeToUtc(b.allDayStart, 0, this.tz).toISOString(),
        end: zonedTimeToUtc(b.allDayEnd, 0, this.tz).toISOString(),
      };
    }
    return { professionalId, start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString() };
  }

  private query(
    service: Service,
    prof: Professional | null,
    dateKey: string,
    data: { rules: AvailabilityQuery['rules']; busy: BusyInterval[] },
  ): AvailabilityQuery {
    return {
      dateKey,
      timezone: this.tz,
      durationMin: service.durationMin,
      bufferMin: service.bufferMin,
      professionals: prof ? [prof] : this.eligible(service),
      hours: this.ctx.hours,
      busy: data.busy,
      rules: data.rules,
      now: this.now(),
    };
  }

  /** O horário pedido (com ou sem profissional) está livre? */
  private pickSlot(
    service: Service,
    prof: Professional | null,
    dateKey: string,
    minutes: number,
    data: { rules: AvailabilityQuery['rules']; busy: BusyInterval[] },
  ): Slot | null {
    const start = zonedTimeToUtc(dateKey, minutes, this.tz);
    const query = this.query(service, prof, dateKey, data);
    for (const p of query.professionals) {
      const slot = findSlot(query, p.id, start);
      if (slot) return slot;
    }
    return null;
  }

  private unavailable(
    service: Service,
    prof: Professional | null,
    dateKey: string,
    data: { rules: AvailabilityQuery['rules']; busy: BusyInterval[] },
    minutes: number,
  ): ToolResult {
    const near = zonedTimeToUtc(dateKey, minutes, this.tz);
    const options = pickOptions(computeSlots(this.query(service, prof, dateKey, data)).slots, data.rules.maxOptions, near);
    if (!options.length) {
      return this.final({ text: `Esse horário não está disponível e não tenho outros ${this.dayPhrase(dateKey)}. Quer tentar outro dia?` });
    }
    const reply = this.slotsReply(service, prof, dateKey, options);
    reply.text = `Esse horário não está disponível. ${reply.text}`;
    return this.final(reply, { indisponivel: true });
  }

  private slotsReply(service: Service, prof: Professional | null, dateKey: string, slots: Slot[]): Reply {
    const byId = new Map(this.ctx.professionals.map((p) => [p.id, p]));
    const who = prof ? ` com ${professionalLabel(prof)}` : '';
    // Preço junto: quem pergunta horário quase sempre quer saber o valor.
    const price = service.priceMode !== 'on_request' && service.priceCents !== null ? ` (${formatServicePrice(service)})` : '';
    return {
      text: `Horários livres para *${service.name}*${price}${who} ${this.dayPhrase(dateKey)}. Toque em "Ver horários" para escolher.`,
      listButton: 'Ver horários',
      options: slots.map((s) => ({
        id: slotRef(service.id, s.professionalId, s.start),
        title: `${formatShortDate(s.start, this.tz)} · ${formatMinutes(localMinutes(s.start, this.tz))}`,
        description: `com ${professionalLabel(byId.get(s.professionalId)!)}`,
      })),
    };
  }

  private newAppointment(
    service: Service,
    slot: Slot,
    name: string,
    reminderOptIn: boolean,
    calendars: { tenant: string | null; byProfessional: Record<string, string> },
  ) {
    const now = this.now();
    const hasCalendar = Boolean(this.env.calendar && (calendars.byProfessional[slot.professionalId] ?? calendars.tenant));
    return {
      id: ulid(now.getTime()),
      code: appointmentCode(),
      contactId: this.ctx.contact.id,
      conversationId: this.ctx.conversation.id,
      professionalId: slot.professionalId,
      serviceId: service.id,
      startsAt: slot.start.toISOString(),
      endsAt: slot.end.toISOString(),
      blockEndsAt: slot.blockEnd.toISOString(),
      priceMode: service.priceMode,
      priceCents: service.priceCents,
      customerName: name,
      reminderOptIn,
      calendarToken: randomToken(22),
      calendarSync: hasCalendar ? ('pending' as const) : ('none' as const),
      now: now.toISOString(),
    };
  }

  private viewOf(id: string, code: string, service: Service, slot: Slot, token: string): AppointmentView {
    const prof = this.ctx.professionals.find((p) => p.id === slot.professionalId)!;
    return {
      id,
      code,
      status: 'booked',
      startsAt: slot.start.toISOString(),
      endsAt: slot.end.toISOString(),
      serviceId: service.id,
      serviceName: service.name,
      professionalId: prof.id,
      professionalLabel: professionalLabel(prof),
      priceMode: service.priceMode,
      priceCents: service.priceCents,
      calendarToken: token,
      reminderOptIn: false,
    };
  }

  /** Confirmação com resumo + botões "salvar na agenda" / "lembrete". */
  private bookedReply(title: string, a: AppointmentView): Reply {
    const lines = [
      title,
      `*${a.serviceName}* com ${a.professionalLabel}`,
      `📅 ${this.when(a.startsAt)}`,
      `💰 ${formatServicePrice({ priceMode: a.priceMode, priceCents: a.priceCents })}`,
    ];
    if (this.ctx.tenant.address) lines.push(`📍 ${this.ctx.tenant.address}`);
    lines.push(`Código: ${a.code}`, '', 'Quer salvar na agenda do seu celular?');
    const buttons: ReplyButton[] = [{ id: `cal|${a.code}`, title: '📅 Salvar na agenda' }];
    if (this.ctx.tenant.remindersEnabled) buttons.push({ id: `rem|${a.code}`, title: '🔔 Lembrete aqui' });
    buttons.push({ id: `skip|${a.code}`, title: 'Não precisa' });
    return { text: lines.join('\n'), buttons };
  }

  private effects(appointmentId: string, change: 'created' | 'rescheduled', calendar: boolean): PostJob[] {
    const tenantId = this.ctx.tenant.id;
    return [
      ...(calendar ? [{ kind: 'calendar_sync' as const, tenantId, appointmentId }] : []),
      { kind: 'notify_booking' as const, tenantId, appointmentId, change },
    ];
  }
}
