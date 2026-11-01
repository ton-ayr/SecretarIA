import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D1Repo } from '../src/adapters/d1-repo.ts';
import { OPERATOR_CHAT_KEY, OPERATOR_LINK_KEY, TelegramOperatorNotifier, TelegramTeamNotifier } from '../src/adapters/telegram-notifier.ts';
import { RESUME_KEYBOARD, TelegramError, telegramChatRef } from '../src/adapters/telegram.ts';
import { createApp, type WebhookDeps } from '../src/bot/app.ts';
import { handleTelegramUpdate, type TelegramWebhookDeps } from '../src/bot/telegram-webhook.ts';
import { TELEGRAM_TEXTS } from '../src/core/team-messages.ts';
import { decryptSecret, encryptSecret, generateKey } from '../src/shared/crypto.ts';
import { MemoryLogger } from '../src/shared/logger.ts';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';

const KEY = generateKey();
const NOW = '2026-10-14T13:00:00.000Z';
const clock = { now: () => new Date(NOW) };

let mem: LocalPlatform;
let repo: D1Repo;

beforeAll(async () => {
  mem = await createMemoryDb({ seed: true });
  repo = new D1Repo(mem.db);
});
afterAll(() => mem.dispose());

/** Telegram falso: guarda o que seria enviado. */
class FakeTg {
  sent: Array<{ chatId: number | string; text: string; keyboard?: unknown }> = [];
  reactions: Array<[number | string, number, string]> = [];
  answers: Array<[string, string | undefined]> = [];
  removed: Array<[number | string, number]> = [];
  failFor = new Set<string>();
  private nextId = 1000;
  async sendMessage(chatId: number | string, text: string, opts: { keyboard?: unknown } = {}) {
    if (this.failFor.has(String(chatId))) throw new TelegramError(403, 'bloqueado');
    this.sent.push({ chatId, text, keyboard: opts.keyboard });
    return { messageId: this.nextId++ };
  }
  async react(chatId: number | string, messageId: number, emoji: string) {
    this.reactions.push([chatId, messageId, emoji]);
  }
  async answerCallbackQuery(id: string, text?: string) {
    this.answers.push([id, text]);
  }
  async removeKeyboard(chatId: number | string, messageId: number) {
    this.removed.push([chatId, messageId]);
  }
}

