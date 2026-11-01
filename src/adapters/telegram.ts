import { keyedRef } from '../shared/crypto.ts';

/**
 * Cliente mínimo da Telegram Bot API (verificado em 2026-10-03, ARQUITETURA
 * §16). Mensagens em HTML; até 4.096 caracteres; ~1 mensagem por segundo
 * por chat.
 */

export class TelegramError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

export interface SendOptions {
  keyboard?: InlineKeyboard;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  parameters?: { retry_after?: number };
}

/** Botão "Devolver ao bot" das mensagens da equipe. */
export const RESUME_KEYBOARD: InlineKeyboard = [[{ text: '↩️ Devolver ao bot', callback_data: 'resume' }]];

/** Referência do chat (HMAC) usada nas buscas; o chat em si fica cifrado. */
export function telegramChatRef(encryptionKey: string, chatId: number | string): Promise<string> {
  return keyedRef(encryptionKey, 'telegram-chat', String(chatId));
}

export class TelegramClient {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
  ) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async sendMessage(chatId: number | string, text: string, opts: SendOptions = {}): Promise<{ messageId: number }> {
    const msg = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(opts.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
    });
    return { messageId: msg.message_id };
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  }

  /** Tira os botões de uma mensagem já enviada. */
  async removeKeyboard(chatId: number | string, messageId: number): Promise<void> {
    await this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  }

  async react(chatId: number | string, messageId: number, emoji: string): Promise<void> {
    await this.call('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    });
  }

  async getMe(): Promise<{ id: number; username: string }> {
    return this.call('getMe', {});
  }

  async setWebhook(url: string, secretToken: string, allowedUpdates: string[]): Promise<void> {
    await this.call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: allowedUpdates,
      drop_pending_updates: true,
    });
  }

  private async call<T>(method: string, payload: unknown, retried = false): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new TelegramError(0, `${method}: falha de rede ou timeout`);
    }
    let body: TelegramResponse<T>;
    try {
      body = (await res.json()) as TelegramResponse<T>;
    } catch {
      throw new TelegramError(res.status, `${method}: resposta inválida`);
    }
    if (body.ok && body.result !== undefined) return body.result;

    const retryAfter = body.parameters?.retry_after;
    // Limite de envio: espera curta e tenta uma vez de novo.
    if (res.status === 429 && !retried && retryAfter !== undefined && retryAfter <= 3) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return this.call<T>(method, payload, true);
    }
    // A descrição do erro não vai para os logs (pode citar o chat).
    throw new TelegramError(res.status, `${method}: HTTP ${res.status}`, retryAfter);
  }
}
