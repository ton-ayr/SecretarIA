import type {
  AdminOpsRepo,
  AdminRepo,
  AdminTenantRepo,
  AgentSettings,
  AgentUpdate,
  ChannelRow,
  ConversationSummary,
  HoursRow,
  LlmUsageRow,
  MetaAccountRow,
  NewPhone,
  NewTenant,
  OpsUsageRow,
  PhoneRow,
  ProfessionalInput,
  ProfessionalRow,
  ServiceInput,
  ServiceRow,
  TenantOverview,
  TenantSettings,
  TenantSummary,
  TenantUpdate,
  TimeOffInput,
  TimeOffRow,
  TranscriptMessage,
  UsageRow,
  WeekHours,
} from '../ports/admin.ts';
import { TEST_WA_ID, testPhoneMetaId } from '../ports/admin.ts';
import type { MessageAuthor, PriceMode, Segment } from '../ports/domain.ts';
import type { SchedulingRules } from '../ports/scheduling.ts';
import { ulid } from '../shared/ids.ts';

/**
 * Repositório do painel. ADMIN_SQL tem escopo de empresa: ?1 é sempre o
 * tenant_id e toda tabela de negócio é filtrada por ele (há teste que
 * confere). ADMIN_OPS_SQL é a visão do operador (lista de empresas, contas
 * Meta, totais), a única que cruza empresas.
 */

const USAGE_COLUMNS = `u.phone_number_id, p.display_phone, p.kind, u.month, u.msgs_in, u.replies_out,
    u.msgs_delivered, u.msgs_failed, u.service_billed, u.templates_utility, u.templates_marketing,
    u.templates_auth, u.llm_requests, u.tokens_in, u.tokens_out, u.stt_seconds, u.est_cost_usd_micros`;

const CONVERSATION_COLUMNS = `cv.id, cv.contact_id, c.wa_id, COALESCE(c.display_name, c.profile_name) AS contact_name,
    cv.status, cv.paused_until, cv.last_customer_msg_at, cv.updated_at, p.kind, p.display_phone`;

