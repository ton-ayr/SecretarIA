import type { Segment, TurnContext } from '../ports/domain.ts';
import { LLMError, type ChatMessage, type LLMAttempt, type LLMProvider, type LLMUsage, type ToolDef } from '../ports/llm.ts';
import type { HandoffNotifier, HandoffReason, OperatorNotifier } from '../ports/notifier.ts';
import type { LlmUsageEntry, NewMessage, Repo, TenantRepo, TurnRecord, UsageDelta } from '../ports/repo.ts';
import type { Clock, Logger, LogFields } from '../ports/runtime.ts';
import { ulid } from '../shared/ids.ts';
import { contactRef } from '../shared/log-hash.ts';
import { dayKey, monthKey } from '../shared/time.ts';
import { estimateTokens, selectHistory, SUMMARY_BATCH } from './context.ts';
import {
  CONTINGENCY_NOTIFIED_REPLY,
  CONTINGENCY_PLAIN_REPLY,
  HANDOFF_REPLY,
  HANDOFF_SCHEDULING_REPLY,
  handoffTool,
  HANDOFF_TOOL_NAME,
  HANDOFF_UNAVAILABLE_REPLY,
  reasonFromToolArgs,
  summaryFromToolArgs,
  wantsHuman,
} from './handoff.ts';
import {
  DEFAULT_STT_PRICING,
  estimateCostMicros,
  estimateSttCostMicros,
  type PricingTable,
  type SttPricingTable,
} from './pricing.ts';
import {
  buildSystemPrompt,
  historyToMessages,
  inboundToUserMessage,
  sanitizeName,
  type PromptCapabilities,
} from './prompt.ts';
import { quotaAlertsDue, type QuotaAlert, type QuotaLimits } from './quota.ts';
import { postProcessReply } from './reply.ts';
import { buildSummaryRequest, SUMMARY_MAX_CHARS } from './summary.ts';
import { fixedMediaReply, type MediaNote } from './texts.ts';
import { MAX_TOOL_ROUNDS, parseToolArgs, type Tool, type ToolContext, type ToolResult } from './tools.ts';
import { SchedulingAssistant, type PostJob, type SchedulingAction } from './scheduling.ts';
import { runPostJobs } from './scheduling-jobs.ts';
import type { ExternalCalendar } from '../ports/calendar.ts';
import { isTextual, mediaPlaceholder } from './whatsapp-payload.ts';

export interface InboundMessage {
  /** Texto, legenda da mídia ou transcrição do áudio. */
  text: string;
  /** ID da mensagem na Meta (null no simulador). */
  waMessageId: string | null;
  /** Quando chegou, em ISO 8601 UTC. */
  at: string;
  /** text, interactive, button, audio, image... (padrão: text). */
  kind?: string;
  /** Áudio que não virou texto: longo demais ou falha na transcrição. */
  mediaNote?: MediaNote;
  /** id da opção tocada (lista ou botão), definido pelo servidor. */
  replyId?: string | null;
}

/** Texto gravado e enviado à IA: mídia vira um aviso entre colchetes. */
function inboundBody(m: InboundMessage): string {
  const kind = m.kind ?? 'text';
  const text = m.text.trim();
  // A opção tocada vai junto (sem dado pessoal), para a IA usar a referência.
  if (isTextual(kind)) return m.replyId ? `${m.text} (${m.replyId})` : m.text;
  if (kind === 'audio' && text && !m.mediaNote) return `[áudio transcrito] ${text}`;
  return text ? `${mediaPlaceholder(kind)} ${text}` : mediaPlaceholder(kind);
}

/** Segundos de áudio transcritos neste turno, por provedor. */
export interface SttUsage {
  seconds: number;
  provider: string;
  model: string;
}

export interface TurnInput {
  metaPhoneNumberId: string;
  waId: string;
  profileName: string | null;
  messages: InboundMessage[];
  stt?: SttUsage[];
}

export interface ReplyOption {
  id: string;
  title: string;
  description?: string;
}

