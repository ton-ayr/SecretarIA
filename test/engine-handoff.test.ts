import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1Repo } from '../src/adapters/d1-repo.ts';
import { ScriptedLLM } from '../src/adapters/fake-llm.ts';
import { ConversationEngine, type EngineDeps, type TurnInput } from '../src/core/engine.ts';
import {
  CONTINGENCY_NOTIFIED_REPLY,
  CONTINGENCY_PLAIN_REPLY,
  HANDOFF_REPLY,
  HANDOFF_SCHEDULING_REPLY,
  HANDOFF_UNAVAILABLE_REPLY,
} from '../src/core/handoff.ts';
import { DEFAULT_PRICING } from '../src/core/pricing.ts';
import { LLMError, type ChatRequest } from '../src/ports/llm.ts';
import type { HandoffNotifier, HandoffRequest, OperatorNotifier, RelayRequest } from '../src/ports/notifier.ts';
import { MemoryLogger } from '../src/shared/logger.ts';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';

let mem: LocalPlatform;
let repo: D1Repo;
let clockMs = Date.parse('2026-10-14T13:00:00.000Z');
let wa = 0;

beforeAll(async () => {
  mem = await createMemoryDb({ seed: true });
  repo = new D1Repo(mem.db);
  // Só a barbearia tem Telegram vinculado; o consultório não.
  await mem.db
    .prepare(
      `INSERT INTO notification_channels (id, tenant_id, kind, target_enc, target_ref, active, created_at)
       VALUES ('CH1', ?, 'telegram', 'cifrado', 'ref', 1, '2026-10-01T00:00:00.000Z')`,
    )
    .bind(SEED.barber.tenantId)
    .run();
});
afterAll(() => mem.dispose());

