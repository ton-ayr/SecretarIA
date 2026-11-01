import { OPERATOR_CHAT_KEY, OPERATOR_LINK_KEY } from '../adapters/telegram-notifier.ts';
import { telegramChatRef, type TelegramClient } from '../adapters/telegram.ts';
import type { HumanReplyStatus } from '../core/conversation-flow.ts';
import { TELEGRAM_TEXTS } from '../core/team-messages.ts';
import type { Repo } from '../ports/repo.ts';
import type { Clock, Logger } from '../ports/runtime.ts';
import { encryptSecret } from '../shared/crypto.ts';
import { constantTimeEqual } from '../shared/signature.ts';

/**
 * Atualizações do Telegram (POST /telegram/webhook), ARQUITETURA §9:
 *  - "/start <código>": vincula o chat a uma empresa (ou ao operador);
 *  - "Responder" numa mensagem do bot: envia o texto ao cliente pelo WhatsApp;
 *  - botão "Devolver ao bot": a conversa volta a ser atendida pelo bot.
 * A conversa é sempre achada pela mensagem respondida (telegram_relays) e
 * pelo chat que respondeu: um chat de outra empresa nunca chega nela.
 */
export interface TelegramWebhookDeps {
  secret: string;
  encryptionKey: string;
  logger: Logger;
  clock: Clock;
  repo: Repo;
  tg: Pick<TelegramClient, 'sendMessage' | 'answerCallbackQuery' | 'removeKeyboard' | 'react'>;
  humanReply(tenantId: string, conversationId: string, text: string): Promise<HumanReplyStatus | 'not_found'>;
  resume(tenantId: string, conversationId: string): Promise<boolean>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Confere o cabeçalho secreto definido no setWebhook. */
export function isTelegramRequestValid(secret: string, header: string | null | undefined): boolean {
  return Boolean(secret) && typeof header === 'string' && constantTimeEqual(header, secret);
}

export async function handleTelegramUpdate(update: unknown, deps: TelegramWebhookDeps): Promise<void> {
  if (!isObj(update)) return;
  if (isObj(update.callback_query)) return handleCallback(update.callback_query, deps);
  if (isObj(update.message)) return handleMessage(update.message, deps);
}

async function handleMessage(msg: Json, deps: TelegramWebhookDeps): Promise<void> {
  const chat = isObj(msg.chat) ? msg.chat : null;
  const chatId = num(chat?.id);
  // Só conversas privadas com o bot (grupos ficam para depois).
  if (chatId === null || chat?.type !== 'private') return;
  const text = typeof msg.text === 'string' ? msg.text.trim() : '';

  if (text.startsWith('/start')) {
    const payload = text.slice('/start'.length).trim();
    if (payload.startsWith('op_')) return linkOperator(chatId, payload.slice(3), deps);
    if (payload) return linkTenantChannel(chatId, payload, deps);
  }

  const replyTo = isObj(msg.reply_to_message) ? num(msg.reply_to_message.message_id) : null;
  if (replyTo !== null && !text.startsWith('/')) return relayTeamReply(chatId, num(msg.message_id), replyTo, text, deps);

  const ref = await telegramChatRef(deps.encryptionKey, chatId);
  const linked = await deps.repo.isChatLinked(ref);
  await deps.tg.sendMessage(chatId, linked ? TELEGRAM_TEXTS.howToReply : TELEGRAM_TEXTS.notLinked);
}

async function linkTenantChannel(chatId: number, code: string, deps: TelegramWebhookDeps): Promise<void> {
  const { repo, clock, encryptionKey, tg, logger } = deps;
  const now = clock.now().toISOString();
  const channel = await repo.findChannelByLinkCode(code, now);
  if (!channel) {
    await tg.sendMessage(chatId, TELEGRAM_TEXTS.invalidLink);
    return;
  }
  const ok = await repo
    .forTenant(channel.tenantId)
    .linkChannel(
      channel.channelId,
      await encryptSecret(encryptionKey, String(chatId)),
      await telegramChatRef(encryptionKey, chatId),
      now,
    );
  logger.info('telegram_channel_linked', { tenant_id: channel.tenantId, channel_id: channel.channelId, ok });
  await tg.sendMessage(chatId, ok ? TELEGRAM_TEXTS.linked(channel.tenantName) : TELEGRAM_TEXTS.invalidLink);
}

async function linkOperator(chatId: number, code: string, deps: TelegramWebhookDeps): Promise<void> {
  const { repo, clock, encryptionKey, tg, logger } = deps;
  const now = clock.now();
  const stored = await repo.ops.getSetting(OPERATOR_LINK_KEY);
  const [expected, expiresAt] = (stored ?? '').split('|');
  const valid = Boolean(expected && expiresAt && constantTimeEqual(code, expected) && Date.parse(expiresAt) > now.getTime());
  if (!valid) {
    await tg.sendMessage(chatId, TELEGRAM_TEXTS.invalidLink);
    return;
  }
  await repo.ops.setSetting(OPERATOR_CHAT_KEY, await encryptSecret(encryptionKey, String(chatId)), now.toISOString());
  await repo.ops.deleteSetting(OPERATOR_LINK_KEY);
  logger.info('telegram_operator_linked');
  await tg.sendMessage(chatId, TELEGRAM_TEXTS.operatorLinked);
}

async function relayTeamReply(
  chatId: number,
  messageId: number | null,
  replyTo: number,
  text: string,
  deps: TelegramWebhookDeps,
): Promise<void> {
  const { repo, encryptionKey, tg, logger } = deps;
  const ref = await telegramChatRef(encryptionKey, chatId);
  const relay = await repo.findTelegramRelay(ref, replyTo);
  if (!relay) {
    await tg.sendMessage(chatId, TELEGRAM_TEXTS.relayNotFound);
    return;
  }
  if (!(await repo.forTenant(relay.tenantId).isChannelActive(ref))) {
    await tg.sendMessage(chatId, TELEGRAM_TEXTS.chatUnlinked);
    return;
  }
  if (!text) {
    await tg.sendMessage(chatId, TELEGRAM_TEXTS.onlyText);
    return;
  }

  const status = await deps.humanReply(relay.tenantId, relay.conversationId, text.slice(0, 4096));
  logger.info('telegram_team_reply', { tenant_id: relay.tenantId, conversation_id: relay.conversationId, status });
  if (status === 'sent') {
    // Confirmação discreta: 👍 na mensagem do dono.
    if (messageId !== null) await tg.react(chatId, messageId, '👍').catch(() => undefined);
    return;
  }
  await tg.sendMessage(chatId, status === 'window_closed' ? TELEGRAM_TEXTS.windowClosed : TELEGRAM_TEXTS.sendFailed);
}

async function handleCallback(cq: Json, deps: TelegramWebhookDeps): Promise<void> {
  const { repo, encryptionKey, tg, logger } = deps;
  const id = typeof cq.id === 'string' ? cq.id : null;
  if (!id) return;
  const message = isObj(cq.message) ? cq.message : null;
  const chatId = num(isObj(message?.chat) ? message.chat.id : null);
  const messageId = num(message?.message_id);
  if (cq.data !== 'resume' || chatId === null || messageId === null) {
    await tg.answerCallbackQuery(id);
    return;
  }
  // A conversa vem da mensagem do botão, não do conteúdo do botão.
  const ref = await telegramChatRef(encryptionKey, chatId);
  const relay = await repo.findTelegramRelay(ref, messageId);
  if (!relay || !(await repo.forTenant(relay.tenantId).isChannelActive(ref))) {
    await tg.answerCallbackQuery(id, TELEGRAM_TEXTS.conversationNotFound);
    return;
  }
  const ok = await deps.resume(relay.tenantId, relay.conversationId);
  logger.info('telegram_resume', { tenant_id: relay.tenantId, conversation_id: relay.conversationId, ok });
  await tg.answerCallbackQuery(id, ok ? TELEGRAM_TEXTS.resumed : TELEGRAM_TEXTS.conversationNotFound);
  if (ok) await tg.removeKeyboard(chatId, messageId).catch(() => undefined);
}