export interface ReplyButton {
  id: string;
  title: string;
}

/**
 * Uma única mensagem por turno. `options` (lista) e `buttons` (até 3) são
 * montados pelo servidor, nunca pela IA.
 */
export interface Reply {
  text: string;
  options?: ReplyOption[];
  /** Texto do botão que abre a lista (até 20 caracteres). */
  listButton?: string;
  buttons?: ReplyButton[];
}

export type TurnOutcome = 'replied' | 'fixed_reply' | 'handoff' | 'contingency' | 'paused' | 'unknown_number';

export interface SummaryJob {
  tenantId: string;
  conversationId: string;
  phoneNumberId: string;
  segment: Segment;
  keepLast: number;
}

export interface TurnResult {
  turnId: string;
  outcome: TurnOutcome;
  reply: Reply | null;
  /** ID (nosso) da mensagem de resposta gravada, para ligar ao wamid depois do envio. */
  replyMessageId: string | null;
  tenantId: string | null;
  conversationId: string | null;
  provider: string | null;
  model: string | null;
  usage: LLMUsage;
  llmRequests: number;
  latencyMs: number;
  /** Preenchido quando o histórico pede um novo resumo (rodar depois de enviar). */
  summaryJob: SummaryJob | null;
  /** Código do erro do turno (ex.: llm_server, empty_reply). */
  errorCode: string | null;
  /** Tentativas que falharam, sem texto, para diagnóstico. */
  failedAttempts: string[];
  /** Até quando a conversa fica com a equipe (null = com o bot). */
  pausedUntil: string | null;
  /** Motivo da passagem para humano, quando houve (mesmo se ninguém foi avisado). */
  handoffReason: HandoffReason | null;
  /** Agenda: o que mudou neste turno. */
  action: SchedulingAction | null;
  /** Trabalhos para depois do envio (agenda Google, aviso à equipe). */
  postJobs: PostJob[];
}

export interface EngineConfig {
  pricing: PricingTable;
  sttPricing?: SttPricingTable;
  quotaLimits: QuotaLimits;
  /** Chave do HMAC do contact_ref nos logs. */
  logHashKey: string;
  /** Teto de tokens de saída (inclui o raciocínio dos modelos gpt-oss). */
  maxOutputTokens?: number;
  llmTimeoutMs?: number;
}

export interface EngineDeps {
  repo: Repo;
  llm: LLMProvider;
  clock: Clock;
  logger: Logger;
  config: EngineConfig;
  tools?: Tool[];
  /** Avisos à equipe (Telegram). Sem ele, o bot não oferece falar com a equipe. */
  notifier?: HandoffNotifier;
  /** Alertas ao operador (Telegram). */
  operator?: OperatorNotifier;
  /** Chamado quando a cota diária da IA passa de 70%. */
  onQuotaAlert?: (alert: QuotaAlert) => Promise<void>;
  /** Agenda. Sem ele, o bot não marca horários. */
  scheduling?: { calendar?: ExternalCalendar; publicBaseUrl: string };
}

interface StepLog {
  s: string;
  ms: number;
  [k: string]: unknown;
}

/** O que o turno decidiu responder e o que muda na conversa. */
interface Decision {
  reply: Reply;
  action?: SchedulingAction;
  postJobs?: PostJob[];
  outcome: TurnOutcome;
  errorCode: string | null;
  conversationUpdate?: TurnRecord['conversationUpdate'];
  handoff?: TurnRecord['handoff'];
}

/** "groq:openai/gpt-oss-120b server 503 812ms" */
function describeAttempt(a: LLMAttempt): string {
  const status = a.ok ? 'ok' : [a.errorKind ?? '?', a.status].filter(Boolean).join(' ');
  return `${a.provider}:${a.model} ${status} ${a.ms}ms`;
}

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_LLM_TIMEOUT_MS = 45_000;
const RECENT_MESSAGES_FOR_TEAM = 5;