export const ADMIN_SQL = {
  // Empresa nova (?1 = id novo).
  insertTenant: `INSERT INTO tenants (id, name, segment, timezone, address, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  insertTestPhone: `INSERT OR IGNORE INTO phone_numbers (id, tenant_id, meta_phone_number_id, display_phone, kind, created_at)
    VALUES (?2, ?1, ?3, 'Simulador', 'test', ?4)`,
  insertAgent: `INSERT INTO agents (id, tenant_id, phone_number_id, name, booking_term, professional_term)
    VALUES (?2, ?1, ?3, ?4, ?5, ?6)`,
  insertDefaultRules: `INSERT OR IGNORE INTO scheduling_rules (tenant_id) VALUES (?1)`,

  getTenant: `SELECT id, name, segment, timezone, address, status, reminders_enabled, message_retention_days,
      contact_retention_days, google_calendar_id, created_at
    FROM tenants WHERE id = ?1`,
  updateTenant: `UPDATE tenants SET name = ?2, segment = ?3, timezone = ?4, address = ?5, status = ?6,
      reminders_enabled = ?7, message_retention_days = ?8, contact_retention_days = ?9
    WHERE id = ?1`,
  setTenantCalendar: `UPDATE tenants SET google_calendar_id = ?2 WHERE id = ?1`,

  countServices: `SELECT COUNT(*) AS n FROM services WHERE tenant_id = ?1 AND active = 1`,
  countProfessionals: `SELECT COUNT(*) AS n FROM professionals WHERE tenant_id = ?1 AND active = 1`,
  countHours: `SELECT COUNT(*) AS n FROM business_hours WHERE tenant_id = ?1`,
  countNumbers: `SELECT COUNT(*) AS n FROM phone_numbers WHERE tenant_id = ?1 AND kind = 'whatsapp' AND status = 'active'`,
  countChannels: `SELECT COUNT(*) AS n FROM notification_channels WHERE tenant_id = ?1 AND active = 1`,
  // Mensagens já testadas (pelo medidor: não some com o "Limpar teste").
  countTestMessages: `SELECT COALESCE(SUM(u.msgs_in), 0) AS n FROM usage_monthly u
    JOIN phone_numbers p ON p.id = u.phone_number_id AND p.tenant_id = ?1
    WHERE u.tenant_id = ?1 AND p.kind = 'test'`,
  agentReady: `SELECT COUNT(*) AS n FROM agents WHERE tenant_id = ?1 AND (instructions <> '' OR knowledge_base <> '')`,

  getAgent: `SELECT id, name, tone, instructions, knowledge_base, booking_term, professional_term,
      max_reply_chars, handoff_resume_hours
    FROM agents WHERE tenant_id = ?1 ORDER BY rowid LIMIT 1`,
  updateAgent: `UPDATE agents SET name = ?3, tone = ?4, instructions = ?5, knowledge_base = ?6, booking_term = ?7,
      professional_term = ?8, max_reply_chars = ?9, handoff_resume_hours = ?10, prompt_version = prompt_version + 1
    WHERE tenant_id = ?1 AND id = ?2`,

  listServices: `SELECT id, name, description, duration_min, buffer_min, price_mode, price_cents, active
    FROM services WHERE tenant_id = ?1 ORDER BY active DESC, name`,
  listLinks: `SELECT professional_id, service_id FROM professional_services WHERE tenant_id = ?1`,
  serviceExists: `SELECT 1 AS ok FROM services WHERE tenant_id = ?1 AND id = ?2`,
  insertService: `INSERT INTO services (id, tenant_id, name, description, duration_min, buffer_min, price_mode, price_cents, active)
    VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  updateService: `UPDATE services SET name = ?3, description = ?4, duration_min = ?5, buffer_min = ?6,
      price_mode = ?7, price_cents = ?8, active = ?9
    WHERE tenant_id = ?1 AND id = ?2`,
  deleteServiceLinks: `DELETE FROM professional_services WHERE tenant_id = ?1 AND service_id = ?2`,
  // Profissional e serviço precisam ser da própria empresa.
  insertLink: `INSERT OR IGNORE INTO professional_services (tenant_id, professional_id, service_id)
    SELECT ?1, p.id, s.id FROM professionals p
    JOIN services s ON s.id = ?3 AND s.tenant_id = ?1
    WHERE p.tenant_id = ?1 AND p.id = ?2`,

  listProfessionals: `SELECT id, name, title, active, google_calendar_id
    FROM professionals WHERE tenant_id = ?1 ORDER BY active DESC, name`,
  professionalExists: `SELECT 1 AS ok FROM professionals WHERE tenant_id = ?1 AND id = ?2`,
  insertProfessional: `INSERT INTO professionals (id, tenant_id, name, title, active) VALUES (?2, ?1, ?3, ?4, ?5)`,
  updateProfessional: `UPDATE professionals SET name = ?3, title = ?4, active = ?5 WHERE tenant_id = ?1 AND id = ?2`,
  setProfessionalCalendar: `UPDATE professionals SET google_calendar_id = ?3 WHERE tenant_id = ?1 AND id = ?2`,

  listHours: `SELECT professional_id, weekday, opens_min, closes_min FROM business_hours
    WHERE tenant_id = ?1 ORDER BY professional_id, weekday, opens_min`,
  deleteHouseHours: `DELETE FROM business_hours WHERE tenant_id = ?1 AND professional_id IS NULL`,
  deleteProfessionalHours: `DELETE FROM business_hours WHERE tenant_id = ?1 AND professional_id = ?2`,
  insertHour: `INSERT INTO business_hours (id, tenant_id, professional_id, weekday, opens_min, closes_min)
    SELECT ?2, ?1, ?3, ?4, ?5, ?6
    WHERE ?3 IS NULL OR EXISTS (SELECT 1 FROM professionals WHERE tenant_id = ?1 AND id = ?3)`,

  listTimeOff: `SELECT id, professional_id, starts_at, ends_at, reason FROM time_off
    WHERE tenant_id = ?1 AND ends_at > ?2 ORDER BY starts_at LIMIT 100`,
  insertTimeOff: `INSERT INTO time_off (id, tenant_id, professional_id, starts_at, ends_at, reason)
    SELECT ?2, ?1, ?3, ?4, ?5, ?6
    WHERE ?3 IS NULL OR EXISTS (SELECT 1 FROM professionals WHERE tenant_id = ?1 AND id = ?3)`,
  deleteTimeOff: `DELETE FROM time_off WHERE tenant_id = ?1 AND id = ?2`,

  getRules: `SELECT slot_step_min, min_advance_min, max_days_ahead, max_options FROM scheduling_rules WHERE tenant_id = ?1`,
  saveRules: `INSERT INTO scheduling_rules (tenant_id, slot_step_min, min_advance_min, max_days_ahead, max_options)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (tenant_id) DO UPDATE SET slot_step_min = excluded.slot_step_min,
      min_advance_min = excluded.min_advance_min, max_days_ahead = excluded.max_days_ahead,
      max_options = excluded.max_options`,

  listPhones: `SELECT id, meta_phone_number_id, display_phone, status, kind, meta_account_id, created_at
    FROM phone_numbers WHERE tenant_id = ?1 ORDER BY kind DESC, created_at`,
  // meta_accounts é do operador (sem empresa). Número já usado: nada é gravado.
  insertPhone: `INSERT OR IGNORE INTO phone_numbers
      (id, tenant_id, meta_account_id, meta_phone_number_id, display_phone, kind, created_at)
    SELECT ?2, ?1, m.id, ?4, ?5, 'whatsapp', ?6 FROM meta_accounts m WHERE m.id = ?3`,
  setPhoneStatus: `UPDATE phone_numbers SET status = ?3 WHERE tenant_id = ?1 AND id = ?2 AND kind = 'whatsapp'`,

  listChannels: `SELECT id, label, active, linked_at, link_expires_at, created_at
    FROM notification_channels WHERE tenant_id = ?1 ORDER BY created_at DESC`,
  insertChannelLink: `INSERT INTO notification_channels (id, tenant_id, kind, label, link_code, link_expires_at, active, created_at)
    VALUES (?2, ?1, 'telegram', ?3, ?4, ?5, 0, ?6)`,
  deleteChannel: `DELETE FROM notification_channels WHERE tenant_id = ?1 AND id = ?2`,

  listConversations: `SELECT ${CONVERSATION_COLUMNS}
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id AND c.tenant_id = ?1
    JOIN phone_numbers p ON p.id = cv.phone_number_id AND p.tenant_id = ?1
    WHERE cv.tenant_id = ?1 AND cv.updated_at >= ?2
    ORDER BY cv.updated_at DESC LIMIT 100`,
  getConversation: `SELECT ${CONVERSATION_COLUMNS}
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id AND c.tenant_id = ?1
    JOIN phone_numbers p ON p.id = cv.phone_number_id AND p.tenant_id = ?1
    WHERE cv.tenant_id = ?1 AND cv.id = ?2`,
  testConversation: `SELECT cv.id FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id AND c.tenant_id = ?1
    JOIN phone_numbers p ON p.id = cv.phone_number_id AND p.tenant_id = ?1
    WHERE cv.tenant_id = ?1 AND p.kind = 'test' AND c.wa_id = ?2`,
  listMessages: `SELECT id, direction, author, kind, body, created_at FROM messages
    WHERE tenant_id = ?1 AND conversation_id = ?2 ORDER BY created_at, id LIMIT 300`,

  listUsage: `SELECT ${USAGE_COLUMNS}
    FROM usage_monthly u
    JOIN phone_numbers p ON p.id = u.phone_number_id AND p.tenant_id = ?1
    WHERE u.tenant_id = ?1 AND u.month >= ?2
    ORDER BY u.month DESC, p.kind DESC, p.created_at`,
} as const;

