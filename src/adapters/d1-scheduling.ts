import { DEFAULT_RULES } from '../core/availability.ts';
import type { PriceMode } from '../ports/domain.ts';
import type {
  AppointmentDetails,
  AppointmentView,
  CalendarLinkView,
  DueReminder,
  NewAppointment,
  SchedulingOps,
  SchedulingRepo,
  SchedulingSnapshot,
} from '../ports/scheduling.ts';

/**
 * Agenda no D1. SCHEDULING_SQL é por empresa (?1 = tenant_id; a guarda de
 * SQL confere). SCHEDULING_OPS_SQL passa por todas as empresas de propósito
 * (cron de lembretes e de sincronização) e o link do cliente entra por um
 * token aleatório.
 */

const ACTIVE = `('booked', 'confirmed')`;
const VIEW_COLUMNS = `a.id, a.code, a.status, a.starts_at, a.ends_at, a.service_id, a.professional_id,
  a.price_mode, a.price_cents, a.calendar_token, a.reminder_opt_in,
  s.name AS service_name, p.name AS prof_name, p.title AS prof_title`;

export const SCHEDULING_SQL = {
  rules: `SELECT slot_step_min, min_advance_min, max_days_ahead, max_options FROM scheduling_rules WHERE tenant_id = ?1`,
  busyAppointments: `SELECT professional_id, starts_at, block_ends_at FROM appointments
    WHERE tenant_id = ?1 AND status IN ${ACTIVE} AND starts_at < ?3 AND block_ends_at > ?2`,
  busyTimeOff: `SELECT professional_id, starts_at, ends_at FROM time_off
    WHERE tenant_id = ?1 AND starts_at < ?3 AND ends_at > ?2`,
  tenantCalendar: `SELECT google_calendar_id FROM tenants WHERE id = ?1`,
  professionalCalendars: `SELECT id, google_calendar_id FROM professionals
    WHERE tenant_id = ?1 AND google_calendar_id IS NOT NULL`,
  // Marca só se não houver agendamento ativo nem folga no intervalo (corrida
  // entre dois clientes: só um consegue). ?17 = agendamento a ignorar (remarcação).
  insertIfFree: `INSERT INTO appointments
    (id, tenant_id, code, contact_id, conversation_id, professional_id, service_id, starts_at, ends_at,
     block_ends_at, status, price_mode, price_cents, customer_name, reminder_opt_in, calendar_token,
     calendar_sync, created_by, created_at, updated_at)
    SELECT ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'booked', ?11, ?12, ?13, ?18, ?14, ?15, 'bot', ?16, ?16
    WHERE NOT EXISTS (
        SELECT 1 FROM appointments a WHERE a.tenant_id = ?1 AND a.professional_id = ?6
          AND a.status IN ${ACTIVE} AND a.id <> ?17 AND a.starts_at < ?10 AND a.block_ends_at > ?8)
      AND NOT EXISTS (
        SELECT 1 FROM time_off t WHERE t.tenant_id = ?1 AND (t.professional_id IS NULL OR t.professional_id = ?6)
          AND t.starts_at < ?10 AND t.ends_at > ?8)`,
  // Remarcação: cancela o antigo só se o novo entrou (mesma transação).
  cancelIfReplaced: `UPDATE appointments SET status = 'cancelled', updated_at = ?3,
      calendar_sync = CASE WHEN calendar_sync = 'none' THEN 'none' ELSE 'pending' END
    WHERE tenant_id = ?1 AND id = ?2 AND status IN ${ACTIVE}
      AND EXISTS (SELECT 1 FROM appointments n WHERE n.tenant_id = ?1 AND n.id = ?4)`,
  cancel: `UPDATE appointments SET status = 'cancelled', updated_at = ?4,
      calendar_sync = CASE WHEN calendar_sync = 'none' THEN 'none' ELSE 'pending' END
    WHERE tenant_id = ?1 AND id = ?2 AND contact_id = ?3 AND status IN ${ACTIVE}`,
  listUpcoming: `SELECT ${VIEW_COLUMNS} FROM appointments a
    JOIN services s ON s.id = a.service_id AND s.tenant_id = ?1
    JOIN professionals p ON p.id = a.professional_id AND p.tenant_id = ?1
    WHERE a.tenant_id = ?1 AND a.contact_id = ?2 AND a.status IN ${ACTIVE} AND a.starts_at > ?3
    ORDER BY a.starts_at LIMIT 10`,
  findByCode: `SELECT ${VIEW_COLUMNS} FROM appointments a
    JOIN services s ON s.id = a.service_id AND s.tenant_id = ?1
    JOIN professionals p ON p.id = a.professional_id AND p.tenant_id = ?1
    WHERE a.tenant_id = ?1 AND a.contact_id = ?2 AND a.code = ?3`,
  details: `SELECT ${VIEW_COLUMNS}, a.customer_name, a.conversation_id, c.wa_id, c.display_name, c.profile_name,
      t.name AS tenant_name, t.address, t.timezone,
      COALESCE(p.google_calendar_id, t.google_calendar_id) AS calendar_id
    FROM appointments a
    JOIN services s ON s.id = a.service_id AND s.tenant_id = ?1
    JOIN professionals p ON p.id = a.professional_id AND p.tenant_id = ?1
    JOIN contacts c ON c.id = a.contact_id AND c.tenant_id = ?1
    JOIN tenants t ON t.id = ?1
    WHERE a.tenant_id = ?1 AND a.id = ?2`,
  optIn: `UPDATE appointments SET reminder_opt_in = 1, updated_at = ?4
    WHERE tenant_id = ?1 AND id = ?2 AND contact_id = ?3 AND status IN ${ACTIVE}`,
  confirm: `UPDATE appointments SET status = 'confirmed', updated_at = ?4
    WHERE tenant_id = ?1 AND id = ?2 AND contact_id = ?3 AND status IN ${ACTIVE}`,
  setSync: `UPDATE appointments SET calendar_sync = ?3,
      calendar_sync_attempts = calendar_sync_attempts + ?4, updated_at = ?5
    WHERE tenant_id = ?1 AND id = ?2`,
  setContactName: `UPDATE contacts SET display_name = ?3 WHERE tenant_id = ?1 AND id = ?2`,
} as const;

