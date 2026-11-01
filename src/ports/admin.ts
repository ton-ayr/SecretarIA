import type { MessageAuthor, PriceMode, Segment } from './domain.ts';
import type { SchedulingRules } from './scheduling.ts';

// Painel administrativo: o que o operador lê e grava. Toda leitura e
// escrita de uma empresa passa por AdminRepo.forTenant(); só a lista de
// empresas, as contas Meta e os totais do operador ficam fora.

/** Número "simulador" de cada empresa (chat de teste do painel). */
export const TEST_PHONE_PREFIX = 'sim-';
export const testPhoneMetaId = (tenantId: string): string => `${TEST_PHONE_PREFIX}${tenantId}`;
/** Contato fixo do chat de teste. */
export const TEST_WA_ID = 'teste';

export type TenantStatus = 'active' | 'suspended';

export interface TenantSettings {
  id: string;
  name: string;
  segment: Segment;
  timezone: string;
  address: string | null;
  status: TenantStatus;
  remindersEnabled: boolean;
  messageRetentionDays: number;
  contactRetentionDays: number;
  googleCalendarId: string | null;
  createdAt: string;
}

export type TenantUpdate = Omit<TenantSettings, 'id' | 'createdAt' | 'googleCalendarId'>;

export interface NewTenant {
  name: string;
  segment: Segment;
  timezone: string;
  address: string | null;
  agentName: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  segment: Segment;
  status: TenantStatus;
  createdAt: string;
  /** Números de WhatsApp ativos (sem o simulador). */
  numbers: number;
  services: number;
  professionals: number;
  hours: number;
  channels: number;
  /** Atendente com instruções ou informações próprias. */
  agentReady: boolean;
  /** Mensagens já mandadas no chat de teste (medidor). */
  testMessages: number;
}

export interface AgentSettings {
  id: string;
  name: string;
  tone: string;
  instructions: string;
  knowledgeBase: string;
  bookingTerm: string;
  professionalTerm: string;
  maxReplyChars: number;
  handoffResumeHours: number;
}

export type AgentUpdate = Omit<AgentSettings, 'id'>;

export interface ServiceRow {
  id: string;
  name: string;
  description: string;
  durationMin: number;
  bufferMin: number;
  priceMode: PriceMode;
  priceCents: number | null;
  active: boolean;
  /** Vazio = todos os profissionais fazem. */
  professionalIds: string[];
}

export type ServiceInput = Omit<ServiceRow, 'id'>;

export interface ProfessionalRow {
  id: string;
  name: string;
  title: string | null;
  active: boolean;
  googleCalendarId: string | null;
  serviceIds: string[];
}

export type ProfessionalInput = Omit<ProfessionalRow, 'id' | 'serviceIds' | 'googleCalendarId'>;

export interface HourInterval {
  opensMin: number;
  closesMin: number;
}

/** Dia da semana (0 = domingo) → intervalos abertos. Dia ausente = fechado. */
export type WeekHours = Partial<Record<number, HourInterval[]>>;

export interface HoursRow extends HourInterval {
  professionalId: string | null;
  weekday: number;
}

