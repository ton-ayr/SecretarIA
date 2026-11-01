import type { MessageAuthor, StoredMessage, TurnContext } from './domain.ts';
import type { SchedulingOps, SchedulingRepo } from './scheduling.ts';

export interface PhoneRoute {
  tenantId: string;
  phoneNumberId: string;
  /** Conta Meta dona do número (null nos números de exemplo do seed). */
  metaAccountId: string | null;
}

export interface LoadTurnInput {
  phoneNumberId: string;
  waId: string;
  profileName: string | null;
  now: string;
  /** IDs novos, usados só se o contato ou a conversa ainda não existirem. */
  newContactId: string;
  newConversationId: string;
}

export interface NewMessage {
  id: string;
  direction: 'in' | 'out';
  author: MessageAuthor;
  kind: string;
  body: string;
  waMessageId: string | null;
  createdAt: string;
}

export interface UsageDelta {
  msgsIn: number;
  repliesOut: number;
  llmRequests: number;
  tokensIn: number;
  tokensOut: number;
  estCostUsdMicros: number;
  msgsDelivered?: number;
  msgsFailed?: number;
  templatesUtility?: number;
  templatesMarketing?: number;
  templatesAuth?: number;
  sttSeconds?: number;
  /** Mensagens de serviço cobradas pela Meta (desde 01/10/2026). */
  serviceBilled?: number;
}

/** Status de uma mensagem enviada, vindo do webhook da Meta. */
export interface DeliveryStatus {
  waMessageId: string;
  status: string;
  at: string;
  errorCode: number | null;
  billable: boolean;
  category: string | null;
}

export interface TurnLogRecord {
  id: string;
  startedAt: string;
  durationMs: number;
  steps: unknown[];
  provider: string | null;
  model: string | null;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  outcome: string;
  errorCode: string | null;
}

export interface TurnRecord {
  conversationId: string;
  phoneNumberId: string;
  month: string;
  messages: NewMessage[];
  lastCustomerMsgAt: string | null;
  now: string;
  usage: UsageDelta;
  turnLog: TurnLogRecord;
  /** Muda o status da conversa (passagem para humano). */
  conversationUpdate?: { status: 'bot' | 'human'; pausedUntil: string | null };
  /** Registra a passagem para humano (sem texto). */
  handoff?: { id: string; reason: string; channelsNotified: number; notifiedAt: string | null };
}

/** Dados para responder ao cliente a partir do Telegram. */
export interface ConversationRoute {
  conversationId: string;
  /** phone_numbers.id (medidor). */
  phoneNumberId: string;
  metaPhoneNumberId: string;
  waId: string;
  lastCustomerMsgAt: string | null;
  handoffResumeHours: number;
}

export interface HumanReplyRecord {
  conversationId: string;
  phoneNumberId: string;
  messageId: string;
  body: string;
  waMessageId: string;
  now: string;
  month: string;
  pausedUntil: string;
}

/** Mensagem do bot fora de um turno (ex.: lembrete do cron). */
export interface BotMessageRecord {
  conversationId: string;
  phoneNumberId: string;
  messageId: string;
  kind: 'interactive' | 'template';
  body: string;
  waMessageId: string;
  now: string;
  month: string;
}

export interface TelegramRelay {
  chatRef: string;
  tgMessageId: number;
  conversationId: string;
}

/** Repositório com escopo de uma empresa: toda consulta filtra por tenant_id. */
export interface TenantRepo {
  readonly tenantId: string;
  loadTurnContext(input: LoadTurnInput): Promise<TurnContext | null>;
  saveTurn(record: TurnRecord): Promise<void>;
  /** Devolve a conversa ao bot e encerra a passagem para humano em aberto. */
  resumeBot(conversationId: string, now: string): Promise<void>;
  /** Agenda desta empresa. */
  scheduling(): SchedulingRepo;
  /** Resumo atual e as mensagens depois dele, exceto as `keepLast` mais novas. */
  loadSummaryInput(conversationId: string, keepLast: number): Promise<{ summary: string; messages: StoredMessage[] }>;
  saveSummary(conversationId: string, summary: string, summarizedUntil: string, now: string): Promise<void>;
  recordUsage(phoneNumberId: string, month: string, usage: UsageDelta): Promise<void>;
  /** Liga a resposta gravada ao wamid devolvido pela Meta. */
  markSent(messageId: string, waMessageId: string): Promise<void>;
  /** Canais de Telegram ativos (chat cifrado). */
  listTelegramChannels(): Promise<Array<{ id: string; targetEnc: string }>>;
  addTelegramRelays(relays: TelegramRelay[], now: string): Promise<void>;
  isChannelActive(chatRef: string): Promise<boolean>;
  /** Conclui o vínculo de um canal (link de uso único). */
  linkChannel(channelId: string, targetEnc: string, chatRef: string, now: string): Promise<boolean>;
  getConversationRoute(conversationId: string): Promise<ConversationRoute | null>;
  /** Grava a resposta da equipe e mantém o bot pausado. */
  saveHumanReply(record: HumanReplyRecord): Promise<void>;