export const SCHEDULING_OPS_SQL = {
  dueReminders: `SELECT a.id, a.tenant_id, a.code, a.starts_at, a.customer_name,
      s.name AS service_name, p.name AS prof_name, p.title AS prof_title,
      c.wa_id, c.display_name, c.profile_name, cv.id AS conversation_id, cv.last_customer_msg_at,
      ph.id AS phone_id, ph.meta_phone_number_id, t.name AS tenant_name, t.timezone
    FROM appointments a
    JOIN tenants t ON t.id = a.tenant_id AND t.status = 'active' AND t.reminders_enabled = 1
    JOIN services s ON s.id = a.service_id AND s.tenant_id = a.tenant_id
    JOIN professionals p ON p.id = a.professional_id AND p.tenant_id = a.tenant_id
    JOIN contacts c ON c.id = a.contact_id AND c.tenant_id = a.tenant_id
    JOIN conversations cv ON cv.id = a.conversation_id AND cv.tenant_id = a.tenant_id
    JOIN phone_numbers ph ON ph.id = cv.phone_number_id AND ph.tenant_id = a.tenant_id AND ph.status = 'active'
      AND ph.kind = 'whatsapp'
    WHERE a.reminder_opt_in = 1 AND a.reminder_sent_at IS NULL AND a.status IN ${ACTIVE}
      AND a.starts_at >= ?1 AND a.starts_at < ?2 AND a.created_at <= ?3
    ORDER BY a.starts_at LIMIT ?4`,
  claimReminder: `UPDATE appointments SET reminder_sent_at = ?2 WHERE id = ?1 AND reminder_sent_at IS NULL`,
  releaseReminder: `UPDATE appointments SET reminder_sent_at = NULL WHERE id = ?1`,
  pendingSync: `SELECT a.id, a.tenant_id FROM appointments a JOIN tenants t ON t.id = a.tenant_id
    WHERE a.calendar_sync IN ('pending', 'failed') AND a.calendar_sync_attempts < 5 AND a.updated_at < ?2
    ORDER BY a.updated_at LIMIT ?1`,
  byCalendarToken: `SELECT a.status, a.starts_at, a.ends_at, s.name AS service_name, p.name AS prof_name,
      p.title AS prof_title, t.name AS tenant_name, t.address, t.timezone
    FROM appointments a
    JOIN tenants t ON t.id = a.tenant_id
    JOIN services s ON s.id = a.service_id AND s.tenant_id = a.tenant_id
    JOIN professionals p ON p.id = a.professional_id AND p.tenant_id = a.tenant_id
    WHERE a.calendar_token = ?1`,
} as const;

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);