export interface TimeOffRow {
  id: string;
  professionalId: string | null;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

export type TimeOffInput = Omit<TimeOffRow, 'id'>;

export type PhoneKind = 'whatsapp' | 'test';

export interface PhoneRow {
  id: string;
  metaPhoneNumberId: string;
  displayPhone: string;
  status: 'active' | 'disabled';
  kind: PhoneKind;
  metaAccountId: string | null;
  createdAt: string;
}

export interface NewPhone {
  metaAccountId: string;
  metaPhoneNumberId: string;
  displayPhone: string;
}

export interface ChannelRow {
  id: string;
  label: string | null;
  active: boolean;
  linkedAt: string | null;
  linkExpiresAt: string | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  contactId: string;
  waId: string;
  contactName: string | null;
  status: 'bot' | 'human';
  pausedUntil: string | null;
  lastCustomerMsgAt: string | null;
  updatedAt: string;
  phoneKind: PhoneKind;
  displayPhone: string;
}

export interface TranscriptMessage {
  id: string;
  direction: 'in' | 'out';
  author: MessageAuthor;
  kind: string;
  body: string;
  createdAt: string;
}

export interface UsageRow {
  phoneNumberId: string;
  displayPhone: string;
  kind: PhoneKind;
  month: string;
  msgsIn: number;
  repliesOut: number;
  msgsDelivered: number;
  msgsFailed: number;
  serviceBilled: number;
  templatesUtility: number;
  templatesMarketing: number;
  templatesAuth: number;
  llmRequests: number;
  tokensIn: number;
  tokensOut: number;
  sttSeconds: number;
  estCostUsdMicros: number;
}

/** Linha do medidor com o nome da empresa (visão do operador). */
export interface OpsUsageRow extends UsageRow {
  tenantId: string;
  tenantName: string;
}

export interface MetaAccountRow {
  id: string;
  wabaId: string;
  hasToken: boolean;
  numbers: number;
  createdAt: string;
}

export interface LlmUsageRow {
  provider: string;
  model: string;
  requests: number;
  tokens: number;
}

/** Contagens para a lista de configuração da empresa. */
export interface TenantOverview {
  services: number;
  professionals: number;
  hours: number;
  numbers: number;
  channels: number;
  testMessages: number;
  agentReady: boolean;
}

export interface AdminTenantRepo {
  readonly tenantId: string;
  getTenant(): Promise<TenantSettings | null>;
  updateTenant(update: TenantUpdate): Promise<void>;
  setGoogleCalendar(calendarId: string | null): Promise<void>;
  overview(): Promise<TenantOverview>;

  /** Atendente da empresa (o primeiro criado; vale para todos os números). */
  getAgent(): Promise<AgentSettings | null>;
  updateAgent(id: string, update: AgentUpdate): Promise<boolean>;

  listServices(): Promise<ServiceRow[]>;
  /** Cria (id null) ou altera um serviço, com quem faz. Devolve o id. */
  saveService(id: string | null, input: ServiceInput): Promise<string | null>;

  listProfessionals(): Promise<ProfessionalRow[]>;
  /** "Quem faz" cada serviço se edita só no serviço (vazio = todos). */
  saveProfessional(id: string | null, input: ProfessionalInput): Promise<string | null>;
  setProfessionalCalendar(id: string, calendarId: string | null): Promise<void>;

  listHours(): Promise<HoursRow[]>;
  /** Troca o horário da casa (professionalId null) ou de um profissional. */
  replaceHours(professionalId: string | null, week: WeekHours): Promise<void>;

  listTimeOff(fromIso: string): Promise<TimeOffRow[]>;
  addTimeOff(input: TimeOffInput): Promise<string | null>;
  deleteTimeOff(id: string): Promise<void>;

  getRules(): Promise<SchedulingRules | null>;
  saveRules(rules: SchedulingRules): Promise<void>;

  listPhones(): Promise<PhoneRow[]>;
  /** false se o número da Meta já estiver em uso (em qualquer empresa). */
  addPhone(phone: NewPhone, now: string): Promise<boolean>;
  setPhoneStatus(id: string, status: PhoneRow['status']): Promise<void>;

  listChannels(): Promise<ChannelRow[]>;
  createChannelLink(label: string | null, code: string, expiresAt: string, now: string): Promise<void>;
  /** Remove o canal (e o chat cifrado). Para voltar, gera-se outro link. */
  removeChannel(id: string): Promise<void>;

  listConversations(sinceIso: string): Promise<ConversationSummary[]>;
  getConversation(id: string): Promise<{ summary: ConversationSummary; messages: TranscriptMessage[] } | null>;
  /** Conversa do chat de teste do painel (número simulador). */
  testConversation(): Promise<{ summary: ConversationSummary; messages: TranscriptMessage[] } | null>;

  listUsage(fromMonth: string): Promise<UsageRow[]>;
}

export interface AdminOpsRepo {
  listTenants(): Promise<TenantSummary[]>;
  /** Empresa nova com o número simulador, o atendente e as regras padrão. */
  createTenant(input: NewTenant, now: string): Promise<string>;
  listMetaAccounts(): Promise<MetaAccountRow[]>;
  listUsage(month: string): Promise<OpsUsageRow[]>;
  llmUsage(day: string): Promise<LlmUsageRow[]>;
}

export interface AdminRepo {
  forTenant(tenantId: string): AdminTenantRepo;
  readonly ops: AdminOpsRepo;
}
