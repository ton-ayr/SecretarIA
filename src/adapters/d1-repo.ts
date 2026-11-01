import type {
  Agent,
  BusinessHour,
  Contact,
  Conversation,
  PriceMode,
  Professional,
  Segment,
  Service,
  StoredMessage,
  Tenant,
  MessageAuthor,
} from '../ports/domain.ts';
import type {
  ConversationRoute,
  BotMessageRecord,
  ErasureCounts,
  ErasurePlan,
  HumanReplyRecord,
  DeliveryStatus,
  MetaAccountSecret,
  RetentionReport,
  LlmDailyTotals,
  LlmUsageEntry,
  LoadTurnInput,
  OpsRepo,
  PhoneRoute,
  Repo,
  TenantRepo,
  TurnRecord,
  UsageDelta,
} from '../ports/repo.ts';

import { D1SchedulingOps, D1SchedulingRepo } from './d1-scheduling.ts';
import type { SchedulingOps, SchedulingRepo } from '../ports/scheduling.ts';

/**
 * Repositório D1. Todo SQL de tabela de negócio fica em TENANT_SQL e filtra
 * por tenant_id (há um teste que confere). ?1 é sempre o tenant_id.
 */

// Pontos de entrada sem empresa: o pedido ainda não diz de qual empresa é.
// Cada consulta devolve o tenant_id; daí em diante, tudo passa por forTenant().
export const BOOTSTRAP_SQL = {
  lookupPhone: `SELECT p.id, p.tenant_id, p.meta_account_id FROM phone_numbers p
    JOIN tenants t ON t.id = p.tenant_id AND t.status = 'active'
    WHERE p.meta_phone_number_id = ?1 AND p.status = 'active'`,
  // Link de vínculo do Telegram (uso único, com prazo).
  findLinkCode: `SELECT ch.id, ch.tenant_id, t.name FROM notification_channels ch
    JOIN tenants t ON t.id = ch.tenant_id
    WHERE ch.link_code = ?1 AND ch.active = 0 AND ch.link_expires_at > ?2`,
  // Resposta do dono no Telegram: a mensagem respondida aponta a conversa.
  findRelay: `SELECT tenant_id, conversation_id FROM telegram_relays WHERE chat_ref = ?1 AND tg_message_id = ?2`,
  chatLinked: `SELECT 1 AS ok FROM notification_channels WHERE target_ref = ?1 AND active = 1 LIMIT 1`,
} as const;

// Conversas de um contato (?2 = wa_id), para a exclusão (LGPD).
const CONTACT_CONVERSATIONS = `SELECT cv.id FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id AND c.tenant_id = ?1
    WHERE cv.tenant_id = ?1 AND c.wa_id = ?2`;