function label(r: Row): string {
  const title = strOrNull(r.prof_title);
  return title ? `${title} ${str(r.prof_name)}` : str(r.prof_name);
}

function mapView(r: Row): AppointmentView {
  return {
    id: str(r.id),
    code: str(r.code),
    status: str(r.status) as AppointmentView['status'],
    startsAt: str(r.starts_at),
    endsAt: str(r.ends_at),
    serviceId: str(r.service_id),
    serviceName: str(r.service_name),
    professionalId: str(r.professional_id),
    professionalLabel: label(r),
    priceMode: str(r.price_mode) as PriceMode,
    priceCents: r.price_cents === null || r.price_cents === undefined ? null : num(r.price_cents),
    calendarToken: str(r.calendar_token),
    reminderOptIn: num(r.reminder_opt_in) === 1,
  };
}

export class D1SchedulingRepo implements SchedulingRepo {
  constructor(
    private readonly db: D1Database,
    private readonly tenantId: string,
  ) {}

  private stmt(sql: string, ...params: unknown[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(this.tenantId, ...params);
  }

  async loadSnapshot(fromIso: string, toIso: string): Promise<SchedulingSnapshot> {
    const S = SCHEDULING_SQL;
    const res = await this.db.batch<Row>([
      this.stmt(S.rules),
      this.stmt(S.busyAppointments, fromIso, toIso),
      this.stmt(S.busyTimeOff, fromIso, toIso),
      this.stmt(S.tenantCalendar),
      this.stmt(S.professionalCalendars),
    ]);
    const rows = (i: number): Row[] => res[i]?.results ?? [];
    const r = rows(0)[0];
    const byProfessional: Record<string, string> = {};
    for (const p of rows(4)) byProfessional[str(p.id)] = str(p.google_calendar_id);
    return {
      rules: r
        ? {
            slotStepMin: num(r.slot_step_min),
            minAdvanceMin: num(r.min_advance_min),
            maxDaysAhead: num(r.max_days_ahead),
            maxOptions: num(r.max_options),
          }
        : DEFAULT_RULES,
      busy: [
        ...rows(1).map((b) => ({ professionalId: strOrNull(b.professional_id), start: str(b.starts_at), end: str(b.block_ends_at) })),
        ...rows(2).map((b) => ({ professionalId: strOrNull(b.professional_id), start: str(b.starts_at), end: str(b.ends_at) })),
      ],
      calendars: { tenant: strOrNull(rows(3)[0]?.google_calendar_id), byProfessional },
    };
  }

  private insertStmt(a: NewAppointment, excludeId: string): D1PreparedStatement {
    return this.stmt(
      SCHEDULING_SQL.insertIfFree,
      a.id,
      a.code,
      a.contactId,
      a.conversationId,
      a.professionalId,
      a.serviceId,
      a.startsAt,
      a.endsAt,
      a.blockEndsAt,
      a.priceMode,
      a.priceCents,
      a.customerName,
      a.calendarToken,
      a.calendarSync,
      a.now,
      excludeId,
      a.reminderOptIn ? 1 : 0,
    );
  }

  async insertAppointment(a: NewAppointment): Promise<boolean> {
    const res = await this.insertStmt(a, '').run();
    return res.meta.changes === 1;
  }

  async rescheduleAppointment(oldId: string, a: NewAppointment): Promise<boolean> {
    const res = await this.db.batch([
      this.insertStmt(a, oldId),
      this.stmt(SCHEDULING_SQL.cancelIfReplaced, oldId, a.now, a.id),
    ]);
    return res[0]?.meta.changes === 1;
  }

  async cancelAppointment(id: string, contactId: string, now: string): Promise<boolean> {
    return (await this.stmt(SCHEDULING_SQL.cancel, id, contactId, now).run()).meta.changes === 1;
  }

  async listUpcoming(contactId: string, nowIso: string): Promise<AppointmentView[]> {
    return (await this.stmt(SCHEDULING_SQL.listUpcoming, contactId, nowIso).all<Row>()).results.map(mapView);
  }

  async findByCode(contactId: string, code: string): Promise<AppointmentView | null> {
    const row = await this.stmt(SCHEDULING_SQL.findByCode, contactId, code.toUpperCase()).first<Row>();
    return row ? mapView(row) : null;
  }

  async getDetails(appointmentId: string): Promise<AppointmentDetails | null> {
    const r = await this.stmt(SCHEDULING_SQL.details, appointmentId).first<Row>();
    if (!r) return null;
    return {
      ...mapView(r),
      tenantId: this.tenantId,
      conversationId: strOrNull(r.conversation_id),
      tenantName: str(r.tenant_name),
      address: strOrNull(r.address),
      timezone: str(r.timezone),
      customerName: strOrNull(r.customer_name) ?? strOrNull(r.display_name) ?? strOrNull(r.profile_name),
      waId: str(r.wa_id),
      calendarId: strOrNull(r.calendar_id),
    };
  }

  async setReminderOptIn(id: string, contactId: string, now: string): Promise<boolean> {
    return (await this.stmt(SCHEDULING_SQL.optIn, id, contactId, now).run()).meta.changes === 1;
  }

  async confirm(id: string, contactId: string, now: string): Promise<boolean> {
    return (await this.stmt(SCHEDULING_SQL.confirm, id, contactId, now).run()).meta.changes === 1;
  }

  async setCalendarSync(id: string, status: 'synced' | 'failed' | 'none', now: string): Promise<void> {
    await this.stmt(SCHEDULING_SQL.setSync, id, status, status === 'failed' ? 1 : 0, now).run();
  }

  async setContactName(contactId: string, name: string): Promise<void> {
    await this.stmt(SCHEDULING_SQL.setContactName, contactId, name).run();
  }
}

export class D1SchedulingOps implements SchedulingOps {
  constructor(private readonly db: D1Database) {}

