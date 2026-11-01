import { escapeHtml, formatBookingNotice, formatHandoffAlert, formatRelay } from '../core/team-messages.ts';
import type {
  BookingNotice,
  HandoffNotifier,
  HandoffRequest,
  OperatorNotifier,
  RelayRequest,
} from '../ports/notifier.ts';
import type { Repo, TelegramRelay } from '../ports/repo.ts';
import type { Clock, Logger } from '../ports/runtime.ts';
import { decryptSecret } from '../shared/crypto.ts';
import { RESUME_KEYBOARD, TelegramError, telegramChatRef, type TelegramClient } from './telegram.ts';

interface NotifierDeps {
  repo: Repo;
  tg: Pick<TelegramClient, 'sendMessage'>;
  encryptionKey: string;
  clock: Clock;
  logger: Logger;
}

/**
 * Avisos à equipe pelo Telegram. Cada mensagem enviada fica registrada em
 * telegram_relays, ligada à conversa: é assim que a resposta do dono
 * ("responder") volta para o cliente certo.
 */
export class TelegramTeamNotifier implements HandoffNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  notifyHandoff(req: HandoffRequest): Promise<number> {
    return this.sendToTeam(req.tenantId, req.conversationId, formatHandoffAlert(req));
  }

  relayCustomerMessages(req: RelayRequest): Promise<number> {
    return this.sendToTeam(req.tenantId, req.conversationId, formatRelay(req));
  }

  /** Sem botão "Devolver ao bot": o bot segue atendendo. */
  notifyBooking(notice: BookingNotice): Promise<number> {
    return this.sendToTeam(notice.tenantId, notice.conversationId, formatBookingNotice(notice), false);
  }

  private async sendToTeam(tenantId: string, conversationId: string, text: string, withResume = true): Promise<number> {
    const { repo, tg, encryptionKey, clock, logger } = this.deps;
    const tenantRepo = repo.forTenant(tenantId);
    const channels = await tenantRepo.listTelegramChannels();
    const relays: TelegramRelay[] = [];
    for (const ch of channels) {
      try {
        const chatId = await decryptSecret(encryptionKey, ch.targetEnc);
        const { messageId } = await tg.sendMessage(chatId, text, withResume ? { keyboard: RESUME_KEYBOARD } : {});
        relays.push({ chatRef: await telegramChatRef(encryptionKey, chatId), tgMessageId: messageId, conversationId });
      } catch (err) {
        logger.warn('telegram_send_failed', {
          tenant_id: tenantId,
          channel_id: ch.id,
          http_status: err instanceof TelegramError ? err.status : null,
        });
      }
    }
    await tenantRepo.addTelegramRelays(relays, clock.now().toISOString());
    return relays.length;
  }
}

export const OPERATOR_CHAT_KEY = 'operator_telegram_chat';
export const OPERATOR_LINK_KEY = 'operator_link_code';

/**
 * Alertas para o operador no Telegram, no máximo um por tipo a cada
 * `minIntervalMs` (padrão: 1 hora). Nunca leva dado de cliente.
 */
export class TelegramOperatorNotifier implements OperatorNotifier {
  constructor(private readonly deps: NotifierDeps & { minIntervalMs?: number }) {}

  async notifyOperator(kind: string, text: string): Promise<void> {
    const { repo, tg, encryptionKey, clock, logger } = this.deps;
    const sealed = await repo.ops.getSetting(OPERATOR_CHAT_KEY);
    if (!sealed) {
      logger.warn('operator_not_linked', { kind });
      return;
    }
    const now = clock.now();
    const lastKey = `alert_last:${kind}`;
    const last = await repo.ops.getSetting(lastKey);
    if (last && now.getTime() - Date.parse(last) < (this.deps.minIntervalMs ?? 3_600_000)) return;
    await repo.ops.setSetting(lastKey, now.toISOString(), now.toISOString());
    await tg.sendMessage(await decryptSecret(encryptionKey, sealed), escapeHtml(text));
  }
}
