// Contrato entre o painel (Worker "admin") e o bot: um RPC por service binding
// (named entrypoint AdminRpc). Não tem endereço público. Os segredos (Meta,
// Google, Telegram, IA, ENCRYPTION_KEY) ficam só no bot; o painel não guarda
// nenhum.

export interface TestTurnInput {
  /** Texto digitado no chat de teste. */
  text?: string;
  /** Opção tocada (lista ou botão) devolvida numa resposta anterior. */
  replyId?: string;
  /** Título da opção tocada (aparece como mensagem do cliente). */
  title?: string;
}

export interface TestReply {
  text: string;
  options?: Array<{ id: string; title: string; description?: string }>;
  listButton?: string;
  buttons?: Array<{ id: string; title: string }>;
}

export interface TestTurnResult {
  outcome: string;
  reply: TestReply | null;
  /** Agenda: booked, rescheduled, cancelled… */
  action: string | null;
  /** O bot passou para a equipe (no teste, ninguém é avisado). */
  handoff: boolean;
  errorCode: string | null;
}

/** Resultado do teste de acesso à agenda Google da empresa. */
export interface CalendarCheck {
  read: boolean;
  write: boolean;
  /** Bloqueios encontrados nos próximos 7 dias (se a leitura funcionou). */
  busy: number;
  /** Mensagem curta para o operador, em pt-BR. */
  problem: string | null;
}

export interface ErasureReport {
  contacts: number;
  conversations: number;
  messages: number;
  appointments: number;
  calendarEvents: number;
  calendarFailures: number;
  stateWipeFailures: number;
}

export interface MetaNumber {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: string;
  codeVerificationStatus: string;
}

export interface BotAdminApi {
  testTurn(tenantId: string, input: TestTurnInput): Promise<TestTurnResult>;
  /** Apaga a conversa de teste (e os horários marcados nela). */
  resetTest(tenantId: string): Promise<void>;
  /** "Reativar bot" numa conversa que está com a equipe. */
  resumeConversation(tenantId: string, conversationId: string): Promise<boolean>;
  /** Exclusão dos dados de um contato (LGPD). */
  eraseContact(tenantId: string, waId: string): Promise<ErasureReport>;
  /** Grava (cifrado) o token de uma conta Meta. */
  saveMetaAccount(wabaId: string, token: string): Promise<void>;
  /** Números da conta Meta, direto da Graph API. */
  listMetaNumbers(metaAccountId: string): Promise<{ numbers: MetaNumber[] } | { error: string }>;
  checkCalendar(calendarId: string): Promise<CalendarCheck>;
  /** E-mail da conta de serviço do Google (para compartilhar a agenda). */
  googleServiceAccount(): Promise<string | null>;
  /** @usuario do bot do Telegram (para o link de vínculo). */
  telegramBotUsername(): Promise<string | null>;
}