  async dueReminders(fromIso: string, toIso: string, createdBeforeIso: string, limit: number): Promise<DueReminder[]> {
    const res = await this.db
      .prepare(SCHEDULING_OPS_SQL.dueReminders)
      .bind(fromIso, toIso, createdBeforeIso, limit)
      .all<Row>();
    return res.results.map((r) => ({
      appointmentId: str(r.id),
      tenantId: str(r.tenant_id),
      code: str(r.code),
      startsAt: str(r.starts_at),
      timezone: str(r.timezone),
      tenantName: str(r.tenant_name),
      serviceName: str(r.service_name),
      professionalLabel: label(r),
      customerName: strOrNull(r.customer_name) ?? strOrNull(r.display_name) ?? strOrNull(r.profile_name) ?? 'cliente',
      waId: str(r.wa_id),
      metaPhoneNumberId: str(r.meta_phone_number_id),
      phoneNumberId: str(r.phone_id),
      conversationId: str(r.conversation_id),
      lastCustomerMsgAt: strOrNull(r.last_customer_msg_at),
    }));
  }

  async claimReminder(appointmentId: string, now: string): Promise<boolean> {
    return (await this.db.prepare(SCHEDULING_OPS_SQL.claimReminder).bind(appointmentId, now).run()).meta.changes === 1;
  }

  async releaseReminder(appointmentId: string): Promise<void> {
    await this.db.prepare(SCHEDULING_OPS_SQL.releaseReminder).bind(appointmentId).run();
  }

  async pendingCalendarSync(limit: number, idleSinceIso: string): Promise<Array<{ appointmentId: string; tenantId: string }>> {
    const res = await this.db.prepare(SCHEDULING_OPS_SQL.pendingSync).bind(limit, idleSinceIso).all<Row>();
    return res.results.map((r) => ({ appointmentId: str(r.id), tenantId: str(r.tenant_id) }));
  }

  async findByCalendarToken(token: string): Promise<CalendarLinkView | null> {
    const r = await this.db.prepare(SCHEDULING_OPS_SQL.byCalendarToken).bind(token).first<Row>();
    if (!r) return null;
    return {
      status: str(r.status) as CalendarLinkView['status'],
      startsAt: str(r.starts_at),
      endsAt: str(r.ends_at),
      serviceName: str(r.service_name),
      professionalLabel: label(r),
      tenantName: str(r.tenant_name),
      address: strOrNull(r.address),
      timezone: str(r.timezone),
    };
  }
}
