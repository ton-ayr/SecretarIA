import { describe, expect, it } from 'vitest';
import { createApp, type WebhookDeps } from '../src/bot/app.ts';
import { ConversationFlow, type InboxItem } from '../src/core/conversation-flow.ts';
import type { TurnInput, TurnResult } from '../src/core/engine.ts';
import type { PhoneRoute } from '../src/ports/repo.ts';
import { WhatsAppError, type ListMessage, type WhatsAppSender } from '../src/ports/whatsapp.ts';
import { MemoryLogger } from '../src/shared/logger.ts';
import { signBody } from '../src/shared/signature.ts';
import { MemoryInboxStore, sampleWebhook } from './helpers/fixtures.ts';

const ROUTE = { metaPhoneNumberId: 'PNID', waId: '5511999990001' };
const T0 = Date.parse('2026-10-03T12:00:00.000Z');

function turnResult(input: TurnInput, overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    turnId: 'T',
    outcome: 'replied',
    reply: { text: `resposta para ${input.messages.length}` },
    replyMessageId: 'OUT',
    tenantId: 'TEN',
    conversationId: 'CONV',
    provider: 'fake',
    model: 'm',
    usage: { inputTokens: 1, outputTokens: 1 },
    llmRequests: 1,
    latencyMs: 1,
    summaryJob: null,
    errorCode: null,
    failedAttempts: [],
    pausedUntil: null,
    handoffReason: null,
    action: null,
    postJobs: [],
    ...overrides,
  };
}

class FakeSender implements WhatsAppSender {
  texts: string[] = [];
  lists: ListMessage[] = [];
  typing: string[] = [];
  fail: Error | null = null;
  async sendText(_from: string, _to: string, body: string) {
    if (this.fail) throw this.fail;
    this.texts.push(body);
    return { waMessageId: `wamid.out.${this.texts.length}` };
  }
  async sendList(_from: string, _to: string, list: ListMessage) {
    if (this.fail) throw this.fail;
    this.lists.push(list);
    return { waMessageId: 'wamid.list' };
  }
  buttons: Array<{ body: string; buttons: Array<{ id: string; title: string }> }> = [];
  templates: Array<{ name: string; bodyParams: string[]; quickReplyPayloads: string[] }> = [];
  async sendButtons(_f: string, _t: string, m: { body: string; buttons: Array<{ id: string; title: string }> }) {
    if ((this as { fail?: Error | null }).fail) throw (this as { fail?: Error | null }).fail;
    this.buttons.push(m);
    return { waMessageId: 'wamid.buttons' };
  }
  async sendTemplate(_f: string, _t: string, m: { name: string; language: string; bodyParams: string[]; quickReplyPayloads: string[] }) {
    if ((this as { fail?: Error | null }).fail) throw (this as { fail?: Error | null }).fail;
    this.templates.push(m);
    return { waMessageId: 'wamid.template' };
  }
  async markReadWithTyping(_from: string, id: string) {
    this.typing.push(id);
  }
}

function setup(opts: { handle?: (input: TurnInput) => Promise<TurnResult> | TurnResult; rateLimitPerHour?: number } = {}) {
  let now = T0;
  const store = new MemoryInboxStore();
  const sender = new FakeSender();
  const logger = new MemoryLogger();
  const inputs: TurnInput[] = [];
  const sent: Array<[string, string, string]> = [];
  const flow = new ConversationFlow({
    store,
    sender,
    logger,
    clock: { now: () => new Date(now) },
    markSent: async (t, m, w) => {
      sent.push([t, m, w]);
    },
    engine: {
      async handleTurn(input) {
        inputs.push(input);
        return opts.handle ? opts.handle(input) : turnResult(input);
      },
      runSummary: async () => true,
    },
    config: opts.rateLimitPerHour ? { rateLimitPerHour: opts.rateLimitPerHour } : {},
  });
  const item = (id: string, text = 'oi', atMs = now): InboxItem => ({
    waMessageId: id,
    kind: 'text',
    text,
    at: new Date(atMs).toISOString(),
    profileName: 'Maria',
  });
  return { flow, store, sender, logger, inputs, sent, item, advance: (ms: number) => (now += ms), now: () => now };
}

