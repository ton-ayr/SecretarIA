import type { PriceMode } from './domain.ts';

export interface SchedulingRules {
  slotStepMin: number;
  minAdvanceMin: number;
  maxDaysAhead: number;
  maxOptions: number;
}

/** Intervalo ocupado. professionalId null = vale para todos (empresa). */
export interface BusyInterval {
  professionalId: string | null;
  start: string;
  end: string;
}

/** Agendamento como o motor e as ferramentas enxergam. */
export interface AppointmentView {
  id: string;
  code: string;
  status: 'booked' | 'confirmed' | 'cancelled' | 'done' | 'no_show';
  startsAt: string;
  endsAt: string;
  serviceId: string;
  serviceName: string;
  professionalId: string;
  professionalLabel: string;
  priceMode: PriceMode;
  priceCents: number | null;
  calendarToken: string;
  reminderOptIn: boolean;
}

export interface SchedulingSnapshot {
  rules: SchedulingRules;
  /** Agendamentos ativos e folgas no período. */
  busy: BusyInterval[];
  /** Agendas Google: da empresa e por profissional. */
  calendars: { tenant: string | null; byProfessional: Record<string, string> };
}

export interface NewAppointment {
  id: string;
  code: string;
  contactId: string;
  conversationId: string;
  professionalId: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  blockEndsAt: string;
  priceMode: PriceMode;
  priceCents: number | null;
  customerName: string | null;
  reminderOptIn: boolean;
  calendarToken: string;
  /** 'pending' quando há agenda Google para sincronizar. */
  calendarSync: 'none' | 'pending';
  now: string;
}

/** Dados completos para o evento na agenda Google e o aviso à equipe. */
export interface AppointmentDetails extends AppointmentView {
  tenantId: string;
  conversationId: string | null;
  tenantName: string;
  address: string | null;
  timezone: string;
  customerName: string | null;
  waId: string;
  calendarId: string | null;
}

/** Agenda de UMA empresa: toda consulta filtra por tenant_id. */
export interface SchedulingRepo {
  loadSnapshot(fromIso: string, toIso: string): Promise<SchedulingSnapshot>;
  /** Marca se o horário continua livre (instrução condicional). */
  insertAppointment(a: NewAppointment): Promise<boolean>;
  /** Marca o novo e cancela o antigo numa transação; false se o novo estava ocupado. */
  rescheduleAppointment(oldId: string, a: NewAppointment): Promise<boolean>;
  cancelAppointment(id: string, contactId: string, now: string): Promise<boolean>;
  listUpcoming(contactId: string, nowIso: string): Promise<AppointmentView[]>;
  findByCode(contactId: string, code: string): Promise<AppointmentView | null>;
  getDetails(appointmentId: string): Promise<AppointmentDetails | null>;
  setReminderOptIn(id: string, contactId: string, now: string): Promise<boolean>;
  confirm(id: string, contactId: string, now: string): Promise<boolean>;
  setCalendarSync(id: string, status: 'synced' | 'failed' | 'none', now: string): Promise<void>;
  setContactName(contactId: string, name: string): Promise<void>;
}

/** Lembrete devido (consulta do cron, passa por todas as empresas). */
export interface DueReminder {
  appointmentId: string;
  tenantId: string;
  code: string;
  startsAt: string;
  timezone: string;
  tenantName: string;
  serviceName: string;
  professionalLabel: string;
  customerName: string;
  waId: string;
  metaPhoneNumberId: string;
  phoneNumberId: string;
  conversationId: string;
  lastCustomerMsgAt: string | null;
}

export interface SchedulingOps {
  /** Começam em [from, to) e foram marcados até createdBefore. */
  dueReminders(fromIso: string, toIso: string, createdBeforeIso: string, limit: number): Promise<DueReminder[]>;
  /** Reserva o envio do lembrete; false se outro processo já reservou. */
  claimReminder(appointmentId: string, now: string): Promise<boolean>;
  releaseReminder(appointmentId: string): Promise<void>;
  /** Sincronizações pendentes ou falhas, paradas desde antes de idleSince. */
  pendingCalendarSync(limit: number, idleSinceIso: string): Promise<Array<{ appointmentId: string; tenantId: string }>>;
  /** Link "salvar na agenda" do cliente (ponto de entrada sem empresa). */
  findByCalendarToken(token: string): Promise<CalendarLinkView | null>;
}

export interface CalendarLinkView {
  status: AppointmentView['status'];
  startsAt: string;
  endsAt: string;
  serviceName: string;
  professionalLabel: string;
  tenantName: string;
  address: string | null;
  timezone: string;
}
