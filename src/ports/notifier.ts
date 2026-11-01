// Avisos para a equipe da empresa (passagem para humano) e para o operador.

export type HandoffReason = 'customer_request' | 'unknown_answer' | 'sensitive' | 'scheduling' | 'technical_failure';

export interface HandoffRequest {
  tenantId: string;
  tenantName: string;
  conversationId: string;
  waId: string;
  contactName: string | null;
  reason: HandoffReason;
  /** Resumo escrito pela IA (null quando a passagem veio da rede de segurança). */
  summary: string | null;
  /** Últimas mensagens do cliente, da mais antiga para a mais nova. */
  recentCustomerMessages: string[];
}

export interface RelayRequest {
  tenantId: string;
  tenantName: string;
  conversationId: string;
  waId: string;
  contactName: string | null;
  messages: string[];
}

/** Agendamento criado, remarcado ou cancelado (aviso à equipe). */
export interface BookingNotice {
  tenantId: string;
  tenantName: string;
  conversationId: string;
  waId: string;
  contactName: string | null;
  change: 'created' | 'rescheduled' | 'cancelled';
  serviceName: string;
  professionalLabel: string;
  /** Já formatado no fuso da empresa ("terça-feira, 14/10 às 15:00"). */
  when: string;
  code: string;
}

export interface HandoffNotifier {
  /** Aviso de agendamento à equipe (a resposta do dono chega ao cliente). */
  notifyBooking(notice: BookingNotice): Promise<number>;
  /** Avisa a equipe. Devolve quantos canais receberam (0 = ninguém foi avisado). */
  notifyHandoff(req: HandoffRequest): Promise<number>;
  /** Repassa mensagens do cliente enquanto a conversa está com a equipe. */
  relayCustomerMessages(req: RelayRequest): Promise<number>;
}

export interface OperatorNotifier {
  /**
   * Alerta para o operador (você). `kind` identifica o tipo de alerta para
   * não repetir o mesmo aviso em sequência.
   */
  notifyOperator(kind: string, text: string): Promise<void>;
}