async function addChannel(id: string, tenantId: string, chatId: number | null, extra: { code?: string; expires?: string } = {}) {
  await mem.db
    .prepare(
      `INSERT INTO notification_channels (id, tenant_id, kind, target_enc, target_ref, link_code, link_expires_at, active, created_at)
       VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      chatId === null ? null : await encryptSecret(KEY, String(chatId)),
      chatId === null ? null : await telegramChatRef(KEY, chatId),
      extra.code ?? null,
      extra.expires ?? null,
      chatId === null ? 0 : 1,
      NOW,
    )
    .run();
}

async function newConversation(tenant: 'barber' | 'dental', waId: string) {
  const ctx = await repo.forTenant(SEED[tenant].tenantId).loadTurnContext({
    phoneNumberId: SEED[tenant].phoneNumberId,
    waId,
    profileName: 'Cliente',
    now: NOW,
    newContactId: `C-${waId}`,
    newConversationId: `V-${waId}`,
  });
  return ctx!.conversation.id;
}

describe('notificador da equipe (Telegram)', () => {
  it('envia para cada canal ativo, com botão, e registra a ligação com a conversa', async () => {
    await addChannel('N1', SEED.dental.tenantId, 111);
    await addChannel('N2', SEED.dental.tenantId, 222);
    await addChannel('N3', SEED.dental.tenantId, 333);
    const conversationId = await newConversation('dental', '5511900000001');
    const tg = new FakeTg();
    tg.failFor.add('222'); // um canal falhando não impede os outros
    const notifier = new TelegramTeamNotifier({ repo, tg, encryptionKey: KEY, clock, logger: new MemoryLogger() });

    const count = await notifier.notifyHandoff({
      tenantId: SEED.dental.tenantId,
      tenantName: 'Sorriso',
      conversationId,
      waId: '5511900000001',
      contactName: 'Ana',
      reason: 'customer_request',
      summary: null,
      recentCustomerMessages: ['quero falar com alguém'],
    });

    expect(count).toBe(2);
    expect(tg.sent.map((s) => s.chatId).sort()).toEqual(['111', '333']);
    expect(tg.sent[0]!.keyboard).toEqual(RESUME_KEYBOARD);
    const relay = await repo.findTelegramRelay(await telegramChatRef(KEY, 111), 1000);
    expect(relay).toEqual({ tenantId: SEED.dental.tenantId, conversationId });
  });
});

describe('alertas do operador', () => {
  it('só envia com chat vinculado e não repete o mesmo tipo dentro de 1 hora', async () => {
    const tg = new FakeTg();
    let now = Date.parse(NOW);
    const op = new TelegramOperatorNotifier({
      repo,
      tg,
      encryptionKey: KEY,
      clock: { now: () => new Date(now) },
      logger: new MemoryLogger(),
    });
    await op.notifyOperator('quota:x', 'Cota em 70%');
    expect(tg.sent).toHaveLength(0);

    await repo.ops.setSetting(OPERATOR_CHAT_KEY, await encryptSecret(KEY, '999'), NOW);
    await op.notifyOperator('quota:x', 'Cota em 70% <&>');
    await op.notifyOperator('quota:x', 'de novo');
    await op.notifyOperator('outro', 'outro alerta');
    now += 61 * 60_000;
    await op.notifyOperator('quota:x', 'uma hora depois');
    expect(tg.sent.map((s) => s.text)).toEqual(['Cota em 70% &lt;&amp;&gt;', 'outro alerta', 'uma hora depois']);
    await repo.ops.deleteSetting(OPERATOR_CHAT_KEY);
  });
});

describe('webhook do Telegram', () => {
  let tg: FakeTg;
  let replies: Array<[string, string, string]>;
  let resumes: Array<[string, string]>;
  let replyStatus: 'sent' | 'window_closed' | 'failed' | 'not_found';
  let deps: TelegramWebhookDeps;

  beforeEach(() => {
    tg = new FakeTg();
    replies = [];
    resumes = [];
    replyStatus = 'sent';
    deps = {
      secret: 'segredo',
      encryptionKey: KEY,
      logger: new MemoryLogger(),
      clock,
      repo,
      tg,
      humanReply: async (t, c, text) => {
        replies.push([t, c, text]);
        return replyStatus;
      },
      resume: async (t, c) => {
        resumes.push([t, c]);
        return true;
      },
    };
  });

  const privateMsg = (chatId: number, extra: Record<string, unknown>) => ({
    message: { message_id: 5000, chat: { id: chatId, type: 'private' }, ...extra },
  });

  it('vincula o chat com o link de uso único', async () => {
    await addChannel('L1', SEED.barber.tenantId, null, { code: 'CODIGO123', expires: '2026-10-15T00:00:00.000Z' });
    await handleTelegramUpdate(privateMsg(4242, { text: '/start CODIGO123' }), deps);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.linked('Barbearia do Zé'));

    const row = await mem.db.prepare('SELECT active, target_enc, target_ref, link_code FROM notification_channels WHERE id = ?').bind('L1').first<Record<string, string | number>>();
    expect(row!.active).toBe(1);
    expect(row!.link_code).toBeNull();
    expect(row!.target_ref).toBe(await telegramChatRef(KEY, 4242));
    expect(await decryptSecret(KEY, String(row!.target_enc))).toBe('4242');

    // Uso único: o mesmo link não serve de novo.
    await handleTelegramUpdate(privateMsg(5353, { text: '/start CODIGO123' }), deps);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.invalidLink);
  });

  it('recusa link vencido', async () => {
    await addChannel('L2', SEED.barber.tenantId, null, { code: 'VENCIDO1', expires: '2026-10-14T12:59:00.000Z' });
    await handleTelegramUpdate(privateMsg(4243, { text: '/start VENCIDO1' }), deps);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.invalidLink);
  });

  it('vincula o operador com o código op_', async () => {
    await repo.ops.setSetting(OPERATOR_LINK_KEY, 'OPCODE|2026-10-15T00:00:00.000Z', NOW);
    await handleTelegramUpdate(privateMsg(777, { text: '/start op_ERRADO' }), deps);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.invalidLink);
    await handleTelegramUpdate(privateMsg(777, { text: '/start op_OPCODE' }), deps);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.operatorLinked);
    expect(await decryptSecret(KEY, (await repo.ops.getSetting(OPERATOR_CHAT_KEY))!)).toBe('777');
    expect(await repo.ops.getSetting(OPERATOR_LINK_KEY)).toBeNull();
    await repo.ops.deleteSetting(OPERATOR_CHAT_KEY);
  });

  async function relayFor(tenant: 'barber' | 'dental', chatId: number, tgMessageId: number, waId: string) {
    const conversationId = await newConversation(tenant, waId);
    await repo
      .forTenant(SEED[tenant].tenantId)
      .addTelegramRelays([{ chatRef: await telegramChatRef(KEY, chatId), tgMessageId, conversationId }], NOW);
    return conversationId;
  }

  it('resposta do dono vai para a conversa certa e recebe 👍', async () => {
    await addChannel('R1', SEED.barber.tenantId, 6001);
    const conversationId = await relayFor('barber', 6001, 70, '5511900000010');
    await handleTelegramUpdate(privateMsg(6001, { text: 'Oi! Aqui é o Zé.', reply_to_message: { message_id: 70 } }), deps);
    expect(replies).toEqual([[SEED.barber.tenantId, conversationId, 'Oi! Aqui é o Zé.']]);
    expect(tg.reactions).toEqual([[6001, 5000, '👍']]);
  });

  it('chat de outra empresa nunca alcança a conversa', async () => {
    await addChannel('R2', SEED.barber.tenantId, 6002);
    await addChannel('R3', SEED.dental.tenantId, 6003);
    await relayFor('barber', 6002, 71, '5511900000011');
    // O chat do consultório responde a uma mensagem com o mesmo número (71).
    await handleTelegramUpdate(privateMsg(6003, { text: 'tentando invadir', reply_to_message: { message_id: 71 } }), deps);
    expect(replies).toHaveLength(0);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.relayNotFound);
  });

  it('chat desvinculado não responde mais', async () => {
    await addChannel('R4', SEED.barber.tenantId, 6004);
    await relayFor('barber', 6004, 72, '5511900000012');
    await mem.db.prepare("UPDATE notification_channels SET active = 0 WHERE id = 'R4'").run();
    await handleTelegramUpdate(privateMsg(6004, { text: 'oi', reply_to_message: { message_id: 72 } }), deps);
    expect(replies).toHaveLength(0);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.chatUnlinked);
  });

  it('janela de 24 h fechada ou falha: avisa o dono', async () => {
    await addChannel('R5', SEED.barber.tenantId, 6005);
    await relayFor('barber', 6005, 73, '5511900000013');
    replyStatus = 'window_closed';
    await handleTelegramUpdate(privateMsg(6005, { text: 'oi', reply_to_message: { message_id: 73 } }), deps);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.windowClosed);
    replyStatus = 'failed';
    await handleTelegramUpdate(privateMsg(6005, { text: 'oi', reply_to_message: { message_id: 73 } }), deps);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.sendFailed);
  });

  it('foto ou figurinha como resposta: só texto por enquanto', async () => {
    await addChannel('R6', SEED.barber.tenantId, 6006);
    await relayFor('barber', 6006, 74, '5511900000014');
    await handleTelegramUpdate(privateMsg(6006, { photo: [{}], reply_to_message: { message_id: 74 } }), deps);
    expect(replies).toHaveLength(0);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.onlyText);
  });

  it('botão "Devolver ao bot": devolve a conversa da mensagem do botão', async () => {
    await addChannel('R7', SEED.barber.tenantId, 6007);
    const conversationId = await relayFor('barber', 6007, 75, '5511900000015');
    await handleTelegramUpdate(
      { callback_query: { id: 'cb1', data: 'resume', message: { message_id: 75, chat: { id: 6007, type: 'private' } } } },
      deps,
    );
    expect(resumes).toEqual([[SEED.barber.tenantId, conversationId]]);
    expect(tg.answers).toEqual([['cb1', TELEGRAM_TEXTS.resumed]]);
    expect(tg.removed).toEqual([[6007, 75]]);

    // Botão de uma mensagem de outro chat: nada acontece.
    await handleTelegramUpdate(
      { callback_query: { id: 'cb2', data: 'resume', message: { message_id: 75, chat: { id: 9999, type: 'private' } } } },
      deps,
    );
    expect(resumes).toHaveLength(1);
    expect(tg.answers.at(-1)).toEqual(['cb2', TELEGRAM_TEXTS.conversationNotFound]);
  });

  it('mensagem solta: dica para quem está vinculado, aviso para os outros; grupos são ignorados', async () => {
    await addChannel('R8', SEED.barber.tenantId, 6008);
    await handleTelegramUpdate(privateMsg(6008, { text: 'oi' }), deps);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.howToReply);
    await handleTelegramUpdate(privateMsg(1234, { text: 'oi' }), deps);
    expect(tg.sent.at(-1)!.text).toBe(TELEGRAM_TEXTS.notLinked);
    const count = tg.sent.length;
    await handleTelegramUpdate({ message: { message_id: 1, chat: { id: -100, type: 'group' }, text: '/start X' } }, deps);
    expect(tg.sent).toHaveLength(count);
  });

  it('rota exige o cabeçalho secreto do Telegram', async () => {
    const noWhatsApp = {} as WebhookDeps;
    const app = createApp<object>(() => noWhatsApp, () => deps);
    const body = JSON.stringify(privateMsg(1234, { text: 'oi' }));
    expect((await app.request('/telegram/webhook', { method: 'POST', body })).status).toBe(401);
    const bad = await app.request('/telegram/webhook', {
      method: 'POST',
      body,
      headers: { 'x-telegram-bot-api-secret-token': 'errado' },
    });
    expect(bad.status).toBe(401);
    const ok = await app.request('/telegram/webhook', {
      method: 'POST',
      body,
      headers: { 'x-telegram-bot-api-secret-token': 'segredo' },
    });
    expect(ok.status).toBe(200);
    const off = createApp<object>(() => noWhatsApp, () => null);
    expect((await off.request('/telegram/webhook', { method: 'POST', body })).status).toBe(404);
  });
});