type ModelOutcome =
  | { text: string | null }
  | { handoff: { reason: HandoffReason; summary: string | null } }
  | { final: ToolResult };

export class ConversationEngine {
  private readonly tools: Tool[];

  constructor(private readonly deps: EngineDeps) {
    this.tools = deps.tools ?? [];
  }

  async handleTurn(input: TurnInput): Promise<TurnResult> {
    const { repo, clock, logger, config } = this.deps;
    const started = clock.now();
    const turnId = ulid(started.getTime());
    const steps: StepLog[] = [];
    const result: TurnResult = {
      turnId,
      outcome: 'unknown_number',
      reply: null,
      replyMessageId: null,
      tenantId: null,
      conversationId: null,
      provider: null,
      model: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      llmRequests: 0,
      latencyMs: 0,
      summaryJob: null,
      errorCode: null,
      failedAttempts: [],
      pausedUntil: null,
      handoffReason: null,
      action: null,
      postJobs: [],
    };

    const route = await repo.lookupPhoneNumber(input.metaPhoneNumberId);
    if (!route) {
      logger.warn('turn_unknown_number', { turn_id: turnId, meta_phone_number_id: input.metaPhoneNumberId });
      return result;
    }
    result.tenantId = route.tenantId;
    const tenantRepo = repo.forTenant(route.tenantId);
    const nowIso = started.toISOString();

    const t = Date.now();
    const ctx = await tenantRepo.loadTurnContext({
      phoneNumberId: route.phoneNumberId,
      waId: input.waId,
      profileName: input.profileName,
      now: nowIso,
      newContactId: ulid(),
      newConversationId: ulid(),
    });
    if (!ctx) {
      logger.error('turn_context_missing', { turn_id: turnId, tenant_id: route.tenantId });
      return result;
    }
    steps.push({ s: 'context', ms: Date.now() - t, history: ctx.history.length });
    result.conversationId = ctx.conversation.id;

    const logBase: LogFields = {
      turn_id: turnId,
      tenant_id: route.tenantId,
      phone_number_id: route.phoneNumberId,
      conversation_id: ctx.conversation.id,
      contact_ref: await contactRef(config.logHashKey, route.tenantId, input.waId),
    };
    logger.info('turn_started', { ...logBase, inbound: input.messages.length });

    const inbound: NewMessage[] = input.messages.map((m) => ({
      id: ulid(Date.parse(m.at)),
      direction: 'in',
      author: 'customer',
      kind: m.kind ?? 'text',
      body: inboundBody(m),
      waMessageId: m.waMessageId,
      createdAt: m.at,
    }));
    const lastCustomerMsgAt = input.messages.at(-1)?.at ?? nowIso;

    // Conversa com a equipe: guarda, repassa ao Telegram e não responde.
    if (ctx.conversation.status === 'human') {
      if (ctx.conversation.pausedUntil && ctx.conversation.pausedUntil > nowIso) {
        result.outcome = 'paused';
        result.pausedUntil = ctx.conversation.pausedUntil;
        await this.persist(tenantRepo, ctx, result, inbound, lastCustomerMsgAt, steps, started, input.stt, null, {});
        await this.relayToTeam(ctx, input.waId, inbound.map((m) => m.body), logBase);
        logger.info('turn_paused', logBase);
        return result;
      }
      await tenantRepo.resumeBot(ctx.conversation.id, nowIso);
      logger.info('conversation_resumed', logBase);
    }

    const usageByModel = new Map<string, LlmUsageEntry>();
    const assistant = this.deps.scheduling
      ? new SchedulingAssistant(
          ctx,
          {
            repo: tenantRepo.scheduling(),
            calendar: this.deps.scheduling.calendar,
            clock,
            logger,
            publicBaseUrl: this.deps.scheduling.publicBaseUrl,
            handoffAvailable: this.handoffAvailable(ctx),
          },
          logBase,
        )
      : null;
    const decision = await this.decide(ctx, input, inbound, result, usageByModel, steps, logBase, started, assistant);
    result.outcome = decision.outcome;
    result.errorCode = decision.errorCode;
    result.reply = decision.reply;
    result.action = decision.action ?? null;
    result.postJobs = decision.postJobs ?? [];
    result.pausedUntil = decision.conversationUpdate?.pausedUntil ?? null;

    const outbound: NewMessage = {
      id: ulid(),
      direction: 'out',
      author: 'bot',
      kind: decision.reply.options?.length || decision.reply.buttons?.length ? 'interactive' : 'text',
      body: decision.reply.text,
      waMessageId: null,
      createdAt: clock.now().toISOString(),
    };
    result.replyMessageId = outbound.id;
    await this.persist(tenantRepo, ctx, result, [...inbound, outbound], lastCustomerMsgAt, steps, started, input.stt, decision.errorCode, {
      conversationUpdate: decision.conversationUpdate,
      handoff: decision.handoff,
    });
    await this.trackDailyUsage([...usageByModel.values()], logBase);

    // Resumo: quando as mensagens fora do resumo passam de N + lote.
    const unsummarized = ctx.unsummarizedCount + inbound.length + 1;
    if (unsummarized >= ctx.agent.historyMessages + SUMMARY_BATCH) {
      result.summaryJob = {
        tenantId: route.tenantId,
        conversationId: ctx.conversation.id,
        phoneNumberId: route.phoneNumberId,
        segment: ctx.tenant.segment,
        keepLast: ctx.agent.historyMessages,
      };
    }

    logger.info('turn_finished', {
      ...logBase,
      outcome: result.outcome,
      provider: result.provider,
      model: result.model,
      tokens_in: result.usage.inputTokens,
      tokens_out: result.usage.outputTokens,
      llm_requests: result.llmRequests,
      latency_ms: result.latencyMs,
      handoff_reason: result.handoffReason,
      action: result.action,
      error_code: result.errorCode,
    });
    return result;
  }