// Visão do operador: cruza empresas de propósito, só para listar e somar.
export const ADMIN_OPS_SQL = {
  listTenants: `SELECT t.id, t.name, t.segment, t.status, t.created_at,
      (SELECT COUNT(*) FROM phone_numbers p WHERE p.tenant_id = t.id AND p.kind = 'whatsapp' AND p.status = 'active') AS numbers,
      (SELECT COUNT(*) FROM services s WHERE s.tenant_id = t.id AND s.active = 1) AS services,
      (SELECT COUNT(*) FROM professionals pr WHERE pr.tenant_id = t.id AND pr.active = 1) AS professionals,
      (SELECT COUNT(*) FROM business_hours h WHERE h.tenant_id = t.id) AS hours,
      (SELECT COUNT(*) FROM notification_channels ch WHERE ch.tenant_id = t.id AND ch.active = 1) AS channels,
      (SELECT COUNT(*) FROM agents a WHERE a.tenant_id = t.id AND (a.instructions <> '' OR a.knowledge_base <> '')) AS agent_ready,
      (SELECT COALESCE(SUM(u.msgs_in), 0) FROM usage_monthly u JOIN phone_numbers p ON p.id = u.phone_number_id
        WHERE u.tenant_id = t.id AND p.kind = 'test') AS test_messages
    FROM tenants t ORDER BY t.name`,
  listMetaAccounts: `SELECT m.id, m.waba_id, m.access_token_enc IS NOT NULL AS has_token, m.created_at,
      (SELECT COUNT(*) FROM phone_numbers p WHERE p.meta_account_id = m.id) AS numbers
    FROM meta_accounts m ORDER BY m.created_at`,
  listUsage: `SELECT u.tenant_id, t.name AS tenant_name, ${USAGE_COLUMNS}
    FROM usage_monthly u
    JOIN tenants t ON t.id = u.tenant_id
    JOIN phone_numbers p ON p.id = u.phone_number_id AND p.tenant_id = u.tenant_id
    WHERE u.month = ?1
    ORDER BY t.name, p.kind DESC, p.created_at`,
  llmUsage: `SELECT provider, model, requests, tokens FROM llm_daily_usage WHERE day = ?1 ORDER BY provider, model`,
} as const;