  saveBotMessage(record: BotMessageRecord): Promise<void>;

  /**
   * Aplica um status (entregue, falhou, cobrado) e soma no medidor só na
   * primeira vez, mesmo que a Meta reenvie o webhook.
   */
  recordDeliveryStatus(phoneNumberId: string, month: string, status: DeliveryStatus): Promise<void>;

  /** Exclusão dos dados de um contato (LGPD): o que existe fora do D1. */
  erasurePlan(waId: string): Promise<ErasurePlan>;
  /** Apaga contato, conversas, mensagens, agendamentos e avisos, numa transação. */
  eraseContact(waId: string): Promise<ErasureCounts>;
  /** Número simulador da empresa (chat de teste do painel), se ainda não existir. */
  ensureTestPhone(id: string, metaPhoneNumberId: string, now: string): Promise<void>;
}

export interface LlmUsageEntry {
  provider: string;
  model: string;
  requests: number;
  tokens: number;
}

export interface LlmDailyTotals {
  provider: string;
  model: string;
  requests: number;
  tokens: number;
  alertSentAt: string | null;
}

export interface MetaAccountSecret {
  accessTokenEnc: string;
  keyVersion: number;
  wabaId: string;
}

/** O que existe fora do D1 e precisa sumir junto com o contato. */
export interface ErasurePlan {
  conversations: Array<{ id: string; metaPhoneNumberId: string }>;
  calendarEvents: Array<{ appointmentId: string; calendarId: string | null }>;
}

export interface ErasureCounts {
  contacts: number;
  conversations: number;
  messages: number;
  appointments: number;
}

export interface RetentionReport {
  messages: number;
  contacts: number;
  turnLogs: number;
}

/** Tabelas do operador (sem empresa): cota diária da IA, contas Meta, limpeza. */
export interface OpsRepo {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string, now: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
  getMetaAccountSecret(metaAccountId: string): Promise<MetaAccountSecret | null>;
  /** Limpeza diária (LGPD): cada empresa com o próprio prazo de retenção. */
  runRetention(now: string): Promise<RetentionReport>;
  addLlmUsage(day: string, entries: LlmUsageEntry[]): Promise<LlmDailyTotals[]>;
  /** Marca o alerta do dia. Devolve false se já tinha sido marcado. */
  markQuotaAlert(provider: string, model: string, day: string, at: string): Promise<boolean>;
  /** Cria ou troca o token (já cifrado) de uma conta Meta. */
  upsertMetaAccount(id: string, wabaId: string, accessTokenEnc: string, keyVersion: number, now: string): Promise<void>;
  /** Pedidos de exclusão feitos pelo terminal, os mais antigos primeiro. */
  pendingErasures(limit: number): Promise<Array<{ tenantId: string; waId: string }>>;
  /** Números com pelo menos `min` mensagens de serviço cobradas no mês. */
  billedOverThreshold(
    month: string,
    min: number,
  ): Promise<Array<{ phoneNumberId: string; billed: number; tenantName: string; displayPhone: string }>>;
}

export interface Repo {
  /**
   * Pontos de entrada sem empresa (o pedido ainda não diz de qual empresa é):
   * número da Meta, link de vínculo e mensagens do Telegram. Cada um devolve
   * o tenant_id, e daí em diante tudo passa por forTenant().
   */
  lookupPhoneNumber(metaPhoneNumberId: string): Promise<PhoneRoute | null>;
  findChannelByLinkCode(code: string, now: string): Promise<{ channelId: string; tenantId: string; tenantName: string } | null>;
  findTelegramRelay(chatRef: string, tgMessageId: number): Promise<{ tenantId: string; conversationId: string } | null>;
  isChatLinked(chatRef: string): Promise<boolean>;
  forTenant(tenantId: string): TenantRepo;
  readonly ops: OpsRepo;
  /** Cron de lembretes e sincronização (todas as empresas) e link do cliente. */
  readonly schedulingOps: SchedulingOps;
}
