import type { HumanReplyRecord } from '../ports/repo.ts';
import type { Clock, Logger, LogFields } from '../ports/runtime.ts';
import type { MediaFetcher, Transcriber } from '../ports/transcriber.ts';
import { WhatsAppError, type WhatsAppSender } from '../ports/whatsapp.ts';
import { ulid } from '../shared/ids.ts';
import { monthKey } from '../shared/time.ts';
import { MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, oggDurationSec } from './audio.ts';
import type { InboundMessage, SttUsage, SummaryJob, TurnInput, TurnResult } from './engine.ts';
import type { PostJob } from './scheduling.ts';
import { buildButtonsMessage, buildListMessage } from './interactive.ts';
import { RATE_LIMIT_REPLY } from './texts.ts';
import { isServiceWindowOpen } from './window.ts';

/**
 * Fluxo de UMA conversa (um número da empresa + um cliente). Roda dentro do
 * Durable Object `Conversation`, que garante uma execução por vez, mas não
 * depende da Cloudflare: o armazenamento entra pela interface InboxStore.
 *
 * Caminho (ARQUITETURA §3):
 *  enqueue → reentrega? limite por hora? → caixa de entrada → alarme
 *  alarme  → áudio vira texto → motor → janela de 24h → envio → status
 * E, vindo do Telegram: resposta da equipe e "devolver ao bot".
 */

export interface InboxItem {
  waMessageId: string;
  kind: string;
  text: string;
  /** ISO 8601 UTC (horário da Meta). */
  at: string;
  profileName: string | null;
  /** Mídia a baixar (áudio é transcrito). */
  mediaId?: string | null;
  mime?: string | null;
  /** Opção tocada (lista ou botão). */
  replyId?: string | null;
}

/** Armazenamento do objeto (SQLite do Durable Object). Métodos síncronos. */
export interface InboxStore {
  /** Registra o ID; false se já tinha sido visto (reentrega da Meta). */
  markSeen(waMessageId: string, nowMs: number): boolean;
  pruneSeen(beforeMs: number): void;
  /** Soma 1 no contador da hora e devolve o total. */
  incrementRate(hourKey: number): number;
  push(item: InboxItem, receivedAtMs: number): void;
  /** Itens ainda não pegos por um turno, em ordem de chegada. */
  pending(): Array<InboxItem & { receivedAtMs: number }>;
  /** Marca os itens como pegos pelo turno. */
  take(waMessageIds: string[], turnTag: string): void;
  /** Devolve à fila itens pegos por um turno que não terminou. */
  releaseTaken(): void;
  remove(waMessageIds: string[]): void;
  getState(key: string): string | null;
  setState(key: string, value: string | null): void;
}

export interface FlowConfig {
  /** Espera depois da última mensagem antes de responder (agrupamento). */
  debounceMs: number;
  /** Espera máxima contada da primeira mensagem pendente. */
  maxWaitMs: number;
  rateLimitPerHour: number;
  /** Por quanto tempo lembrar IDs já vistos. */
  seenTtlMs: number;
}

export const DEFAULT_FLOW_CONFIG: FlowConfig = {
  debounceMs: 5_000,
  maxWaitMs: 20_000,
  rateLimitPerHour: 30,
  seenTtlMs: 7 * 24 * 60 * 60 * 1000,
};

export interface FlowDeps {
  store: InboxStore;
  engine: {
    handleTurn(input: TurnInput): Promise<TurnResult>;
    runSummary(job: SummaryJob): Promise<boolean>;
    runPostJobs?(jobs: PostJob[]): Promise<void>;
  };
  sender: WhatsAppSender;
  /** Liga a resposta ao wamid, para os status de entrega. */
  markSent(tenantId: string, messageId: string, waMessageId: string): Promise<void>;
  /** Áudio: download e transcrição. Sem eles, áudio recebe resposta fixa. */
  media?: MediaFetcher;
  transcriber?: Transcriber;
  /** Gravação das ações da equipe (vindas do Telegram). */
  conversations?: {
    saveHumanReply(tenantId: string, record: HumanReplyRecord): Promise<void>;
    resumeBot(tenantId: string, conversationId: string, now: string): Promise<void>;
  };
  /** Alerta ao operador (ex.: token da Meta recusado). */
  alertOperator?: (kind: string, text: string) => Promise<void>;
  clock: Clock;
  logger: Logger;
  config?: Partial<FlowConfig>;
}

export interface Route {
  metaPhoneNumberId: string;
  waId: string;
}

export interface EnqueueResult {
  accepted: number;
  duplicates: number;
  /** Quando o alarme deve disparar (null = nada a fazer). */
  alarmAt: number | null;
  /** Mensagem para marcar como lida + "digitando…" (null = não mostrar). */
  typingFor: string | null;
  /** Mandar o aviso de limite por hora (uma vez por hora). */
  rateNotice: boolean;
}