describe('fluxo da conversa', () => {
  it('reentrega da Meta é descartada, antes e depois de responder', async () => {
    const s = setup();
    expect(s.flow.enqueue(ROUTE, [s.item('A')])).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(s.flow.enqueue(ROUTE, [s.item('A')])).toMatchObject({ accepted: 0, duplicates: 1 });
    await s.flow.process();
    expect(s.flow.enqueue(ROUTE, [s.item('A')])).toMatchObject({ accepted: 0, duplicates: 1, alarmAt: null });
    await s.flow.process();
    expect(s.inputs).toHaveLength(1);
    expect(s.sender.texts).toHaveLength(1);
  });

  it('só esquece o estado depois de 8 dias sem mensagem, sem pendência nem pausa (LGPD)', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const s = setup();
    s.flow.enqueue(ROUTE, [s.item('A')]);
    expect(s.flow.canForget(8 * DAY)).toBe(false); // pendente
    await s.flow.process();
    expect(s.flow.canForget(8 * DAY)).toBe(false); // recente
    s.advance(8 * DAY);
    expect(s.flow.canForget(8 * DAY)).toBe(true);
    // Pausa da equipe ainda valendo segura o estado.
    s.store.setState('paused_until', new Date(s.now() + DAY).toISOString());
    expect(s.flow.canForget(8 * DAY)).toBe(false);
  });

  it('agrupa mensagens seguidas: 3 mensagens, 1 resposta', async () => {
    const s = setup();
    const r1 = s.flow.enqueue(ROUTE, [s.item('A', 'oi')]);
    expect(r1.alarmAt).toBe(T0 + 5_000);
    s.advance(2_000);
    expect(s.flow.enqueue(ROUTE, [s.item('B', 'tudo bem?')]).alarmAt).toBe(T0 + 7_000);
    s.advance(2_000);
    s.flow.enqueue(ROUTE, [s.item('C', 'quero marcar')]);
    s.advance(5_000);
    await s.flow.process();
    expect(s.inputs).toHaveLength(1);
    expect(s.inputs[0]!.messages.map((m) => m.text)).toEqual(['oi', 'tudo bem?', 'quero marcar']);
    expect(s.sender.texts).toEqual(['resposta para 3']);
  });

  it('espera no máximo 20 s desde a primeira mensagem', () => {
    const s = setup();
    s.flow.enqueue(ROUTE, [s.item('A')]);
    s.advance(18_000);
    expect(s.flow.enqueue(ROUTE, [s.item('B')]).alarmAt).toBe(T0 + 20_000);
  });

  it('mostra "digitando" para a última mensagem, mas não em conversa pausada', async () => {
    const s = setup({ handle: (input) =>
        turnResult(input, { outcome: 'paused', reply: null, replyMessageId: null, pausedUntil: new Date(T0 + 3_600_000).toISOString() }),
    });
    expect(s.flow.enqueue(ROUTE, [s.item('A'), s.item('B')]).typingFor).toBe('B');
    await s.flow.process();
    expect(s.sender.texts).toHaveLength(0);
    expect(s.flow.enqueue(ROUTE, [s.item('C')]).typingFor).toBeNull();
  });

  it('limite por hora: avisa uma vez e ignora o excesso', () => {
    const s = setup({ rateLimitPerHour: 3 });
    const r = s.flow.enqueue(ROUTE, ['A', 'B', 'C', 'D', 'E'].map((id) => s.item(id)));
    expect(r).toMatchObject({ accepted: 3, rateNotice: true });
    expect(s.flow.enqueue(ROUTE, [s.item('F')])).toMatchObject({ accepted: 0, rateNotice: false });
    s.advance(60 * 60_000);
    expect(s.flow.enqueue(ROUTE, [s.item('G')])).toMatchObject({ accepted: 1, rateNotice: false });
  });

  it('envia uma única mensagem e liga ao wamid', async () => {
    const s = setup();
    s.flow.enqueue(ROUTE, [s.item('A')]);
    await s.flow.process();
    expect(s.sender.texts).toEqual(['resposta para 1']);
    expect(s.sent).toEqual([['TEN', 'OUT', 'wamid.out.1']]);
    expect(s.store.pending()).toHaveLength(0);
  });

  it('com opções, envia lista interativa', async () => {
    const s = setup({
      handle: (input) => turnResult(input, { reply: { text: 'Horários:', options: [{ id: 'slot:1', title: 'Ter 15:00' }] } }),
    });
    s.flow.enqueue(ROUTE, [s.item('A')]);
    await s.flow.process();
    expect(s.sender.lists).toHaveLength(1);
    expect(s.sender.texts).toHaveLength(0);
  });

  it('fora da janela de 24h, não envia texto livre', async () => {
    const s = setup();
    s.flow.enqueue(ROUTE, [s.item('A', 'oi', T0 - 25 * 60 * 60_000)]);
    await s.flow.process();
    expect(s.sender.texts).toHaveLength(0);
    expect(s.logger.lines.some((l) => l.event === 'send_skipped_window_closed')).toBe(true);
  });

  it('falha no envio é registrada com o código da Meta e não repete', async () => {
    const s = setup();
    s.sender.fail = new WhatsAppError('recipient', 'x', 400, 131030);
    s.flow.enqueue(ROUTE, [s.item('A')]);
    await expect(s.flow.process()).resolves.toEqual({ nextAlarmAt: null });
    expect(s.logger.lines.find((l) => l.event === 'whatsapp_send_failed')).toMatchObject({ meta_code: 131030, error_code: 'recipient' });
    expect(s.store.pending()).toHaveLength(0);
  });

  it('se o motor falhar, as mensagens voltam para a fila e o alarme tenta de novo', async () => {
    let fail = true;
    const s = setup({
      handle: (input) => {
        if (fail) throw new Error('D1 fora do ar');
        return turnResult(input);
      },
    });
    s.flow.enqueue(ROUTE, [s.item('A')]);
    await expect(s.flow.process()).rejects.toThrow('D1 fora do ar');
    fail = false;
    await s.flow.process();
    expect(s.inputs).toHaveLength(2);
    expect(s.sender.texts).toHaveLength(1);
  });

  it('se caiu no meio do envio, não reenvia', async () => {
    const s = setup();
    s.flow.enqueue(ROUTE, [s.item('A')]);
    s.store.take(['A'], 'velho');
    s.store.setState('sending', JSON.stringify({ ids: ['A'], turnTag: 'velho' }));
    await s.flow.process();
    expect(s.inputs).toHaveLength(0);
    expect(s.sender.texts).toHaveLength(0);
    expect(s.logger.lines.some((l) => l.event === 'send_uncertain_skipped')).toBe(true);
  });

  it('mensagem que chega durante o processamento fica para o próximo turno', async () => {
    const s = setup({
      handle: (input) => {
        if (s.inputs.length === 1) s.flow.enqueue(ROUTE, [s.item('B', 'chegou depois')]);
        return turnResult(input);
      },
    });
    s.flow.enqueue(ROUTE, [s.item('A')]);
    const first = await s.flow.process();
    expect(first.nextAlarmAt).not.toBeNull();
    await s.flow.process();
    expect(s.inputs.map((i) => i.messages.map((m) => m.text))).toEqual([['oi'], ['chegou depois']]);
  });
});