/** Termos padrão do atendente por segmento (editáveis depois). */
const DEFAULT_TERMS: Record<Segment, { booking: string; professional: string }> = {
  general: { booking: 'horário', professional: 'profissional' },
  health: { booking: 'consulta', professional: 'profissional' },
};

type Row = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);
const bool = (v: unknown): boolean => num(v) === 1;

function mapUsage(r: Row): UsageRow {
  return {
    phoneNumberId: str(r.phone_number_id),
    displayPhone: str(r.display_phone),
    kind: str(r.kind) as UsageRow['kind'],
    month: str(r.month),
    msgsIn: num(r.msgs_in),
    repliesOut: num(r.replies_out),
    msgsDelivered: num(r.msgs_delivered),
    msgsFailed: num(r.msgs_failed),
    serviceBilled: num(r.service_billed),
    templatesUtility: num(r.templates_utility),
    templatesMarketing: num(r.templates_marketing),
    templatesAuth: num(r.templates_auth),
    llmRequests: num(r.llm_requests),
    tokensIn: num(r.tokens_in),
    tokensOut: num(r.tokens_out),
    sttSeconds: num(r.stt_seconds),
    estCostUsdMicros: num(r.est_cost_usd_micros),
  };
}

function mapConversation(r: Row): ConversationSummary {
  return {
    id: str(r.id),
    contactId: str(r.contact_id),
    waId: str(r.wa_id),
    contactName: strOrNull(r.contact_name),
    status: str(r.status) as ConversationSummary['status'],
    pausedUntil: strOrNull(r.paused_until),
    lastCustomerMsgAt: strOrNull(r.last_customer_msg_at),
    updatedAt: str(r.updated_at),
    phoneKind: str(r.kind) as ConversationSummary['phoneKind'],
    displayPhone: str(r.display_phone),
  };
}