export interface HumanReplyInput {
  tenantId: string;
  conversationId: string;
  /** phone_numbers.id (medidor). */
  phoneNumberId: string;
  text: string;
  lastCustomerMsgAt: string | null;
  /** Horas até o bot voltar sozinho, contadas desta resposta. */
  resumeHours: number;
  route: Route;
}

export type HumanReplyStatus = 'sent' | 'window_closed' | 'failed';

const STATE = {
  route: 'route',
  sending: 'sending',
  pausedUntil: 'paused_until',
  rateNotified: 'rate_notified_hour',
  /** Última mensagem do cliente ou da equipe (ms). Base para esquecer o objeto. */
  lastActivity: 'last_activity',
} as const;

const HOUR_MS = 60 * 60 * 1000;
const STT_TIMEOUT_MS = 30_000;

export class ConversationFlow {
  private readonly cfg: FlowConfig;

  constructor(private readonly deps: FlowDeps) {
    this.cfg = { ...DEFAULT_FLOW_CONFIG, ...deps.config };
  }

  /** Recebe mensagens do webhook. Rápido: só grava e agenda. */
  enqueue(route: Route, items: InboxItem[]): EnqueueResult {
    const { store, clock } = this.deps;
    const now = clock.now().getTime();
    store.setState(STATE.route, JSON.stringify(route));
    store.setState(STATE.lastActivity, String(now));
    store.pruneSeen(now - this.cfg.seenTtlMs);

    const result: EnqueueResult = { accepted: 0, duplicates: 0, alarmAt: null, typingFor: null, rateNotice: false };
    const hour = Math.floor(now / HOUR_MS);
    for (const item of items) {
      if (!store.markSeen(item.waMessageId, now)) {
        result.duplicates++;
        continue;
      }
      if (store.incrementRate(hour) > this.cfg.rateLimitPerHour) {
        if (store.getState(STATE.rateNotified) !== String(hour)) {
          store.setState(STATE.rateNotified, String(hour));
          result.rateNotice = true;
        }
        continue;
      }
      store.push(item, now);
      result.accepted++;
      result.typingFor = item.waMessageId;
    }

    const pending = store.pending();
    if (pending.length > 0) {
      const first = pending[0]!.receivedAtMs;
      result.alarmAt = Math.min(now + this.cfg.debounceMs, first + this.cfg.maxWaitMs);
    }
    // "Digitando…" só quando haverá resposta (pedido da Meta).
    if (this.isPaused(now)) result.typingFor = null;
    return result;
  }

  /** Processa um turno com tudo que está pendente. Chamado pelo alarme. */
  async process(): Promise<{ nextAlarmAt: number | null }> {
    const { store, clock, logger } = this.deps;
    const route = this.route();
    if (!route) return { nextAlarmAt: null };

    // Se uma execução anterior caiu no meio do envio, não reenvia: é melhor
    // não responder do que mandar a mesma mensagem duas vezes.
    const sending = store.getState(STATE.sending);
    if (sending) {
      const { ids } = JSON.parse(sending) as { ids: string[] };
      store.remove(ids);
      store.setState(STATE.sending, null);
      logger.warn('send_uncertain_skipped', { meta_phone_number_id: route.metaPhoneNumberId, messages: ids.length });
    }
    // Itens pegos por um turno que caiu antes de enviar voltam para a fila.
    store.releaseTaken();

    const items = store.pending();
    if (items.length === 0) return { nextAlarmAt: null };
    const ids = items.map((i) => i.waMessageId);
    const turnTag = String(clock.now().getTime());
    store.take(ids, turnTag);

    const { messages, stt } = await this.prepareMessages(route, items);

    // Se o motor lançar erro (ex.: D1 fora do ar), o alarme tenta de novo.
    const result = await this.deps.engine.handleTurn({
      metaPhoneNumberId: route.metaPhoneNumberId,
      waId: route.waId,
      profileName: items.findLast((i) => i.profileName)?.profileName ?? null,
      messages,
      stt,
    });

    const logBase: LogFields = { turn_id: result.turnId, tenant_id: result.tenantId };
    store.setState(STATE.pausedUntil, result.pausedUntil);

    if (result.reply && result.replyMessageId && result.tenantId) {
      const lastAt = items.reduce((max, i) => (i.at > max ? i.at : max), items[0]!.at);
      if (!isServiceWindowOpen(lastAt, clock.now())) {
        logger.warn('send_skipped_window_closed', logBase);
      } else {
        store.setState(STATE.sending, JSON.stringify({ ids, turnTag }));
        await this.send(route, result.tenantId, result.replyMessageId, result, logBase);
        store.setState(STATE.sending, null);
      }
    }
    store.remove(ids);

    // Agenda Google e aviso à equipe: depois do envio, sem atrasar o cliente.
    if (result.postJobs.length && this.deps.engine.runPostJobs) {
      try {
        await this.deps.engine.runPostJobs(result.postJobs);
      } catch {
        logger.warn('post_jobs_failed', logBase);
      }
    }

    if (result.summaryJob) {
      try {
        await this.deps.engine.runSummary(result.summaryJob);
      } catch {
        logger.warn('summary_failed', logBase);
      }
    }

    const remaining = store.pending();
    return { nextAlarmAt: remaining.length ? clock.now().getTime() + this.cfg.debounceMs : null };
  }