  /** Agenda Google e aviso à equipe, depois de responder ao cliente. */
  async runPostJobs(jobs: PostJob[]): Promise<void> {
    if (!jobs.length) return;
    await runPostJobs(jobs, {
      repo: this.deps.repo,
      calendar: this.deps.scheduling?.calendar,
      notifier: this.deps.notifier,
      clock: this.deps.clock,
      logger: this.deps.logger,
    });
  }

  /** Decide a resposta do turno: mídia, pedido de pessoa, IA ou contingência. */
  private async decide(
    ctx: TurnContext,
    input: TurnInput,
    inbound: NewMessage[],
    result: TurnResult,
    usageByModel: Map<string, LlmUsageEntry>,
    steps: StepLog[],
    logBase: LogFields,
    started: Date,
    assistant: SchedulingAssistant | null,
  ): Promise<Decision> {
    const { logger } = this.deps;
    const bodies = inbound.map((m) => m.body);

    // Toque em lista ou botão da agenda: o servidor resolve sem IA.
    const replyId = input.messages.findLast((m) => m.replyId)?.replyId;
    if (assistant && replyId) {
      const t = Date.now();
      const handled = await assistant.handleReply(replyId);
      if (handled?.final) {
        steps.push({ s: 'reply_button', ms: Date.now() - t, kind: replyId.split('|')[0] });
        return this.fromToolResult(handled);
      }
    }

    // Só mídia (áudio sem transcrição, imagem...): resposta fixa, sem IA.
    if (input.messages.every((m) => !isTextual(m.kind ?? 'text') && (!m.text.trim() || m.mediaNote))) {
      steps.push({ s: 'fixed_reply', ms: 0 });
      return {
        reply: { text: fixedMediaReply(input.messages.map((m) => ({ kind: m.kind ?? 'other', mediaNote: m.mediaNote }))) },
        outcome: 'fixed_reply',
        errorCode: null,
      };
    }

    // Rede de segurança: pedido explícito de pessoa, sem gastar IA.
    if (wantsHuman(bodies)) {
      steps.push({ s: 'handoff_keyword', ms: 0 });
      return this.handoff(ctx, input.waId, bodies, 'customer_request', null, result, steps, logBase, started);
    }

    const handoffAvailable = this.handoffAvailable(ctx);
    let outcome: ModelOutcome;
    let errorCode: string | null = null;
    try {
      outcome = await this.runModel(ctx, bodies, handoffAvailable, result, usageByModel, steps, started, assistant);
    } catch (err) {
      errorCode = err instanceof LLMError ? `llm_${err.kind}` : 'internal';
      // Tentativas sem texto: provedor, modelo, tipo de erro e código HTTP.
      const attempts = err instanceof LLMError ? err.attempts : [];
      result.failedAttempts = attempts.map((a) => describeAttempt(a));
      steps.push({ s: 'llm_failed', ms: 0, error: errorCode, attempts: result.failedAttempts });
      logger.error('llm_failed', { ...logBase, error_code: errorCode, attempts: result.failedAttempts.join('; ') });
      outcome = { text: null };
    }

    if ('final' in outcome) return this.fromToolResult(outcome.final);
    if ('handoff' in outcome) {
      return this.handoff(ctx, input.waId, bodies, outcome.handoff.reason, outcome.handoff.summary, result, steps, logBase, started);
    }
    if (outcome.text) {
      const processed = postProcessReply(outcome.text, ctx.agent.maxReplyChars);
      if (processed.truncated) logger.warn('reply_truncated', logBase);
      return { reply: { text: processed.text }, outcome: 'replied', errorCode: null };
    }

    // Falha total ou resposta vazia: contingência. Avisa a equipe se der.
    errorCode ??= 'empty_reply';
    await this.alertOperator('llm_failed', `⚠️ A IA não respondeu em nenhum provedor (código ${errorCode}).`);
    const h = await this.handoff(ctx, input.waId, bodies, 'technical_failure', null, result, steps, logBase, started);
    const notified = h.outcome === 'handoff';
    return {
      ...h,
      reply: { text: notified ? CONTINGENCY_NOTIFIED_REPLY : CONTINGENCY_PLAIN_REPLY },
      outcome: 'contingency',
      errorCode,
    };
  }

