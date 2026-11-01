// Tipos de domínio compartilhados entre o motor e os adaptadores.

export type Segment = 'general' | 'health';
export type PriceMode = 'fixed' | 'from' | 'on_request';
export type MessageAuthor = 'customer' | 'bot' | 'human';

export interface Tenant {
  id: string;
  name: string;
  segment: Segment;
  timezone: string;
  address: string | null;
  remindersEnabled: boolean;
}

export interface Agent {
  id: string;
  name: string;
  tone: string;
  instructions: string;
  knowledgeBase: string;
  bookingTerm: string;
  professionalTerm: string;
  historyMessages: number;
  maxContextTokens: number;
  handoffResumeHours: number;
  maxReplyChars: number;
  promptVersion: number;
}

export interface Professional {
  id: string;
  name: string;
  title: string | null;
}

export interface Service {
  id: string;
  name: string;
  description: string;
  durationMin: number;
  bufferMin: number;
  priceMode: PriceMode;
  priceCents: number | null;
  professionalIds: string[];
}

export interface BusinessHour {
  professionalId: string | null;
  weekday: number;
  opensMin: number;
  closesMin: number;
}

export interface Contact {
  id: string;
  waId: string;
  profileName: string | null;
  displayName: string | null;
}

export interface Conversation {
  id: string;
  status: 'bot' | 'human';
  pausedUntil: string | null;
  lastCustomerMsgAt: string | null;
  summary: string;
  summarizedUntil: string | null;
}

export interface StoredMessage {
  id: string;
  author: MessageAuthor;
  kind: string;
  body: string;
  createdAt: string;
}

/** Tudo que o motor precisa para responder um turno. */
export interface TurnContext {
  tenant: Tenant;
  agent: Agent;
  phoneNumberId: string;
  services: Service[];
  professionals: Professional[];
  hours: BusinessHour[];
  contact: Contact;
  conversation: Conversation;
  /** Mensagens ainda não resumidas, da mais antiga para a mais nova. */
  history: StoredMessage[];
  /** Quantas mensagens existem depois de `summarizedUntil`. */
  unsummarizedCount: number;
  /** Canais de aviso ativos da empresa (0 = não dá para chamar a equipe). */
  handoffChannels: number;
}
