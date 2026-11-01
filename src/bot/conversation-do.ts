import { DurableObject } from 'cloudflare:workers';
import {
  ConversationFlow,
  type HumanReplyInput,
  type HumanReplyStatus,
  type InboxItem,
  type Route,
} from '../core/conversation-flow.ts';
import { systemClock } from '../ports/runtime.ts';
import type { Env } from './env.ts';
import { SqlInboxStore } from './inbox-store.ts';
import {
  createEngine,
  createNotifiers,
  createRepo,
  createSender,
  createTranscriber,
  flowConfig,
  logger,
} from './services.ts';

/**
 * Durable Object `Conversation`: um por número da empresa + cliente
 * (nome "metaPhoneNumberId:waId"). Garante uma conversa processada por vez,
 * idempotência e agrupamento. A lógica fica em ConversationFlow (src/core).
 */
/** Sem mensagens há 8 dias, o objeto apaga o próprio estado (LGPD). */
const IDLE_WIPE_MS = 8 * 24 * 60 * 60 * 1000;

export class ConversationDO extends DurableObject<Env> {
  private store: SqlInboxStore;
  private flowInstance: ConversationFlow | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlInboxStore(ctx.storage.sql);
  }

  private flow(): ConversationFlow {
    if (!this.flowInstance) {
      const repo = createRepo(this.env);
      const sender = createSender(this.env, repo);
      const { operator } = createNotifiers(this.env, repo);
      this.flowInstance = new ConversationFlow({
        store: this.store,
        engine: createEngine(this.env, repo),
        sender,
        media: sender,
        transcriber: createTranscriber(this.env),
        markSent: (tenantId, messageId, waMessageId) => repo.forTenant(tenantId).markSent(messageId, waMessageId),
        conversations: {
          saveHumanReply: (tenantId, record) => repo.forTenant(tenantId).saveHumanReply(record),
          resumeBot: (tenantId, conversationId, now) => repo.forTenant(tenantId).resumeBot(conversationId, now),
        },
        alertOperator: operator ? (kind, text) => operator.notifyOperator(kind, text) : undefined,
        clock: systemClock,
        logger,
        config: flowConfig(this.env),
      });
    }
    return this.flowInstance;
  }

  /** Chamado pelo webhook (RPC). Termina rápido: grava e agenda o alarme. */
  async enqueue(route: Route, items: InboxItem[]): Promise<{ accepted: number; duplicates: number }> {
    const flow = this.flow();
    const r = flow.enqueue(route, items);
    if (r.alarmAt !== null) await this.ctx.storage.setAlarm(r.alarmAt);
    if (r.typingFor) this.ctx.waitUntil(flow.showTyping(r.typingFor));
    if (r.rateNotice) this.ctx.waitUntil(flow.sendRateNotice());
    return { accepted: r.accepted, duplicates: r.duplicates };
  }

  /** Resposta da equipe vinda do Telegram (RPC). */
  async humanReply(input: HumanReplyInput): Promise<HumanReplyStatus> {
    return this.flow().sendHumanReply(input);
  }

  /** Botão "Devolver ao bot" (RPC). */
  async resume(input: { tenantId: string; conversationId: string }): Promise<void> {
    await this.flow().resume(input.tenantId, input.conversationId);
  }

  /** Exclusão de dados do contato pelo painel (RPC). */
  async wipe(): Promise<void> {
    await this.wipeState();
  }

  override async alarm(): Promise<void> {
    const flow = this.flow();
    const { nextAlarmAt } = await flow.process();
    if (nextAlarmAt !== null) {
      await this.ctx.storage.setAlarm(nextAlarmAt);
      return;
    }
    // Nada pendente: esquece tudo depois de 8 dias sem mensagens, senão
    // agenda a próxima conferência.
    if (flow.canForget(IDLE_WIPE_MS)) {
      await this.wipeState();
      logger.info('conversation_state_forgotten');
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + IDLE_WIPE_MS);
  }

  /** Apaga SQL, chave-valor e alarme (data de compatibilidade ≥ 2026-02-24). */
  private async wipeState(): Promise<void> {
    await this.ctx.storage.deleteAll();
    // As tabelas sumiram: recria vazias para o próximo pedido.
    this.store = new SqlInboxStore(this.ctx.storage.sql);
    this.flowInstance = null;
  }
}