describe('rotas do webhook', () => {
  const SECRET = 'app-secret';
  const route: PhoneRoute = { tenantId: 'TEN', phoneNumberId: 'PN', metaAccountId: 'MA' };

  function makeApp(over: Partial<WebhookDeps> = {}) {
    const delivered: Array<{ waId: string; items: InboxItem[] }> = [];
    const statuses: string[] = [];
    const logger = new MemoryLogger();
    const deps: WebhookDeps = {
      verifyToken: 'verify-123',
      appSecret: SECRET,
      logger,
      resolveRoute: async (id) => (id === '100000000000001' ? route : null),
      deliver: async (_r, _meta, waId, items) => {
        delivered.push({ waId, items });
      },
      recordStatus: async (_r, st) => {
        statuses.push(`${st.waMessageId}:${st.status}`);
      },
      ...over,
    };
    return { app: createApp<object>(() => deps), delivered, statuses, logger };
  }

  async function post(app: ReturnType<typeof makeApp>['app'], body: unknown, secret = SECRET, raw?: string) {
    const text = raw ?? JSON.stringify(body);
    const sig = await signBody(secret, new TextEncoder().encode(text));
    return app.request('/webhook', { method: 'POST', body: text, headers: { 'x-hub-signature-256': `sha256=${sig}` } });
  }

  it('verificação: devolve o challenge só com o token certo', async () => {
    const { app } = makeApp();
    const ok = await app.request('/webhook?hub.mode=subscribe&hub.verify_token=verify-123&hub.challenge=4242');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('4242');
    expect((await app.request('/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1')).status).toBe(403);
  });

  it('assinatura inválida: 401 e nada é entregue', async () => {
    const { app, delivered } = makeApp();
    const res = await post(app, sampleWebhook({ messages: [] }), 'segredo-errado');
    expect(res.status).toBe(401);
    expect(delivered).toHaveLength(0);
  });

  it('sem App Secret configurado: 500', async () => {
    const { app } = makeApp({ appSecret: undefined });
    expect((await post(app, {})).status).toBe(500);
  });

  it('entrega mensagens agrupadas por cliente e registra status', async () => {
    const { app, delivered, statuses } = makeApp();
    const res = await post(
      app,
      sampleWebhook({
        messages: [
          { from: '5511999990001', id: 'w1', timestamp: '1790000000', type: 'text', text: { body: 'oi' } },
          { from: '5511999990001', id: 'w2', timestamp: '1790000001', type: 'text', text: { body: 'tudo bem?' } },
          { from: '5511999990002', id: 'w3', timestamp: '1790000002', type: 'text', text: { body: 'olá' } },
        ],
        statuses: [{ id: 'wamid.X', status: 'delivered', timestamp: '1', recipient_id: '1' }],
      }),
    );
    expect(res.status).toBe(200);
    expect(delivered.map((d) => [d.waId, d.items.map((i) => i.text)])).toEqual([
      ['5511999990001', ['oi', 'tudo bem?']],
      ['5511999990002', ['olá']],
    ]);
    expect(delivered[0]!.items[0]).toMatchObject({ waMessageId: 'w1', kind: 'text', profileName: 'Maria' });
    expect(statuses).toEqual(['wamid.X:delivered']);
  });

  it('número desconhecido: responde 200 e ignora', async () => {
    const { app, delivered } = makeApp();
    const res = await post(
      app,
      sampleWebhook({ phoneId: '999', messages: [{ from: '1', id: 'w', timestamp: '1', type: 'text', text: { body: 'oi' } }] }),
    );
    expect(res.status).toBe(200);
    expect(delivered).toHaveLength(0);
  });

  it('falha ao entregar: 500 para a Meta reenviar', async () => {
    const { app } = makeApp({
      deliver: async () => {
        throw new Error('objeto indisponível');
      },
    });
    const res = await post(app, sampleWebhook({ messages: [{ from: '1', id: 'w', timestamp: '1', type: 'text', text: { body: 'oi' } }] }));
    expect(res.status).toBe(500);
  });

  it('JSON inválido com assinatura válida: 200 (reenviar não adianta)', async () => {
    const { app } = makeApp();
    expect((await post(app, null, SECRET, '{não é json')).status).toBe(200);
  });

  it('logs do webhook não têm telefone nem texto', async () => {
    const { app, logger } = makeApp();
    await post(app, sampleWebhook({ messages: [{ from: '5511999990001', id: 'w', timestamp: '1', type: 'text', text: { body: 'segredo' } }] }));
    const dump = JSON.stringify(logger.lines);
    expect(dump).not.toContain('5511999990001');
    expect(dump).not.toContain('segredo');
    expect(dump).not.toContain('Maria');
  });
});