class D1AdminTenantRepo implements AdminTenantRepo {
  constructor(
    private readonly db: D1Database,
    readonly tenantId: string,
  ) {}

  private stmt(sql: string, ...params: unknown[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(this.tenantId, ...params);
  }

  async getTenant(): Promise<TenantSettings | null> {
    const r = await this.stmt(ADMIN_SQL.getTenant).first<Row>();
    if (!r) return null;
    return {
      id: str(r.id),
      name: str(r.name),
      segment: str(r.segment) as Segment,
      timezone: str(r.timezone),
      address: strOrNull(r.address),
      status: str(r.status) as TenantSettings['status'],
      remindersEnabled: bool(r.reminders_enabled),
      messageRetentionDays: num(r.message_retention_days),
      contactRetentionDays: num(r.contact_retention_days),
      googleCalendarId: strOrNull(r.google_calendar_id),
      createdAt: str(r.created_at),
    };
  }

  async updateTenant(u: TenantUpdate): Promise<void> {
    await this.stmt(
      ADMIN_SQL.updateTenant,
      u.name,
      u.segment,
      u.timezone,
      u.address,
      u.status,
      u.remindersEnabled ? 1 : 0,
      u.messageRetentionDays,
      u.contactRetentionDays,
    ).run();
  }

  async setGoogleCalendar(calendarId: string | null): Promise<void> {
    await this.stmt(ADMIN_SQL.setTenantCalendar, calendarId).run();
  }

  async overview(): Promise<TenantOverview> {
    const S = ADMIN_SQL;
    const res = await this.db.batch<Row>([
      this.stmt(S.countServices),
      this.stmt(S.countProfessionals),
      this.stmt(S.countHours),
      this.stmt(S.countNumbers),
      this.stmt(S.countChannels),
      this.stmt(S.countTestMessages),
      this.stmt(S.agentReady),
    ]);
    const n = (i: number) => num(res[i]?.results[0]?.n);
    return {
      services: n(0),
      professionals: n(1),
      hours: n(2),
      numbers: n(3),
      channels: n(4),
      testMessages: n(5),
      agentReady: n(6) > 0,
    };
  }

  async getAgent(): Promise<AgentSettings | null> {
    const r = await this.stmt(ADMIN_SQL.getAgent).first<Row>();
    if (!r) return null;
    return {
      id: str(r.id),
      name: str(r.name),
      tone: str(r.tone),
      instructions: str(r.instructions),
      knowledgeBase: str(r.knowledge_base),
      bookingTerm: str(r.booking_term),
      professionalTerm: str(r.professional_term),
      maxReplyChars: num(r.max_reply_chars),
      handoffResumeHours: num(r.handoff_resume_hours),
    };
  }

  async updateAgent(id: string, a: AgentUpdate): Promise<boolean> {
    const res = await this.stmt(
      ADMIN_SQL.updateAgent,
      id,
      a.name,
      a.tone,
      a.instructions,
      a.knowledgeBase,
      a.bookingTerm,
      a.professionalTerm,
      a.maxReplyChars,
      a.handoffResumeHours,
    ).run();
    return res.meta.changes === 1;
  }

  async listServices(): Promise<ServiceRow[]> {
    const [services, links] = await this.db.batch<Row>([this.stmt(ADMIN_SQL.listServices), this.stmt(ADMIN_SQL.listLinks)]);
    const byService = new Map<string, string[]>();
    for (const l of links?.results ?? []) {
      byService.set(str(l.service_id), [...(byService.get(str(l.service_id)) ?? []), str(l.professional_id)]);
    }
    return (services?.results ?? []).map((r) => ({
      id: str(r.id),
      name: str(r.name),
      description: str(r.description),
      durationMin: num(r.duration_min),
      bufferMin: num(r.buffer_min),
      priceMode: str(r.price_mode) as PriceMode,
      priceCents: r.price_cents === null || r.price_cents === undefined ? null : num(r.price_cents),
      active: bool(r.active),
      professionalIds: byService.get(str(r.id)) ?? [],
    }));
  }

  async saveService(id: string | null, s: ServiceInput): Promise<string | null> {
    const S = ADMIN_SQL;
    const fields = [s.name, s.description, s.durationMin, s.bufferMin, s.priceMode, s.priceCents, s.active ? 1 : 0];
    let serviceId = id;
    const stmts: D1PreparedStatement[] = [];
    if (serviceId) {
      if (!(await this.stmt(S.serviceExists, serviceId).first<Row>())) return null;
      stmts.push(this.stmt(S.updateService, serviceId, ...fields));
    } else {
      serviceId = ulid();
      stmts.push(this.stmt(S.insertService, serviceId, ...fields));
    }
    stmts.push(this.stmt(S.deleteServiceLinks, serviceId));
    for (const profId of new Set(s.professionalIds)) stmts.push(this.stmt(S.insertLink, profId, serviceId));
    await this.db.batch(stmts);
    return serviceId;
  }

  async listProfessionals(): Promise<ProfessionalRow[]> {
    const [profs, links] = await this.db.batch<Row>([this.stmt(ADMIN_SQL.listProfessionals), this.stmt(ADMIN_SQL.listLinks)]);
    const byProf = new Map<string, string[]>();
    for (const l of links?.results ?? []) {
      byProf.set(str(l.professional_id), [...(byProf.get(str(l.professional_id)) ?? []), str(l.service_id)]);
    }
    return (profs?.results ?? []).map((r) => ({
      id: str(r.id),
      name: str(r.name),
      title: strOrNull(r.title),
      active: bool(r.active),
      googleCalendarId: strOrNull(r.google_calendar_id),
      serviceIds: byProf.get(str(r.id)) ?? [],
    }));
  }

  async saveProfessional(id: string | null, p: ProfessionalInput): Promise<string | null> {
    const S = ADMIN_SQL;
    if (id) {
      const res = await this.stmt(S.updateProfessional, id, p.name, p.title, p.active ? 1 : 0).run();
      return res.meta.changes === 1 ? id : null;
    }
    const newId = ulid();
    await this.stmt(S.insertProfessional, newId, p.name, p.title, p.active ? 1 : 0).run();
    return newId;
  }

  async setProfessionalCalendar(id: string, calendarId: string | null): Promise<void> {
    await this.stmt(ADMIN_SQL.setProfessionalCalendar, id, calendarId).run();
  }

  async listHours(): Promise<HoursRow[]> {
    const res = await this.stmt(ADMIN_SQL.listHours).all<Row>();
    return res.results.map((r) => ({
      professionalId: strOrNull(r.professional_id),
      weekday: num(r.weekday),
      opensMin: num(r.opens_min),
      closesMin: num(r.closes_min),
    }));
  }

  async replaceHours(professionalId: string | null, week: WeekHours): Promise<void> {
    const S = ADMIN_SQL;
    if (professionalId && !(await this.stmt(S.professionalExists, professionalId).first<Row>())) return;
    const stmts = [professionalId ? this.stmt(S.deleteProfessionalHours, professionalId) : this.stmt(S.deleteHouseHours)];
    for (const [day, intervals] of Object.entries(week)) {
      for (const i of intervals ?? []) {
        stmts.push(this.stmt(S.insertHour, ulid(), professionalId, Number(day), i.opensMin, i.closesMin));
      }
    }
    await this.db.batch(stmts);
  }

  async listTimeOff(fromIso: string): Promise<TimeOffRow[]> {
    const res = await this.stmt(ADMIN_SQL.listTimeOff, fromIso).all<Row>();
    return res.results.map((r) => ({
      id: str(r.id),
      professionalId: strOrNull(r.professional_id),
      startsAt: str(r.starts_at),
      endsAt: str(r.ends_at),
      reason: strOrNull(r.reason),
    }));
  }

  async addTimeOff(t: TimeOffInput): Promise<string | null> {
    const id = ulid();
    const res = await this.stmt(ADMIN_SQL.insertTimeOff, id, t.professionalId, t.startsAt, t.endsAt, t.reason).run();
    return res.meta.changes === 1 ? id : null;
  }

  async deleteTimeOff(id: string): Promise<void> {
    await this.stmt(ADMIN_SQL.deleteTimeOff, id).run();
  }

  async getRules(): Promise<SchedulingRules | null> {
    const r = await this.stmt(ADMIN_SQL.getRules).first<Row>();
    if (!r) return null;
    return {
      slotStepMin: num(r.slot_step_min),
      minAdvanceMin: num(r.min_advance_min),
      maxDaysAhead: num(r.max_days_ahead),
      maxOptions: num(r.max_options),
    };
  }

  async saveRules(r: SchedulingRules): Promise<void> {
    await this.stmt(ADMIN_SQL.saveRules, r.slotStepMin, r.minAdvanceMin, r.maxDaysAhead, r.maxOptions).run();
  }

  async listPhones(): Promise<PhoneRow[]> {
    const res = await this.stmt(ADMIN_SQL.listPhones).all<Row>();
    return res.results.map((r) => ({
      id: str(r.id),
      metaPhoneNumberId: str(r.meta_phone_number_id),
      displayPhone: str(r.display_phone),
      status: str(r.status) as PhoneRow['status'],
      kind: str(r.kind) as PhoneRow['kind'],
      metaAccountId: strOrNull(r.meta_account_id),
      createdAt: str(r.created_at),
    }));
  }

  async addPhone(p: NewPhone, now: string): Promise<boolean> {
    const res = await this.stmt(
      ADMIN_SQL.insertPhone,
      ulid(),
      p.metaAccountId,
      p.metaPhoneNumberId,
      p.displayPhone,
      now,
    ).run();
    return res.meta.changes === 1;
  }

  async setPhoneStatus(id: string, status: PhoneRow['status']): Promise<void> {
    await this.stmt(ADMIN_SQL.setPhoneStatus, id, status).run();
  }

  async listChannels(): Promise<ChannelRow[]> {
    const res = await this.stmt(ADMIN_SQL.listChannels).all<Row>();
    return res.results.map((r) => ({
      id: str(r.id),
      label: strOrNull(r.label),
      active: bool(r.active),
      linkedAt: strOrNull(r.linked_at),
      linkExpiresAt: strOrNull(r.link_expires_at),
      createdAt: str(r.created_at),
    }));
  }

  async createChannelLink(label: string | null, code: string, expiresAt: string, now: string): Promise<void> {
    await this.stmt(ADMIN_SQL.insertChannelLink, ulid(), label, code, expiresAt, now).run();
  }

  async removeChannel(id: string): Promise<void> {
    await this.stmt(ADMIN_SQL.deleteChannel, id).run();
  }

  async listConversations(sinceIso: string): Promise<ConversationSummary[]> {
    const res = await this.stmt(ADMIN_SQL.listConversations, sinceIso).all<Row>();
    return res.results.map(mapConversation);
  }

  async getConversation(id: string) {
    const [conv, msgs] = await this.db.batch<Row>([
      this.stmt(ADMIN_SQL.getConversation, id),
      this.stmt(ADMIN_SQL.listMessages, id),
    ]);
    const row = conv?.results[0];
    if (!row) return null;
    const messages: TranscriptMessage[] = (msgs?.results ?? []).map((m) => ({
      id: str(m.id),
      direction: str(m.direction) as TranscriptMessage['direction'],
      author: str(m.author) as MessageAuthor,
      kind: str(m.kind),
      body: str(m.body),
      createdAt: str(m.created_at),
    }));
    return { summary: mapConversation(row), messages };
  }

  async testConversation() {
    const row = await this.stmt(ADMIN_SQL.testConversation, TEST_WA_ID).first<Row>();
    return row ? this.getConversation(str(row.id)) : null;
  }

  async listUsage(fromMonth: string): Promise<UsageRow[]> {
    const res = await this.stmt(ADMIN_SQL.listUsage, fromMonth).all<Row>();
    return res.results.map(mapUsage);
  }
}

class D1AdminOpsRepo implements AdminOpsRepo {
  constructor(private readonly db: D1Database) {}