class FakeNotifier implements HandoffNotifier {
  handoffs: HandoffRequest[] = [];
  relays: RelayRequest[] = [];
  constructor(public result: number | Error = 1) {}
  async notifyHandoff(req: HandoffRequest) {
    this.handoffs.push(req);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async relayCustomerMessages(req: RelayRequest) {
    this.relays.push(req);
    return 1;
  }
  async notifyBooking() {
    return 1;
  }
}

class FakeOperator implements OperatorNotifier {
  alerts: string[] = [];
  async notifyOperator(kind: string) {
    this.alerts.push(kind);
  }
}

function setup(llm: ScriptedLLM, opts: { notifier?: FakeNotifier; operator?: FakeOperator } = {}) {
  const notifier = opts.notifier ?? new FakeNotifier();
  const operator = opts.operator ?? new FakeOperator();
  const logger = new MemoryLogger();
  const deps: EngineDeps = {
    repo,
    llm,
    clock: { now: () => new Date((clockMs += 1_000)) },
    logger,
    notifier,
    operator,
    config: { pricing: DEFAULT_PRICING, quotaLimits: {}, logHashKey: 'k' },
  };
  return { engine: new ConversationEngine(deps), notifier, operator, logger };
}

function newWa() {
  wa += 1;
  return `5515990${String(wa).padStart(6, '0')}`;
}

function input(tenant: 'barber' | 'dental', waId: string, ...texts: string[]): TurnInput {
  return {
    metaPhoneNumberId: SEED[tenant].metaPhoneNumberId,
    waId,
    profileName: 'Caio',
    messages: texts.map((text, i) => ({ text, waMessageId: `w.${waId}.${clockMs}.${i}`, at: new Date(clockMs).toISOString() })),
  };
}

const conversation = (id: string | null) =>
  mem.db.prepare('SELECT status, paused_until FROM conversations WHERE id = ?').bind(id).first<{ status: string; paused_until: string | null }>();

const system = (req: ChatRequest) => (req.messages[0]?.role === 'system' ? req.messages[0].content : '');

describe('passagem para humano', () => {
  it('pedido explícito de pessoa: avisa a equipe sem chamar a IA e pausa 12 h', async () => {
    const llm = new ScriptedLLM([]);
    const { engine, notifier } = setup(llm);
    const waId = newWa();
    const res = await engine.handleTurn(input('barber', waId, 'oi', 'quero falar com uma pessoa'));

    expect(res.outcome).toBe('handoff');
    expect(res.reply!.text).toBe(HANDOFF_REPLY);
    expect(llm.requests).toHaveLength(0);
    expect(notifier.handoffs).toHaveLength(1);
    expect(notifier.handoffs[0]).toMatchObject({
      tenantName: 'Barbearia do Zé',
      waId,
      reason: 'customer_request',
      summary: null,
      recentCustomerMessages: ['oi', 'quero falar com uma pessoa'],
    });

    const conv = await conversation(res.conversationId);
    expect(conv!.status).toBe('human');
    const pausedFor = Date.parse(conv!.paused_until!) - Date.parse(res.pausedUntil!);
    expect(pausedFor).toBe(0);
    expect(Date.parse(res.pausedUntil!) - clockMs).toBeGreaterThan(11 * 3_600_000);
    const h = await mem.db.prepare('SELECT reason, channels_notified FROM handoffs WHERE conversation_id = ?').bind(res.conversationId).first();
    expect(h).toEqual({ reason: 'customer_request', channels_notified: 1 });
  });

  it('a IA chama transfer_to_human: uma chamada só e texto fixo', async () => {
    const llm = new ScriptedLLM([
      {
        content: '',
        toolCalls: [{ id: 't1', name: 'transfer_to_human', arguments: '{"motivo":"assunto_sensivel","resumo":"Cobrança em dobro no cartão"}' }],
      },
    ]);
    const { engine, notifier } = setup(llm);
    const res = await engine.handleTurn(input('barber', newWa(), 'vocês cobraram duas vezes no meu cartão!'));

    expect(res.outcome).toBe('handoff');
    expect(res.reply!.text).toBe(HANDOFF_REPLY);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.tools?.map((t) => t.name)).toContain('transfer_to_human');
    expect(system(llm.requests[0]!)).toContain('Chame a ferramenta transfer_to_human');
    expect(notifier.handoffs[0]).toMatchObject({ reason: 'sensitive', summary: 'Cobrança em dobro no cartão' });
  });

  it('com a conversa pausada: guarda, repassa à equipe e não responde', async () => {
    const llm = new ScriptedLLM([]);
    const { engine, notifier } = setup(llm);
    const waId = newWa();
    const first = await engine.handleTurn(input('barber', waId, 'falar com atendente'));
    const second = await engine.handleTurn(input('barber', waId, 'alô?', 'tem alguém aí'));

    expect(second.outcome).toBe('paused');
    expect(second.reply).toBeNull();
    expect(second.pausedUntil).toBe(first.pausedUntil);
    expect(llm.requests).toHaveLength(0);
    expect(notifier.relays).toEqual([
      expect.objectContaining({ conversationId: first.conversationId, messages: ['alô?', 'tem alguém aí'] }),
    ]);
  });

  it('depois do prazo o bot volta e a passagem é encerrada', async () => {
    const llm = new ScriptedLLM([{ content: 'Oi! Em que posso ajudar?' }]);
    const { engine } = setup(llm);
    const waId = newWa();
    const first = await engine.handleTurn(input('barber', waId, 'quero falar com o dono'));
    clockMs += 13 * 3_600_000;
    const res = await engine.handleTurn(input('barber', waId, 'e o horário de sábado?'));

    expect(res.outcome).toBe('replied');
    expect(await conversation(first.conversationId)).toEqual({ status: 'bot', paused_until: null });
    const h = await mem.db.prepare('SELECT resolved_at FROM handoffs WHERE conversation_id = ?').bind(first.conversationId).first<{ resolved_at: string | null }>();
    expect(h!.resolved_at).not.toBeNull();
  });

  it('se o Telegram não entregar, não promete nada e não pausa', async () => {
    for (const result of [0, new Error('Telegram fora do ar')]) {
      const { engine } = setup(new ScriptedLLM([]), { notifier: new FakeNotifier(result) });
      const res = await engine.handleTurn(input('barber', newWa(), 'quero falar com uma pessoa'));
      expect(res.reply!.text).toBe(HANDOFF_UNAVAILABLE_REPLY);
      expect(res.pausedUntil).toBeNull();
      expect((await conversation(res.conversationId))!.status).toBe('bot');
      const h = await mem.db.prepare('SELECT channels_notified, notified_at FROM handoffs WHERE conversation_id = ?').bind(res.conversationId).first();
      expect(h).toEqual({ channels_notified: 0, notified_at: null });
    }
  });

  it('empresa sem Telegram: a ferramenta não é oferecida e o operador é avisado', async () => {
    const llm = new ScriptedLLM(() => ({ content: 'Posso ajudar com os serviços.' }));
    const operator = new FakeOperator();
    const { engine, notifier } = setup(llm, { operator });

    await engine.handleTurn(input('dental', newWa(), 'quanto custa a limpeza?'));
    expect(llm.requests[0]!.tools).toBeUndefined();
    expect(system(llm.requests[0]!)).toContain('por aqui ainda não é possível falar com a equipe');

    const res = await engine.handleTurn(input('dental', newWa(), 'quero falar com uma pessoa'));
    expect(res.reply!.text).toBe(HANDOFF_UNAVAILABLE_REPLY);
    expect(notifier.handoffs).toHaveLength(0);
    expect(operator.alerts).toEqual([`handoff_no_channel:${SEED.dental.tenantId}`]);
  });

  it('pedido para marcar sem agenda: vai para a equipe com texto próprio', async () => {
    const llm = new ScriptedLLM([
      { content: '', toolCalls: [{ id: 't', name: 'transfer_to_human', arguments: '{"motivo":"agendamento","resumo":"Corte amanhã às 10h"}' }] },
    ]);
    const { engine, notifier } = setup(llm);
    const res = await engine.handleTurn(input('barber', newWa(), 'quero marcar um corte amanhã às 10h'));
    expect(system(llm.requests[0]!)).toContain('chame a ferramenta transfer_to_human com motivo agendamento');
    expect(res.outcome).toBe('handoff');
    expect(res.reply!.text).toBe(HANDOFF_SCHEDULING_REPLY);
    expect(notifier.handoffs[0]!.reason).toBe('scheduling');
  });

  it('falha total da IA com Telegram: avisa a equipe, pausa e diz que avisou', async () => {
    const operator = new FakeOperator();
    const { engine, notifier } = setup(new ScriptedLLM([new LLMError('server', 'caiu', 503)]), { operator });
    const res = await engine.handleTurn(input('barber', newWa(), 'quanto custa a barba?'));
    expect(res.outcome).toBe('contingency');
    expect(res.reply!.text).toBe(CONTINGENCY_NOTIFIED_REPLY);
    expect(res.pausedUntil).not.toBeNull();
    expect(notifier.handoffs[0]!.reason).toBe('technical_failure');
    expect(operator.alerts).toContain('llm_failed');
  });

  it('falha total da IA sem Telegram: só pede para tentar de novo, sem pausar', async () => {
    const { engine } = setup(new ScriptedLLM([new LLMError('timeout', 't')]));
    const res = await engine.handleTurn(input('dental', newWa(), 'oi'));
    expect(res.reply!.text).toBe(CONTINGENCY_PLAIN_REPLY);
    expect(res.pausedUntil).toBeNull();
  });
});