  /** Resposta montada pelo servidor (agenda): encerra o turno. */
  private fromToolResult(r: ToolResult): Decision {
    return { reply: r.final!, outcome: 'replied', errorCode: null, action: r.action, postJobs: r.effects };
  }

  private handoffAvailable(ctx: TurnContext): boolean {
    return Boolean(this.deps.notifier) && ctx.handoffChannels > 0;
  }

  /**
   * Chama a equipe. Só pausa o bot e só diz "avisei a equipe" se o aviso saiu
   * de verdade para pelo menos um canal.
   */
  private async handoff(
    ctx: TurnContext,
    waId: string,
    bodies: string[],
    reason: HandoffReason,
    summary: string | null,
    result: TurnResult,
    steps: StepLog[],
    logBase: LogFields,
    started: Date,
  ): Promise<Decision> {
    const { notifier, logger } = this.deps;
    result.handoffReason = reason;
    const t = Date.now();
    let channels = 0;

    if (notifier && ctx.handoffChannels > 0) {
      const history = ctx.history.filter((m) => m.author === 'customer').map((m) => m.body);
      try {
        channels = await notifier.notifyHandoff({
          tenantId: ctx.tenant.id,
          tenantName: ctx.tenant.name,
          conversationId: ctx.conversation.id,
          waId,
          contactName: ctx.contact.displayName ?? sanitizeName(ctx.contact.profileName),
          reason,
          summary,
          recentCustomerMessages: [...history, ...bodies].slice(-RECENT_MESSAGES_FOR_TEAM),
        });
      } catch (err) {
        logger.error('handoff_notify_failed', { ...logBase, error_code: err instanceof Error ? err.name : 'unknown' });
      }
    } else if (reason !== 'technical_failure') {
      await this.alertOperator(
        `handoff_no_channel:${ctx.tenant.id}`,
        `⚠️ ${ctx.tenant.name}: um cliente precisa da equipe, mas a empresa não tem Telegram vinculado.`,
      );
    }
    steps.push({ s: 'handoff', ms: Date.now() - t, reason, channels });

    const now = this.deps.clock.now();
    const handoff = {
      id: ulid(),
      reason,
      channelsNotified: channels,
      notifiedAt: channels > 0 ? now.toISOString() : null,
    };
    if (channels === 0) {
      logger.warn('handoff_unavailable', { ...logBase, handoff_reason: reason });
      return { reply: { text: HANDOFF_UNAVAILABLE_REPLY }, outcome: 'replied', errorCode: null, handoff };
    }

    const pausedUntil = new Date(started.getTime() + ctx.agent.handoffResumeHours * 3_600_000).toISOString();
    logger.info('handoff_done', { ...logBase, handoff_reason: reason, channels });
    return {
      reply: { text: reason === 'scheduling' ? HANDOFF_SCHEDULING_REPLY : HANDOFF_REPLY },
      outcome: 'handoff',
      errorCode: null,
      handoff,
      conversationUpdate: { status: 'human', pausedUntil },
    };
  }