  async listTenants(): Promise<TenantSummary[]> {
    const res = await this.db.prepare(ADMIN_OPS_SQL.listTenants).all<Row>();
    return res.results.map((r) => ({
      id: str(r.id),
      name: str(r.name),
      segment: str(r.segment) as Segment,
      status: str(r.status) as TenantSummary['status'],
      createdAt: str(r.created_at),
      numbers: num(r.numbers),
      services: num(r.services),
      professionals: num(r.professionals),
      hours: num(r.hours),
      channels: num(r.channels),
      agentReady: num(r.agent_ready) > 0,
      testMessages: num(r.test_messages),
    }));
  }

  async createTenant(t: NewTenant, now: string): Promise<string> {
    const S = ADMIN_SQL;
    const tenantId = ulid();
    const phoneId = ulid();
    const terms = DEFAULT_TERMS[t.segment];
    const bind = (sql: string, ...params: unknown[]) => this.db.prepare(sql).bind(tenantId, ...params);
    await this.db.batch([
      bind(S.insertTenant, t.name, t.segment, t.timezone, t.address, now),
      bind(S.insertTestPhone, phoneId, testPhoneMetaId(tenantId), now),
      bind(S.insertAgent, ulid(), phoneId, t.agentName, terms.booking, terms.professional),
      bind(S.insertDefaultRules),
    ]);
    return tenantId;
  }

