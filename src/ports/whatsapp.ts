/** Lista interativa já validada contra os limites da Meta. */
export interface ListMessage {
  body: string;
  button: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}

/** Mensagem com até 3 botões de resposta, já validada. */
export interface ButtonsMessage {
  body: string;
  buttons: Array<{ id: string; title: string }>;
}

/** Template aprovado pela Meta (fora da janela de 24 h; cobrado). */
export interface TemplateMessage {
  name: string;
  language: string;
  bodyParams: string[];
  /** Payload de cada botão de resposta rápida, na ordem do template. */
  quickReplyPayloads: string[];
}

/** Envio pela WhatsApp Cloud API. `from` é o phone_number_id da Meta. */
export interface WhatsAppSender {
  sendText(from: string, to: string, body: string): Promise<SendResult>;
  sendList(from: string, to: string, list: ListMessage): Promise<SendResult>;
  sendButtons(from: string, to: string, message: ButtonsMessage): Promise<SendResult>;
  sendTemplate(from: string, to: string, template: TemplateMessage): Promise<SendResult>;
  /** Marca como lida e mostra "digitando…" (some ao responder ou após 25 s). */
  markReadWithTyping(from: string, waMessageId: string): Promise<void>;
}

export interface SendResult {
  /** wamid da mensagem enviada, usado para casar os status de entrega. */
  waMessageId: string;
}

export type WhatsAppErrorKind = 'auth' | 'window_closed' | 'recipient' | 'rate_limit' | 'server' | 'network' | 'client';

export class WhatsAppError extends Error {
  constructor(
    readonly kind: WhatsAppErrorKind,
    message: string,
    readonly status?: number,
    /** Código de erro da Meta (ex.: 131047, 131030, 190). */
    readonly metaCode?: number,
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }
}