  /**
   * Áudio vira texto antes do motor: baixa da Meta, confere a duração (até
   * 2 minutos) e transcreve. Sem transcrição, o motor responde texto fixo.
   */
  private async prepareMessages(
    route: Route,
    items: InboxItem[],
  ): Promise<{ messages: InboundMessage[]; stt: SttUsage[] }> {
    const stt: SttUsage[] = [];
    const messages: InboundMessage[] = [];
    // Em sequência: são poucos áudios por turno e o objeto processa um por vez.
    for (const item of items) {
      const msg: InboundMessage = {
        text: item.text,
        waMessageId: item.waMessageId,
        at: item.at,
        kind: item.kind,
        replyId: item.replyId ?? null,
      };
      if (item.kind === 'audio' && item.mediaId) {
        const audio = await this.transcribeAudio(route, item.mediaId, item.mime ?? null);
        if (audio.usage) stt.push(audio.usage);
        if (audio.text) msg.text = audio.text;
        if (audio.note) msg.mediaNote = audio.note;
      }
      messages.push(msg);
    }
    return { messages, stt };
  }

  /** Um áudio: download, duração (até 2 min) e transcrição. */
  private async transcribeAudio(
    route: Route,
    mediaId: string,
    mime: string | null,
  ): Promise<{ text?: string; note?: 'too_long' | 'failed'; usage?: SttUsage }> {
    const { media, transcriber, logger } = this.deps;
    if (!media || !transcriber) return {};
    try {
      const file = await media.download(route.metaPhoneNumberId, mediaId, MAX_AUDIO_BYTES);
      const fileSeconds = oggDurationSec(file.bytes);
      if (fileSeconds !== null && fileSeconds > MAX_AUDIO_SECONDS) return { note: 'too_long' };

      const tr = await transcriber.transcribe(file.bytes, mime ?? file.mime, { language: 'pt', timeoutMs: STT_TIMEOUT_MS });
      const seconds = tr.durationSec ?? fileSeconds ?? 0;
      const usage: SttUsage = { seconds: Math.ceil(seconds), provider: tr.provider, model: tr.model };
      if (seconds > MAX_AUDIO_SECONDS) return { note: 'too_long', usage };
      return tr.text ? { text: tr.text, usage } : { note: 'failed', usage };
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      logger.warn('audio_not_transcribed', { meta_phone_number_id: route.metaPhoneNumberId, error_code: name });
      return { note: name === 'MediaTooLargeError' ? 'too_long' : 'failed' };
    }
  }

  /** Resposta da equipe (pelo Telegram) enviada ao cliente pelo mesmo número. */
  async sendHumanReply(input: HumanReplyInput): Promise<HumanReplyStatus> {
    const { store, sender, clock, logger, conversations } = this.deps;
    const now = clock.now();
    const logBase: LogFields = { tenant_id: input.tenantId, conversation_id: input.conversationId };
    store.setState(STATE.route, JSON.stringify(input.route));

    if (!isServiceWindowOpen(input.lastCustomerMsgAt, now)) {
      logger.warn('human_reply_window_closed', logBase);
      return 'window_closed';
    }
    let waMessageId: string;
    try {
      waMessageId = (await sender.sendText(input.route.metaPhoneNumberId, input.route.waId, input.text)).waMessageId;
    } catch (err) {
      await this.handleSendError(err, logBase);
      return err instanceof WhatsAppError && err.kind === 'window_closed' ? 'window_closed' : 'failed';
    }

    // A mensagem já saiu: daqui em diante, erro só vai para o log (não
    // devolver "falhou", senão a equipe reenviaria e o cliente receberia duas).
    const pausedUntil = new Date(now.getTime() + input.resumeHours * HOUR_MS).toISOString();
    store.setState(STATE.pausedUntil, pausedUntil);
    store.setState(STATE.lastActivity, String(now.getTime()));
    try {
      await conversations?.saveHumanReply(input.tenantId, {
        conversationId: input.conversationId,
        phoneNumberId: input.phoneNumberId,
        messageId: ulid(now.getTime()),
        body: input.text,
        waMessageId,
        now: now.toISOString(),
        month: monthKey(now),
        pausedUntil,
      });
    } catch (err) {
      logger.error('human_reply_save_failed', { ...logBase, error_code: err instanceof Error ? err.name : 'unknown' });
    }
    logger.info('human_reply_sent', logBase);
    return 'sent';
  }