  /** Repassa à equipe o que o cliente escreveu durante a pausa. */
  private async relayToTeam(ctx: TurnContext, waId: string, bodies: string[], logBase: LogFields): Promise<void> {
    const { notifier, logger } = this.deps;
    if (!notifier || ctx.handoffChannels === 0) {
      logger.warn('relay_unavailable', logBase);
      return;
    }
    try {
      const delivered = await notifier.relayCustomerMessages({
        tenantId: ctx.tenant.id,
        tenantName: ctx.tenant.name,
        conversationId: ctx.conversation.id,
        waId,
        contactName: ctx.contact.displayName ?? sanitizeName(ctx.contact.profileName),
        messages: bodies,
      });
      if (delivered === 0) logger.warn('relay_not_delivered', logBase);
    } catch (err) {
      logger.error('relay_failed', { ...logBase, error_code: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private async alertOperator(kind: string, text: string): Promise<void> {
    try {
      await this.deps.operator?.notifyOperator(kind, text);
    } catch (err) {
      this.deps.logger.warn('operator_alert_failed', { kind, error_code: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private async runModel(
    ctx: TurnContext,
    bodies: string[],
    handoffAvailable: boolean,
    result: TurnResult,
    usageByModel: Map<string, LlmUsageEntry>,
    steps: StepLog[],
    started: Date,
    assistant: SchedulingAssistant | null,
  ): Promise<ModelOutcome> {
    const { llm, config } = this.deps;
    const tools = [...this.tools, ...(assistant?.tools() ?? [])];
    const toolDefs: ToolDef[] = [...tools.map((tool) => tool.def), ...(handoffAvailable ? [handoffTool(!!assistant)] : [])];
    const caps: PromptCapabilities = {
      scheduling: toolDefs.some((d) => d.name === 'check_availability'),
      handoff: handoffAvailable,
    };

    // Monta o pedido à IA.
    const t0 = Date.now();
    const userMessage = inboundToUserMessage(bodies);
    const selection = selectHistory(ctx.history, {
      maxMessages: ctx.agent.historyMessages + SUMMARY_BATCH,
      budgetTokens: ctx.agent.maxContextTokens,
      reservedTokens: estimateTokens(userMessage.content),
    });
    const system = buildSystemPrompt(ctx, started, caps);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...historyToMessages(selection.messages),
      userMessage,
    ];
    steps.push({
      s: 'prompt',
      ms: Date.now() - t0,
      system_tokens_est: estimateTokens(system),
      history_tokens_est: selection.tokens,
      history_used: selection.messages.length,
      history_dropped: selection.dropped,
    });

    const toolCtx: ToolContext = {
      tenantId: ctx.tenant.id,
      contactId: ctx.contact.id,
      conversationId: ctx.conversation.id,
      turnId: result.turnId,
      now: started,
    };

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const offerTools = toolDefs.length > 0 && round < MAX_TOOL_ROUNDS;
      const t = Date.now();
      const res = await llm.chat({
        messages,
        tools: offerTools ? toolDefs : undefined,
        maxOutputTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        timeoutMs: config.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      });
      this.addUsage(result, usageByModel, res.provider, res.model, res.usage);
      steps.push({
        s: 'llm',
        ms: Date.now() - t,
        provider: res.provider,
        model: res.model,
        tokens_in: res.usage.inputTokens,
        tokens_out: res.usage.outputTokens,
        attempts: res.attempts.length,
        tool_calls: res.toolCalls.length,
      });

      if (!offerTools || res.toolCalls.length === 0) return { text: res.content.trim() || null };

      // Passagem para humano encerra o turno: a resposta é texto fixo do servidor.
      const handoffCall = res.toolCalls.find((c) => c.name === HANDOFF_TOOL_NAME);
      if (handoffCall) {
        const args = parseToolArgs(handoffCall.arguments) ?? {};
        steps.push({ s: 'tool', ms: 0, name: HANDOFF_TOOL_NAME, ok: true });
        return { handoff: { reason: reasonFromToolArgs(args), summary: summaryFromToolArgs(args) } };
      }

      messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        const tool = tools.find((x) => x.def.name === call.name);
        const args = parseToolArgs(call.arguments);
        const tt = Date.now();
        let content: string;
        let ok = false;
        if (!tool) content = JSON.stringify({ erro: 'ferramenta desconhecida' });
        else if (!args) content = JSON.stringify({ erro: 'argumentos inválidos' });
        else {
          const out = await tool.run(args, toolCtx);
          steps.push({ s: 'tool', ms: Date.now() - tt, name: call.name, ok: out.ok });
          // Resposta do servidor (horários, confirmação): o turno termina aqui.
          if (out.final) return { final: out };
          content = out.content;
          ok = out.ok;
          messages.push({ role: 'tool', toolCallId: call.id, content });
          continue;
        }
        steps.push({ s: 'tool', ms: Date.now() - tt, name: call.name, ok });
        messages.push({ role: 'tool', toolCallId: call.id, content });
      }
    }
    return { text: null };
  }

  private addUsage(
    result: TurnResult,
    usageByModel: Map<string, LlmUsageEntry>,
    provider: string,
    model: string,
    usage: LLMUsage,
  ): void {
    result.usage.inputTokens += usage.inputTokens;
    result.usage.outputTokens += usage.outputTokens;
    result.llmRequests += 1;
    result.provider = provider;
    result.model = model;
    const key = `${provider}:${model}`;
    const entry = usageByModel.get(key) ?? { provider, model, requests: 0, tokens: 0 };
    entry.requests += 1;
    entry.tokens += usage.inputTokens + usage.outputTokens;
    usageByModel.set(key, entry);
  }

  private async persist(
    tenantRepo: TenantRepo,
    ctx: TurnContext,
    result: TurnResult,
    messages: NewMessage[],
    lastCustomerMsgAt: string,
    steps: StepLog[],
    started: Date,
    stt: SttUsage[] | undefined,
    errorCode: string | null,
    extra: Pick<TurnRecord, 'conversationUpdate' | 'handoff'>,
  ): Promise<void> {
    const { config } = this.deps;
    const now = this.deps.clock.now();
    result.latencyMs = now.getTime() - started.getTime();
    const sttPricing = config.sttPricing ?? DEFAULT_STT_PRICING;
    const sttSeconds = (stt ?? []).reduce((sum, s) => sum + s.seconds, 0);
    const sttCost = (stt ?? []).reduce((sum, s) => sum + estimateSttCostMicros(sttPricing, s.provider, s.model, s.seconds), 0);
    const llmCost =
      result.provider && result.model ? estimateCostMicros(config.pricing, result.provider, result.model, result.usage) : 0;
    const usage: UsageDelta = {
      msgsIn: messages.filter((m) => m.direction === 'in').length,
      repliesOut: messages.filter((m) => m.direction === 'out').length,
      llmRequests: result.llmRequests,
      tokensIn: result.usage.inputTokens,
      tokensOut: result.usage.outputTokens,
      estCostUsdMicros: llmCost + sttCost,
      sttSeconds,
    };
    await tenantRepo.saveTurn({
      conversationId: ctx.conversation.id,
      phoneNumberId: ctx.phoneNumberId,
      month: monthKey(now),
      messages,
      lastCustomerMsgAt,
      now: now.toISOString(),
      usage,
      ...extra,
      turnLog: {
        id: result.turnId,
        startedAt: started.toISOString(),
        durationMs: result.latencyMs,
        steps,
        provider: result.provider,
        model: result.model,
        toolCalls: steps.filter((s) => s.s === 'tool').length,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        outcome: result.outcome,
        errorCode,
      },
    });
  }

  /** Soma o uso diário da IA e dispara o alerta de 70% uma vez por dia. */
  private async trackDailyUsage(entries: LlmUsageEntry[], logBase: LogFields): Promise<void> {
    if (entries.length === 0) return;
    const { repo, clock, logger, config, onQuotaAlert } = this.deps;
    const now = clock.now();
    const day = dayKey(now);
    try {
      const totals = await repo.ops.addLlmUsage(day, entries);
      for (const alert of quotaAlertsDue(totals, config.quotaLimits)) {
        const first = await repo.ops.markQuotaAlert(alert.provider, alert.model, day, now.toISOString());
        if (!first) continue;
        logger.warn('llm_quota_alert', {
          ...logBase,
          provider: alert.provider,
          model: alert.model,
          used_pct: Math.round(alert.usedRatio * 100),
        });
        await onQuotaAlert?.(alert);
      }
    } catch (err) {
      // Medidor não pode derrubar o atendimento.
      logger.error('llm_usage_track_failed', { ...logBase, error_code: err instanceof Error ? err.name : 'unknown' });
    }
  }

  /** Atualiza o resumo da conversa. Rodar depois de enviar a resposta. */
  async runSummary(job: SummaryJob): Promise<boolean> {
    const { repo, llm, clock, logger, config } = this.deps;
    const tenantRepo = repo.forTenant(job.tenantId);
    const input = await tenantRepo.loadSummaryInput(job.conversationId, job.keepLast);
    if (input.messages.length === 0) return false;
    const logBase = { tenant_id: job.tenantId, conversation_id: job.conversationId };
    try {
      const res = await llm.chat({
        messages: buildSummaryRequest(job.segment, input.summary, input.messages),
        maxOutputTokens: 600,
        timeoutMs: config.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
      });
      const summary = res.content.trim().slice(0, SUMMARY_MAX_CHARS);
      if (!summary) return false;
      const now = clock.now();
      const lastAt = input.messages.at(-1)!.createdAt;
      await tenantRepo.saveSummary(job.conversationId, summary, lastAt, now.toISOString());
      await tenantRepo.recordUsage(job.phoneNumberId, monthKey(now), {
        msgsIn: 0,
        repliesOut: 0,
        llmRequests: 1,
        tokensIn: res.usage.inputTokens,
        tokensOut: res.usage.outputTokens,
        estCostUsdMicros: estimateCostMicros(config.pricing, res.provider, res.model, res.usage),
      });
      await this.trackDailyUsage(
        [{ provider: res.provider, model: res.model, requests: 1, tokens: res.usage.inputTokens + res.usage.outputTokens }],
        logBase,
      );
      logger.info('summary_updated', { ...logBase, messages: input.messages.length });
      return true;
    } catch (err) {
      logger.warn('summary_failed', { ...logBase, error_code: err instanceof LLMError ? `llm_${err.kind}` : 'internal' });
      return false;
    }
  }
}