export const TENANT_SQL = {
  upsertContact: `INSERT INTO contacts (id, tenant_id, wa_id, profile_name, last_seen_at, created_at)
    VALUES (?2, ?1, ?3, ?4, ?5, ?5)
    ON CONFLICT (tenant_id, wa_id) DO UPDATE SET
      profile_name = COALESCE(excluded.profile_name, contacts.profile_name),
      last_seen_at = excluded.last_seen_at`,
  // O número precisa ser da própria empresa (nunca cria conversa cruzada).
  insertConversation: `INSERT OR IGNORE INTO conversations (id, tenant_id, phone_number_id, contact_id, updated_at)
    SELECT ?2, ?1, p.id, c.id, ?5 FROM contacts c
    JOIN phone_numbers p ON p.id = ?3 AND p.tenant_id = ?1
    WHERE c.tenant_id = ?1 AND c.wa_id = ?4`,
  selectPhone: `SELECT id FROM phone_numbers WHERE tenant_id = ?1 AND id = ?2`,
  selectTenant: `SELECT id, name, segment, timezone, address, reminders_enabled FROM tenants WHERE id = ?1`,
  // Atendente do número; sem um próprio, o da empresa (o primeiro criado).
  selectAgent: `SELECT * FROM agents WHERE tenant_id = ?1 ORDER BY (phone_number_id = ?2) DESC, rowid LIMIT 1`,
  selectServices: `SELECT id, name, description, duration_min, buffer_min, price_mode, price_cents
    FROM services WHERE tenant_id = ?1 AND active = 1 ORDER BY name`,
  selectProfessionals: `SELECT id, name, title FROM professionals WHERE tenant_id = ?1 AND active = 1 ORDER BY name`,
  selectProfessionalServices: `SELECT professional_id, service_id FROM professional_services WHERE tenant_id = ?1`,
  selectHours: `SELECT professional_id, weekday, opens_min, closes_min FROM business_hours WHERE tenant_id = ?1`,
  selectContact: `SELECT id, wa_id, profile_name, display_name FROM contacts WHERE tenant_id = ?1 AND wa_id = ?2`,
  selectConversation: `SELECT cv.id, cv.status, cv.paused_until, cv.last_customer_msg_at, cv.summary, cv.summarized_until
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id AND c.tenant_id = ?1
    WHERE cv.tenant_id = ?1 AND cv.phone_number_id = ?2 AND c.wa_id = ?3`,
  selectHistory: `SELECT m.id, m.author, m.kind, m.body, m.created_at
    FROM messages m
    JOIN conversations cv ON cv.id = m.conversation_id AND cv.tenant_id = ?1
    JOIN contacts c ON c.id = cv.contact_id AND c.tenant_id = ?1
    WHERE m.tenant_id = ?1 AND cv.phone_number_id = ?2 AND c.wa_id = ?3
      AND m.created_at > COALESCE(cv.summarized_until, '')
    ORDER BY m.created_at DESC, m.id DESC LIMIT ?4`,
  countChannels: `SELECT COUNT(*) AS n FROM notification_channels WHERE tenant_id = ?1 AND active = 1`,
  countUnsummarized: `SELECT COUNT(*) AS n
    FROM messages m
    JOIN conversations cv ON cv.id = m.conversation_id AND cv.tenant_id = ?1
    JOIN contacts c ON c.id = cv.contact_id AND c.tenant_id = ?1
    WHERE m.tenant_id = ?1 AND cv.phone_number_id = ?2 AND c.wa_id = ?3
      AND m.created_at > COALESCE(cv.summarized_until, '')`,
  insertMessage: `INSERT INTO messages
    (id, tenant_id, conversation_id, direction, author, kind, body, wa_message_id, turn_id, created_at)
    VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    ON CONFLICT DO NOTHING`,
  touchConversation: `UPDATE conversations SET
      last_customer_msg_at = MAX(COALESCE(last_customer_msg_at, ''), ?3),
      updated_at = ?4
    WHERE tenant_id = ?1 AND id = ?2`,
  upsertUsage: `INSERT INTO usage_monthly
    (tenant_id, phone_number_id, month, msgs_in, replies_out, llm_requests, tokens_in, tokens_out,
     est_cost_usd_micros, msgs_delivered, msgs_failed, templates_utility, templates_marketing, templates_auth,
     stt_seconds, service_billed)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
    ON CONFLICT (phone_number_id, month) DO UPDATE SET
      msgs_in = msgs_in + excluded.msgs_in,
      replies_out = replies_out + excluded.replies_out,
      llm_requests = llm_requests + excluded.llm_requests,
      tokens_in = tokens_in + excluded.tokens_in,
      tokens_out = tokens_out + excluded.tokens_out,
      est_cost_usd_micros = est_cost_usd_micros + excluded.est_cost_usd_micros,
      msgs_delivered = msgs_delivered + excluded.msgs_delivered,
      msgs_failed = msgs_failed + excluded.msgs_failed,
      templates_utility = templates_utility + excluded.templates_utility,
      templates_marketing = templates_marketing + excluded.templates_marketing,
      templates_auth = templates_auth + excluded.templates_auth,
      stt_seconds = stt_seconds + excluded.stt_seconds,
      service_billed = service_billed + excluded.service_billed
    WHERE usage_monthly.tenant_id = ?1`,
  markSent: `UPDATE messages SET wa_message_id = ?3 WHERE tenant_id = ?1 AND id = ?2 AND wa_message_id IS NULL`,
  markDelivered: `UPDATE messages SET delivered_at = ?3
    WHERE tenant_id = ?1 AND wa_message_id = ?2 AND delivered_at IS NULL`,
  markFailed: `UPDATE messages SET failed_code = ?3
    WHERE tenant_id = ?1 AND wa_message_id = ?2 AND failed_code IS NULL`,
  markBilled: `UPDATE messages SET billed_category = ?3
    WHERE tenant_id = ?1 AND wa_message_id = ?2 AND billed_category IS NULL`,
  insertTurnLog: `INSERT INTO turn_logs
    (id, tenant_id, conversation_id, started_at, duration_ms, steps_json, provider, model,
     tool_calls, tokens_in, tokens_out, outcome, error_code)
    VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  resumeBot: `UPDATE conversations SET status = 'bot', paused_until = NULL, updated_at = ?3
    WHERE tenant_id = ?1 AND id = ?2`,
  resolveHandoffs: `UPDATE handoffs SET resolved_at = ?3
    WHERE tenant_id = ?1 AND conversation_id = ?2 AND resolved_at IS NULL`,
  setConversationStatus: `UPDATE conversations SET status = ?3, paused_until = ?4, updated_at = ?5
    WHERE tenant_id = ?1 AND id = ?2`,
  insertHandoff: `INSERT INTO handoffs (id, tenant_id, conversation_id, reason, channels_notified, notified_at, created_at)
    VALUES (?2, ?1, ?3, ?4, ?5, ?6, ?7)`,
  listChannels: `SELECT id, target_enc FROM notification_channels
    WHERE tenant_id = ?1 AND active = 1 AND kind = 'telegram' AND target_enc IS NOT NULL`,
  insertRelay: `INSERT OR IGNORE INTO telegram_relays (tenant_id, chat_ref, tg_message_id, conversation_id, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5)`,
  channelActive: `SELECT 1 AS ok FROM notification_channels WHERE tenant_id = ?1 AND target_ref = ?2 AND active = 1 LIMIT 1`,
  linkChannel: `UPDATE notification_channels SET target_enc = ?3, target_ref = ?4, active = 1,
      link_code = NULL, link_expires_at = NULL, linked_at = ?5
    WHERE tenant_id = ?1 AND id = ?2 AND active = 0 AND link_code IS NOT NULL`,
  conversationRoute: `SELECT cv.id, cv.last_customer_msg_at, c.wa_id, p.id AS phone_id, p.meta_phone_number_id,
      (SELECT a.handoff_resume_hours FROM agents a WHERE a.tenant_id = ?1
        ORDER BY (a.phone_number_id = p.id) DESC, a.rowid LIMIT 1) AS handoff_resume_hours
    FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id AND c.tenant_id = ?1
    JOIN phone_numbers p ON p.id = cv.phone_number_id AND p.tenant_id = ?1
    WHERE cv.tenant_id = ?1 AND cv.id = ?2`,
  humanReplyConversation: `UPDATE conversations SET status = 'human', paused_until = ?3,
      last_human_msg_at = ?4, updated_at = ?4
    WHERE tenant_id = ?1 AND id = ?2`,
  selectSummary: `SELECT summary, summarized_until FROM conversations WHERE tenant_id = ?1 AND id = ?2`,
  selectMessagesAfter: `SELECT id, author, kind, body, created_at FROM messages
    WHERE tenant_id = ?1 AND conversation_id = ?2 AND created_at > ?3
    ORDER BY created_at, id`,
  saveSummary: `UPDATE conversations SET summary = ?3, summarized_until = ?4, updated_at = ?5
    WHERE tenant_id = ?1 AND id = ?2`,
  ensureTestPhone: `INSERT OR IGNORE INTO phone_numbers (id, tenant_id, meta_phone_number_id, display_phone, kind, created_at)
    VALUES (?2, ?1, ?3, 'Simulador', 'test', ?4)`,
  // Exclusão dos dados de um contato (LGPD). ?2 = wa_id.
  erasureConversations: `SELECT cv.id, p.meta_phone_number_id FROM conversations cv
    JOIN contacts c ON c.id = cv.contact_id AND c.tenant_id = ?1
    JOIN phone_numbers p ON p.id = cv.phone_number_id AND p.tenant_id = ?1
    WHERE cv.tenant_id = ?1 AND c.wa_id = ?2`,
  erasureEvents: `SELECT a.id, COALESCE(pr.google_calendar_id, (SELECT google_calendar_id FROM tenants WHERE id = ?1)) AS calendar_id
    FROM appointments a
    JOIN contacts c ON c.id = a.contact_id AND c.tenant_id = ?1
    JOIN professionals pr ON pr.id = a.professional_id AND pr.tenant_id = ?1
    WHERE a.tenant_id = ?1 AND c.wa_id = ?2 AND a.calendar_sync <> 'none'`,
  eraseRelays: `DELETE FROM telegram_relays WHERE tenant_id = ?1 AND conversation_id IN (${CONTACT_CONVERSATIONS})`,
  eraseHandoffs: `DELETE FROM handoffs WHERE tenant_id = ?1 AND conversation_id IN (${CONTACT_CONVERSATIONS})`,
  eraseMessages: `DELETE FROM messages WHERE tenant_id = ?1 AND conversation_id IN (${CONTACT_CONVERSATIONS})`,
  eraseTurnLogs: `DELETE FROM turn_logs WHERE tenant_id = ?1 AND conversation_id IN (${CONTACT_CONVERSATIONS})`,
  eraseAppointments: `DELETE FROM appointments WHERE tenant_id = ?1
    AND contact_id IN (SELECT id FROM contacts WHERE tenant_id = ?1 AND wa_id = ?2)`,
  eraseConversations: `DELETE FROM conversations WHERE tenant_id = ?1
    AND contact_id IN (SELECT id FROM contacts WHERE tenant_id = ?1 AND wa_id = ?2)`,
  eraseContact: `DELETE FROM contacts WHERE tenant_id = ?1 AND wa_id = ?2`,
  eraseRequest: `DELETE FROM erasure_requests WHERE tenant_id = ?1 AND wa_id = ?2`,
} as const;

export const OPS_SQL = {
  addLlmUsage: `INSERT INTO llm_daily_usage (provider, model, day, requests, tokens) VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (provider, model, day) DO UPDATE SET
      requests = requests + excluded.requests,
      tokens = tokens + excluded.tokens
    RETURNING provider, model, requests, tokens, alert_sent_at`,
  markQuotaAlert: `UPDATE llm_daily_usage SET alert_sent_at = ?4
    WHERE provider = ?1 AND model = ?2 AND day = ?3 AND alert_sent_at IS NULL`,
  getMetaAccount: `SELECT access_token_enc, key_version, waba_id FROM meta_accounts WHERE id = ?1`,
  upsertMetaAccount: `INSERT INTO meta_accounts (id, waba_id, access_token_enc, key_version, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (waba_id) DO UPDATE SET access_token_enc = excluded.access_token_enc, key_version = excluded.key_version`,
  // Só lista os pedidos; a exclusão em si é por empresa (TENANT_SQL.erase*).
  pendingErasures: `SELECT tenant_id, wa_id FROM erasure_requests ORDER BY requested_at LIMIT ?1`,
  deleteOldLlmUsage: `DELETE FROM llm_daily_usage WHERE day < date(?1, '-90 days')`,
  getSetting: `SELECT value FROM ops_settings WHERE key = ?1`,
  setSetting: `INSERT INTO ops_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  deleteSetting: `DELETE FROM ops_settings WHERE key = ?1`,
} as const;

// Monitoramento do operador: só leitura, soma todas as empresas.
export const MONITOR_SQL = {
  billedOverThreshold: `SELECT u.phone_number_id, u.service_billed, t.name AS tenant_name, p.display_phone
    FROM usage_monthly u
    JOIN tenants t ON t.id = u.tenant_id
    JOIN phone_numbers p ON p.id = u.phone_number_id AND p.tenant_id = u.tenant_id
    WHERE u.month = ?1 AND u.service_billed >= ?2`,
} as const;

// Limpeza diária (LGPD). Passa por todas as empresas de propósito, mas cada
// linha usa o prazo da PRÓPRIA empresa (JOIN tenants pelo tenant_id).
// ?1 = agora em ISO 8601. Mensagens são apagadas em lotes.
const ISO = `'%Y-%m-%dT%H:%M:%fZ'`;
const STALE_CONTACTS = `SELECT c.id FROM contacts c JOIN tenants t ON t.id = c.tenant_id
  WHERE c.last_seen_at < strftime(${ISO}, ?1, '-' || t.contact_retention_days || ' days')`;
const STALE_CONVERSATIONS = `SELECT cv.id FROM conversations cv WHERE cv.contact_id IN (${STALE_CONTACTS})`;

export const MAINTENANCE_SQL = {
  deleteOldMessages: `DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m JOIN tenants t ON t.id = m.tenant_id
    WHERE m.created_at < strftime(${ISO}, ?1, '-' || t.message_retention_days || ' days')
    LIMIT ?2)`,
  deleteOldRelays: `DELETE FROM telegram_relays WHERE rowid IN (
    SELECT r.rowid FROM telegram_relays r JOIN tenants t ON t.id = r.tenant_id
    WHERE r.created_at < strftime(${ISO}, ?1, '-' || t.message_retention_days || ' days'))`,
  deleteStaleRelays: `DELETE FROM telegram_relays WHERE conversation_id IN (${STALE_CONVERSATIONS})`,
  deleteOldAppointments: `DELETE FROM appointments WHERE id IN (
    SELECT a.id FROM appointments a JOIN tenants t ON t.id = a.tenant_id
    WHERE a.starts_at < strftime(${ISO}, ?1, '-' || t.contact_retention_days || ' days'))`,
  deleteStaleAppointments: `DELETE FROM appointments WHERE contact_id IN (${STALE_CONTACTS})`,
  deleteStaleHandoffs: `DELETE FROM handoffs WHERE conversation_id IN (${STALE_CONVERSATIONS})`,
  deleteStaleContactMessages: `DELETE FROM messages WHERE conversation_id IN (${STALE_CONVERSATIONS})`,
  deleteStaleConversations: `DELETE FROM conversations WHERE contact_id IN (${STALE_CONTACTS})`,
  deleteStaleContacts: `DELETE FROM contacts WHERE id IN (${STALE_CONTACTS})`,
  deleteOldTurnLogs: `DELETE FROM turn_logs WHERE started_at < strftime(${ISO}, ?1, '-30 days')`,
} as const;

const RETENTION_BATCH = 2_000;
const RETENTION_MAX_ROUNDS = 10;

type Row = Record<string, unknown>;

/** Categorias cobradas pela Meta → coluna do medidor. */
/** Categoria cobrada (status da Meta) → contador do medidor. */
const BILLED_FIELDS: Record<string, 'templatesUtility' | 'templatesMarketing' | 'templatesAuth' | 'serviceBilled'> = {
  // Resposta livre na janela de 24 h: cobrada desde 01/10/2026.
  service: 'serviceBilled',
  utility: 'templatesUtility',
  marketing: 'templatesMarketing',
  authentication: 'templatesAuth',
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v ?? 0);

function mapTenant(r: Row): Tenant {
  return {
    id: str(r.id),
    name: str(r.name),
    segment: str(r.segment) as Segment,
    timezone: str(r.timezone),
    address: strOrNull(r.address),
    remindersEnabled: num(r.reminders_enabled) === 1,
  };
}

function mapAgent(r: Row): Agent {
  return {
    id: str(r.id),
    name: str(r.name),
    tone: str(r.tone),
    instructions: str(r.instructions),
    knowledgeBase: str(r.knowledge_base),
    bookingTerm: str(r.booking_term),
    professionalTerm: str(r.professional_term),
    historyMessages: num(r.history_messages),
    maxContextTokens: num(r.max_context_tokens),
    handoffResumeHours: num(r.handoff_resume_hours),
    maxReplyChars: num(r.max_reply_chars),
    promptVersion: num(r.prompt_version),
  };
}

function mapMessage(r: Row): StoredMessage {
  return {
    id: str(r.id),
    author: str(r.author) as MessageAuthor,
    kind: str(r.kind),
    body: str(r.body),
    createdAt: str(r.created_at),
  };
}

class D1TenantRepo implements TenantRepo {
  constructor(
    private readonly db: D1Database,
    readonly tenantId: string,
  ) {}

  private stmt(sql: string, ...params: unknown[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(this.tenantId, ...params);
  }

  async loadTurnContext(input: LoadTurnInput) {
    const S = TENANT_SQL;
    const res = await this.db.batch<Row>([
      this.stmt(S.upsertContact, input.newContactId, input.waId, input.profileName, input.now),
      this.stmt(S.insertConversation, input.newConversationId, input.phoneNumberId, input.waId, input.now),
      this.stmt(S.selectTenant),
      this.stmt(S.selectAgent, input.phoneNumberId),
      this.stmt(S.selectServices),
      this.stmt(S.selectProfessionals),
      this.stmt(S.selectProfessionalServices),
      this.stmt(S.selectHours),
      this.stmt(S.selectContact, input.waId),
      this.stmt(S.selectConversation, input.phoneNumberId, input.waId),
      // Busca até 40 mensagens; o motor corta por quantidade e tokens.
      this.stmt(S.selectHistory, input.phoneNumberId, input.waId, 40),
      this.stmt(S.countUnsummarized, input.phoneNumberId, input.waId),
      this.stmt(S.countChannels),
      this.stmt(S.selectPhone, input.phoneNumberId),
    ]);
    const rows = (i: number): Row[] => res[i]?.results ?? [];

    const tenantRow = rows(2)[0];
    const agentRow = rows(3)[0];
    const contactRow = rows(8)[0];
    const convRow = rows(9)[0];
    // Número de outra empresa: nada é carregado.
    if (!rows(13)[0] || !tenantRow || !agentRow || !contactRow || !convRow) return null;

    const profByService = new Map<string, string[]>();
    for (const r of rows(6)) {
      const list = profByService.get(str(r.service_id)) ?? [];
      list.push(str(r.professional_id));
      profByService.set(str(r.service_id), list);
    }
    const services: Service[] = rows(4).map((r) => ({
      id: str(r.id),
      name: str(r.name),
      description: str(r.description),
      durationMin: num(r.duration_min),
      bufferMin: num(r.buffer_min),
      priceMode: str(r.price_mode) as PriceMode,
      priceCents: r.price_cents === null || r.price_cents === undefined ? null : num(r.price_cents),
      professionalIds: profByService.get(str(r.id)) ?? [],
    }));
    const professionals: Professional[] = rows(5).map((r) => ({
      id: str(r.id),
      name: str(r.name),
      title: strOrNull(r.title),
    }));
    const hours: BusinessHour[] = rows(7).map((r) => ({
      professionalId: strOrNull(r.professional_id),
      weekday: num(r.weekday),
      opensMin: num(r.opens_min),
      closesMin: num(r.closes_min),
    }));
    const contact: Contact = {
      id: str(contactRow.id),
      waId: str(contactRow.wa_id),
      profileName: strOrNull(contactRow.profile_name),
      displayName: strOrNull(contactRow.display_name),
    };
    const conversation: Conversation = {
      id: str(convRow.id),
      status: str(convRow.status) as Conversation['status'],
      pausedUntil: strOrNull(convRow.paused_until),
      lastCustomerMsgAt: strOrNull(convRow.last_customer_msg_at),
      summary: str(convRow.summary),
      summarizedUntil: strOrNull(convRow.summarized_until),
    };

    return {
      tenant: mapTenant(tenantRow),
      agent: mapAgent(agentRow),
      phoneNumberId: input.phoneNumberId,
      services,
      professionals,
      hours,
      contact,
      conversation,
      history: rows(10).map(mapMessage).reverse(),
      unsummarizedCount: num(rows(11)[0]?.n),
      handoffChannels: num(rows(12)[0]?.n),
    };
  }

  async saveTurn(r: TurnRecord): Promise<void> {
    const S = TENANT_SQL;
    const stmts = r.messages.map((m) =>
      this.stmt(
        S.insertMessage,
        m.id,
        r.conversationId,
        m.direction,
        m.author,
        m.kind,
        m.body,
        m.waMessageId,
        r.turnLog.id,
        m.createdAt,
      ),
    );
    stmts.push(this.stmt(S.touchConversation, r.conversationId, r.lastCustomerMsgAt ?? '', r.now));
    if (r.conversationUpdate) {
      const u = r.conversationUpdate;
      stmts.push(this.stmt(S.setConversationStatus, r.conversationId, u.status, u.pausedUntil, r.now));
    }
    if (r.handoff) {
      const h = r.handoff;
      stmts.push(this.stmt(S.insertHandoff, h.id, r.conversationId, h.reason, h.channelsNotified, h.notifiedAt, r.now));
    }
    stmts.push(this.usageStmt(r.phoneNumberId, r.month, r.usage));
    const l = r.turnLog;
    stmts.push(
      this.stmt(
        S.insertTurnLog,
        l.id,
        r.conversationId,
        l.startedAt,
        l.durationMs,
        JSON.stringify(l.steps),
        l.provider,
        l.model,
        l.toolCalls,
        l.tokensIn,
        l.tokensOut,
        l.outcome,
        l.errorCode,
      ),
    );
    await this.db.batch(stmts);
  }

  private usageStmt(phoneNumberId: string, month: string, u: UsageDelta): D1PreparedStatement {
    return this.stmt(
      TENANT_SQL.upsertUsage,
      phoneNumberId,
      month,
      u.msgsIn,
      u.repliesOut,
      u.llmRequests,
      u.tokensIn,
      u.tokensOut,
      u.estCostUsdMicros,
      u.msgsDelivered ?? 0,
      u.msgsFailed ?? 0,
      u.templatesUtility ?? 0,
      u.templatesMarketing ?? 0,
      u.templatesAuth ?? 0,
      Math.round(u.sttSeconds ?? 0),
      u.serviceBilled ?? 0,
    );
  }

  async listTelegramChannels(): Promise<Array<{ id: string; targetEnc: string }>> {
    const res = await this.stmt(TENANT_SQL.listChannels).all<Row>();
    return res.results.map((r) => ({ id: str(r.id), targetEnc: str(r.target_enc) }));
  }

  async addTelegramRelays(relays: Array<{ chatRef: string; tgMessageId: number; conversationId: string }>, now: string) {
    if (relays.length === 0) return;
    await this.db.batch(
      relays.map((r) => this.stmt(TENANT_SQL.insertRelay, r.chatRef, r.tgMessageId, r.conversationId, now)),
    );
  }

  async isChannelActive(chatRef: string): Promise<boolean> {
    return (await this.stmt(TENANT_SQL.channelActive, chatRef).first<Row>()) !== null;
  }

  async linkChannel(channelId: string, targetEnc: string, chatRef: string, now: string): Promise<boolean> {
    const res = await this.stmt(TENANT_SQL.linkChannel, channelId, targetEnc, chatRef, now).run();
    return res.meta.changes === 1;
  }

  async getConversationRoute(conversationId: string): Promise<ConversationRoute | null> {
    const row = await this.stmt(TENANT_SQL.conversationRoute, conversationId).first<Row>();
    if (!row) return null;
    return {
      conversationId: str(row.id),
      phoneNumberId: str(row.phone_id),
      metaPhoneNumberId: str(row.meta_phone_number_id),
      waId: str(row.wa_id),
      lastCustomerMsgAt: strOrNull(row.last_customer_msg_at),
      handoffResumeHours: num(row.handoff_resume_hours),
    };
  }

  async saveHumanReply(r: HumanReplyRecord): Promise<void> {
    const S = TENANT_SQL;
    await this.db.batch([
      this.stmt(S.insertMessage, r.messageId, r.conversationId, 'out', 'human', 'text', r.body, r.waMessageId, null, r.now),
      this.stmt(S.humanReplyConversation, r.conversationId, r.pausedUntil, r.now),
      this.usageStmt(r.phoneNumberId, r.month, {
        msgsIn: 0,
        repliesOut: 1,
        llmRequests: 0,
        tokensIn: 0,
        tokensOut: 0,
        estCostUsdMicros: 0,
      }),
    ]);
  }

  async saveBotMessage(r: BotMessageRecord): Promise<void> {
    await this.db.batch([
      this.stmt(TENANT_SQL.insertMessage, r.messageId, r.conversationId, 'out', 'bot', r.kind, r.body, r.waMessageId, null, r.now),
      this.usageStmt(r.phoneNumberId, r.month, {
        msgsIn: 0,
        repliesOut: 1,
        llmRequests: 0,
        tokensIn: 0,
        tokensOut: 0,
        estCostUsdMicros: 0,
      }),
    ]);
  }

  async markSent(messageId: string, waMessageId: string): Promise<void> {
    await this.stmt(TENANT_SQL.markSent, messageId, waMessageId).run();
  }

  async recordDeliveryStatus(phoneNumberId: string, month: string, st: DeliveryStatus): Promise<void> {
    const S = TENANT_SQL;
    const delta: UsageDelta = { msgsIn: 0, repliesOut: 0, llmRequests: 0, tokensIn: 0, tokensOut: 0, estCostUsdMicros: 0 };
    let changed = false;

    if (st.status === 'delivered' || st.status === 'read') {
      // "read" sem "delivered" antes também conta como entregue.
      const r = await this.stmt(S.markDelivered, st.waMessageId, st.at).run();
      if (r.meta.changes > 0) {
        delta.msgsDelivered = 1;
        changed = true;
      }
    } else if (st.status === 'failed') {
      const r = await this.stmt(S.markFailed, st.waMessageId, st.errorCode ?? 0).run();
      if (r.meta.changes > 0) {
        delta.msgsFailed = 1;
        changed = true;
      }
    }

    const billedField = st.billable ? BILLED_FIELDS[st.category ?? ''] : undefined;
    if (billedField) {
      const r = await this.stmt(S.markBilled, st.waMessageId, st.category).run();
      if (r.meta.changes > 0) {
        delta[billedField] = 1;
        changed = true;
      }
    }
    if (changed) await this.usageStmt(phoneNumberId, month, delta).run();
  }

  async recordUsage(phoneNumberId: string, month: string, usage: UsageDelta): Promise<void> {
    await this.usageStmt(phoneNumberId, month, usage).run();
  }

  scheduling(): SchedulingRepo {
    return new D1SchedulingRepo(this.db, this.tenantId);
  }

  async resumeBot(conversationId: string, now: string): Promise<void> {
    await this.db.batch([
      this.stmt(TENANT_SQL.resumeBot, conversationId, now),
      this.stmt(TENANT_SQL.resolveHandoffs, conversationId, now),
    ]);
  }

  async erasurePlan(waId: string): Promise<ErasurePlan> {
    const [convs, events] = await this.db.batch<Row>([
      this.stmt(TENANT_SQL.erasureConversations, waId),
      this.stmt(TENANT_SQL.erasureEvents, waId),
    ]);
    return {
      conversations: (convs?.results ?? []).map((r) => ({ id: str(r.id), metaPhoneNumberId: str(r.meta_phone_number_id) })),
      calendarEvents: (events?.results ?? []).map((r) => ({ appointmentId: str(r.id), calendarId: strOrNull(r.calendar_id) })),
    };
  }

  async eraseContact(waId: string): Promise<ErasureCounts> {
    const S = TENANT_SQL;
    // Filhos antes dos pais (chaves estrangeiras). Uma transação.
    const res = await this.db.batch([
      this.stmt(S.eraseRelays, waId),
      this.stmt(S.eraseHandoffs, waId),
      this.stmt(S.eraseMessages, waId),
      this.stmt(S.eraseTurnLogs, waId),
      this.stmt(S.eraseAppointments, waId),
      this.stmt(S.eraseConversations, waId),
      this.stmt(S.eraseContact, waId),
      this.stmt(S.eraseRequest, waId),
    ]);
    const changes = (i: number) => res[i]?.meta.changes ?? 0;
    return { messages: changes(2), appointments: changes(4), conversations: changes(5), contacts: changes(6) };
  }

  async ensureTestPhone(id: string, metaPhoneNumberId: string, now: string): Promise<void> {
    await this.stmt(TENANT_SQL.ensureTestPhone, id, metaPhoneNumberId, now).run();
  }

  async loadSummaryInput(conversationId: string, keepLast: number) {
    const conv = await this.stmt(TENANT_SQL.selectSummary, conversationId).first<Row>();
    if (!conv) return { summary: '', messages: [] };
    const all = await this.stmt(TENANT_SQL.selectMessagesAfter, conversationId, str(conv.summarized_until)).all<Row>();
    const messages = all.results.map(mapMessage);
    return { summary: str(conv.summary), messages: messages.slice(0, Math.max(0, messages.length - keepLast)) };
  }

  async saveSummary(conversationId: string, summary: string, summarizedUntil: string, now: string): Promise<void> {
    await this.stmt(TENANT_SQL.saveSummary, conversationId, summary, summarizedUntil, now).run();
  }
}

class D1OpsRepo implements OpsRepo {
  constructor(private readonly db: D1Database) {}

  async addLlmUsage(day: string, entries: LlmUsageEntry[]): Promise<LlmDailyTotals[]> {
    if (entries.length === 0) return [];
    const res = await this.db.batch<Row>(
      entries.map((e) => this.db.prepare(OPS_SQL.addLlmUsage).bind(e.provider, e.model, day, e.requests, e.tokens)),
    );
    return res.flatMap((r) =>
      r.results.map((row) => ({
        provider: str(row.provider),
        model: str(row.model),
        requests: num(row.requests),
        tokens: num(row.tokens),
        alertSentAt: strOrNull(row.alert_sent_at),
      })),
    );
  }

  async markQuotaAlert(provider: string, model: string, day: string, at: string): Promise<boolean> {
    const res = await this.db.prepare(OPS_SQL.markQuotaAlert).bind(provider, model, day, at).run();
    return res.meta.changes === 1;
  }

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db.prepare(OPS_SQL.getSetting).bind(key).first<Row>();
    return row ? str(row.value) : null;
  }

  async setSetting(key: string, value: string, now: string): Promise<void> {
    await this.db.prepare(OPS_SQL.setSetting).bind(key, value, now).run();
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.prepare(OPS_SQL.deleteSetting).bind(key).run();
  }

  async getMetaAccountSecret(metaAccountId: string): Promise<MetaAccountSecret | null> {
    const row = await this.db.prepare(OPS_SQL.getMetaAccount).bind(metaAccountId).first<Row>();
    if (!row?.access_token_enc) return null;
    return { accessTokenEnc: str(row.access_token_enc), keyVersion: num(row.key_version), wabaId: str(row.waba_id) };
  }

  async upsertMetaAccount(id: string, wabaId: string, accessTokenEnc: string, keyVersion: number, now: string): Promise<void> {
    await this.db.prepare(OPS_SQL.upsertMetaAccount).bind(id, wabaId, accessTokenEnc, keyVersion, now).run();
  }

  async pendingErasures(limit: number): Promise<Array<{ tenantId: string; waId: string }>> {
    const res = await this.db.prepare(OPS_SQL.pendingErasures).bind(limit).all<Row>();
    return res.results.map((r) => ({ tenantId: str(r.tenant_id), waId: str(r.wa_id) }));
  }

  async billedOverThreshold(month: string, min: number) {
    const res = await this.db.prepare(MONITOR_SQL.billedOverThreshold).bind(month, min).all<Row>();
    return res.results.map((r) => ({
      phoneNumberId: str(r.phone_number_id),
      billed: num(r.service_billed),
      tenantName: str(r.tenant_name),
      displayPhone: str(r.display_phone),
    }));
  }

  async runRetention(now: string): Promise<RetentionReport> {
    const M = MAINTENANCE_SQL;
    let messages = 0;
    for (let round = 0; round < RETENTION_MAX_ROUNDS; round++) {
      const r = await this.db.prepare(M.deleteOldMessages).bind(now, RETENTION_BATCH).run();
      messages += r.meta.changes;
      if (r.meta.changes < RETENTION_BATCH) break;
    }
    // Contatos sem atividade: tudo que aponta para a conversa sai antes dela,
    // e a conversa antes do contato (chaves estrangeiras). Uma transação.
    const steps = [
      ['relays', M.deleteOldRelays],
      ['staleRelays', M.deleteStaleRelays],
      ['staleHandoffs', M.deleteStaleHandoffs],
      ['oldAppointments', M.deleteOldAppointments],
      ['staleAppointments', M.deleteStaleAppointments],
      ['staleMessages', M.deleteStaleContactMessages],
      ['staleConversations', M.deleteStaleConversations],
      ['staleContacts', M.deleteStaleContacts],
      ['turnLogs', M.deleteOldTurnLogs],
      ['llmUsage', OPS_SQL.deleteOldLlmUsage],
    ] as const;
    const res = await this.db.batch(steps.map(([, sql]) => this.db.prepare(sql).bind(now)));
    const changes = (name: (typeof steps)[number][0]) => res[steps.findIndex(([n]) => n === name)]?.meta.changes ?? 0;
    return {
      messages: messages + changes('staleMessages'),
      contacts: changes('staleContacts'),
      turnLogs: changes('turnLogs'),
    };
  }
}

export class D1Repo implements Repo {
  readonly ops: OpsRepo;
  readonly schedulingOps: SchedulingOps;

  constructor(private readonly db: D1Database) {
    this.ops = new D1OpsRepo(db);
    this.schedulingOps = new D1SchedulingOps(db);
  }

  async lookupPhoneNumber(metaPhoneNumberId: string): Promise<PhoneRoute | null> {
    const row = await this.db.prepare(BOOTSTRAP_SQL.lookupPhone).bind(metaPhoneNumberId).first<Row>();
    return row
      ? { tenantId: str(row.tenant_id), phoneNumberId: str(row.id), metaAccountId: strOrNull(row.meta_account_id) }
      : null;
  }

  async findChannelByLinkCode(code: string, now: string) {
    const row = await this.db.prepare(BOOTSTRAP_SQL.findLinkCode).bind(code, now).first<Row>();
    return row ? { channelId: str(row.id), tenantId: str(row.tenant_id), tenantName: str(row.name) } : null;
  }

  async findTelegramRelay(chatRef: string, tgMessageId: number) {
    const row = await this.db.prepare(BOOTSTRAP_SQL.findRelay).bind(chatRef, tgMessageId).first<Row>();
    return row ? { tenantId: str(row.tenant_id), conversationId: str(row.conversation_id) } : null;
  }

  async isChatLinked(chatRef: string): Promise<boolean> {
    return (await this.db.prepare(BOOTSTRAP_SQL.chatLinked).bind(chatRef).first<Row>()) !== null;
  }

  forTenant(tenantId: string): TenantRepo {
    if (!tenantId) throw new Error('tenantId obrigatório');
    return new D1TenantRepo(this.db, tenantId);
  }
}