  async listMetaAccounts(): Promise<MetaAccountRow[]> {
    const res = await this.db.prepare(ADMIN_OPS_SQL.listMetaAccounts).all<Row>();
    return res.results.map((r) => ({
      id: str(r.id),
      wabaId: str(r.waba_id),
      hasToken: bool(r.has_token),
      numbers: num(r.numbers),
      createdAt: str(r.created_at),
    }));
  }

  async listUsage(month: string): Promise<OpsUsageRow[]> {
    const res = await this.db.prepare(ADMIN_OPS_SQL.listUsage).bind(month).all<Row>();
    return res.results.map((r) => ({ ...mapUsage(r), tenantId: str(r.tenant_id), tenantName: str(r.tenant_name) }));
  }

  async llmUsage(day: string): Promise<LlmUsageRow[]> {
    const res = await this.db.prepare(ADMIN_OPS_SQL.llmUsage).bind(day).all<Row>();
    return res.results.map((r) => ({
      provider: str(r.provider),
      model: str(r.model),
      requests: num(r.requests),
      tokens: num(r.tokens),
    }));
  }
}

export class D1AdminRepo implements AdminRepo {
  readonly ops: AdminOpsRepo;

  constructor(private readonly db: D1Database) {
    this.ops = new D1AdminOpsRepo(db);
  }

  forTenant(tenantId: string): AdminTenantRepo {
    if (!tenantId) throw new Error('tenantId obrigatório');
    return new D1AdminTenantRepo(this.db, tenantId);
  }
}