describe('áudio', () => {
  it('transcrição vai para a IA como fala do cliente e entra no medidor', async () => {
    const llm = new ScriptedLLM([{ content: 'Claro! O corte custa R$ 45,00.' }]);
    const { engine } = setup(llm);
    const usageBefore = await mem.db.prepare('SELECT stt_seconds, est_cost_usd_micros FROM usage_monthly WHERE phone_number_id = ?').bind(SEED.barber.phoneNumberId).first<Record<string, number>>();
    const res = await engine.handleTurn({
      ...input('barber', newWa()),
      messages: [{ text: 'quanto custa o corte', kind: 'audio', waMessageId: `a.${clockMs}`, at: new Date(clockMs).toISOString() }],
      stt: [{ seconds: 7, provider: 'groq', model: 'whisper-large-v3-turbo' }],
    });
    expect(res.outcome).toBe('replied');
    expect(llm.requests[0]!.messages.at(-1)).toEqual({ role: 'user', content: '[áudio transcrito] quanto custa o corte' });
    const usage = await mem.db.prepare('SELECT stt_seconds, est_cost_usd_micros FROM usage_monthly WHERE phone_number_id = ?').bind(SEED.barber.phoneNumberId).first<Record<string, number>>();
    expect((usage!.stt_seconds ?? 0) - (usageBefore?.stt_seconds ?? 0)).toBe(7);
    // 7 s cobrados como 10 s na Groq (111 micro-dólares) + o custo da IA.
    expect((usage!.est_cost_usd_micros ?? 0) - (usageBefore?.est_cost_usd_micros ?? 0)).toBeGreaterThanOrEqual(111);
  });

  it('áudio longo demais: resposta fixa, sem IA', async () => {
    const llm = new ScriptedLLM([]);
    const { engine } = setup(llm);
    const res = await engine.handleTurn({
      ...input('barber', newWa()),
      messages: [{ text: '', kind: 'audio', mediaNote: 'too_long', waMessageId: `a.${clockMs}`, at: new Date(clockMs).toISOString() }],
    });
    expect(res.outcome).toBe('fixed_reply');
    expect(res.reply!.text).toContain('2 minutos');
    expect(llm.requests).toHaveLength(0);
  });
});

describe('resposta da equipe gravada', () => {
  it('grava como mensagem da equipe, mantém pausado e conta no medidor', async () => {
    const { engine } = setup(new ScriptedLLM([]));
    const first = await engine.handleTurn(input('barber', newWa(), 'quero falar com uma pessoa'));
    const before = await mem.db.prepare('SELECT replies_out FROM usage_monthly WHERE phone_number_id = ?').bind(SEED.barber.phoneNumberId).first<{ replies_out: number }>();
    const until = new Date(clockMs + 12 * 3_600_000).toISOString();
    await repo.forTenant(SEED.barber.tenantId).saveHumanReply({
      conversationId: first.conversationId!,
      phoneNumberId: SEED.barber.phoneNumberId,
      messageId: `HR-${clockMs}`,
      body: 'Oi Caio, aqui é o Zé! Como posso ajudar?',
      waMessageId: `wamid.hr.${clockMs}`,
      now: new Date(clockMs).toISOString(),
      month: '2026-10',
      pausedUntil: until,
    });
    const msg = await mem.db.prepare("SELECT author, direction FROM messages WHERE id = ?").bind(`HR-${clockMs}`).first();
    expect(msg).toEqual({ author: 'human', direction: 'out' });
    expect(await conversation(first.conversationId)).toEqual({ status: 'human', paused_until: until });
    const after = await mem.db.prepare('SELECT replies_out FROM usage_monthly WHERE phone_number_id = ?').bind(SEED.barber.phoneNumberId).first<{ replies_out: number }>();
    expect(after!.replies_out).toBe(before!.replies_out + 1);
  });
});