  /** Botão "Devolver ao bot". */
  async resume(tenantId: string, conversationId: string): Promise<void> {
    const { store, clock, logger, conversations } = this.deps;
    await conversations?.resumeBot(tenantId, conversationId, clock.now().toISOString());
    store.setState(STATE.pausedUntil, null);
    logger.info('conversation_resumed_by_team', { tenant_id: tenantId, conversation_id: conversationId });
  }

  /**
   * O objeto pode esquecer tudo (LGPD)? Só sem nada pendente, sem pausa em
   * andamento e sem mensagem há `idleMs`. O que ele guarda (rota com o
   * telefone, IDs vistos, contador) não serve para mais nada depois disso.
   */
  canForget(idleMs: number): boolean {
    const { store, clock } = this.deps;
    if (store.pending().length > 0 || store.getState(STATE.sending)) return false;
    const now = clock.now().getTime();
    const until = store.getState(STATE.pausedUntil);
    if (until && Date.parse(until) > now) return false;
    return now - Number(store.getState(STATE.lastActivity) ?? 0) >= idleMs;
  }

  /** Aviso de limite por hora: texto fixo, sem IA. */
  async sendRateNotice(): Promise<void> {
    const route = this.route();
    if (!route) return;
    try {
      await this.deps.sender.sendText(route.metaPhoneNumberId, route.waId, RATE_LIMIT_REPLY);
      this.deps.logger.warn('rate_limited', { meta_phone_number_id: route.metaPhoneNumberId });
    } catch (err) {
      await this.handleSendError(err, { meta_phone_number_id: route.metaPhoneNumberId });
    }
  }

  async showTyping(waMessageId: string): Promise<void> {
    const route = this.route();
    if (!route) return;
    try {
      await this.deps.sender.markReadWithTyping(route.metaPhoneNumberId, waMessageId);
    } catch (err) {
      // Só cosmético: não atrapalha a resposta.
      await this.handleSendError(err, { meta_phone_number_id: route.metaPhoneNumberId, step: 'typing' });
    }
  }

  private async send(
    route: Route,
    tenantId: string,
    messageId: string,
    result: TurnResult,
    logBase: LogFields,
  ): Promise<void> {
    const { sender, logger } = this.deps;
    const reply = result.reply!;
    try {
      // Botões > lista > texto. Se não couber nos limites da Meta, vai texto.
      const buttons = buildButtonsMessage(reply);
      const list = buttons ? null : buildListMessage(reply);
      const sent = buttons
        ? await sender.sendButtons(route.metaPhoneNumberId, route.waId, buttons)
        : list
          ? await sender.sendList(route.metaPhoneNumberId, route.waId, list)
          : await sender.sendText(route.metaPhoneNumberId, route.waId, reply.text);
      logger.info('reply_sent', { ...logBase, interactive: Boolean(buttons ?? list) });
      try {
        await this.deps.markSent(tenantId, messageId, sent.waMessageId);
      } catch (err) {
        // A mensagem saiu; só o status de entrega fica sem ligação.
        logger.error('mark_sent_failed', { ...logBase, error_code: err instanceof Error ? err.name : 'unknown' });
      }
    } catch (err) {
      // Não lança: o alarme tentaria de novo e poderia duplicar a mensagem.
      await this.handleSendError(err, logBase);
    }
  }

  private async handleSendError(err: unknown, fields: LogFields): Promise<void> {
    const { logger, alertOperator } = this.deps;
    if (!(err instanceof WhatsAppError)) {
      logger.error('whatsapp_send_failed', { ...fields, error_code: 'internal' });
      return;
    }
    logger.error('whatsapp_send_failed', {
      ...fields,
      error_code: err.kind,
      http_status: err.status ?? null,
      meta_code: err.metaCode ?? null,
    });
    if (err.kind === 'auth') {
      try {
        await alertOperator?.(
          'whatsapp_auth',
          '⚠️ A Meta recusou o token do WhatsApp. Gere um token novo do usuário do sistema e rode: npm run meta -- conta --waba <WABA_ID> --remote',
        );
      } catch {
        // alerta é melhor esforço
      }
    }
  }

  private route(): Route | null {
    const raw = this.deps.store.getState(STATE.route);
    return raw ? (JSON.parse(raw) as Route) : null;
  }

  private isPaused(nowMs: number): boolean {
    const until = this.deps.store.getState(STATE.pausedUntil);
    return until !== null && Date.parse(until) > nowMs;
  }
}
