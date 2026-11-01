import { WorkerEntrypoint } from 'cloudflare:workers';
import { MetaGraphError, listWabaPhoneNumbers } from '../adapters/meta-graph.ts';
import { checkCalendarAccess } from '../core/calendar-check.ts';
import { eraseContactData } from '../core/erasure.ts';
import { TEST_PHONE_PREFIX, TEST_WA_ID } from '../ports/admin.ts';
import type {
  BotAdminApi,
  CalendarCheck,
  ErasureReport,
  MetaNumber,
  TestTurnInput,
  TestTurnResult,
} from '../ports/bot-admin.ts';
import { decryptSecret, encryptSecret } from '../shared/crypto.ts';
import { ulid } from '../shared/ids.ts';
import { parseServiceAccount } from '../adapters/google-calendar.ts';
import type { Env } from './env.ts';
import {
  conversationStub,
  createCalendar,
  createRepo,
  createTelegram,
  forgetMetaTokens,
  logger,
} from './services.ts';

/**
 * RPC do painel (named entrypoint). Só é alcançável pelo service binding do
 * Worker "admin", que já passou pelo Cloudflare Access. Mesmo assim, toda
 * entrada é conferida aqui: os segredos ficam neste Worker.
 */

const ID_RE = /^[0-9A-Za-z]{10,40}$/;
const WA_ID_RE = /^\d{5,20}$/;
const WABA_RE = /^\d{5,30}$/;
const CALENDAR_ID_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function assertId(value: string, what: string): void {
  if (!ID_RE.test(value)) throw new Error(`${what} inválido`);
}

let botUsername: string | null = null;

export class AdminRpc extends WorkerEntrypoint<Env> implements BotAdminApi {
  async testTurn(tenantId: string, input: TestTurnInput): Promise<TestTurnResult> {
    assertId(tenantId, 'tenantId');
    const stub = this.env.TEST_CHAT.get(this.env.TEST_CHAT.idFromName(`test:${tenantId}`));
    return stub.turn(tenantId, {
      text: typeof input.text === 'string' ? input.text.slice(0, 1000) : undefined,
      replyId: typeof input.replyId === 'string' ? input.replyId.slice(0, 200) : undefined,
      title: typeof input.title === 'string' ? input.title.slice(0, 100) : undefined,
    });
  }

  async resetTest(tenantId: string): Promise<void> {
    assertId(tenantId, 'tenantId');
    // Os horários do teste nunca foram para o Google (agenda só lida).
    await eraseContactData(tenantId, TEST_WA_ID, {
      repo: createRepo(this.env),
      logger,
      wipeConversation: async () => {},
    });
  }

  async resumeConversation(tenantId: string, conversationId: string): Promise<boolean> {
    assertId(tenantId, 'tenantId');
    assertId(conversationId, 'conversationId');
    const tenantRepo = createRepo(this.env).forTenant(tenantId);
    const route = await tenantRepo.getConversationRoute(conversationId);
    if (!route) return false;
    if (route.metaPhoneNumberId.startsWith(TEST_PHONE_PREFIX)) {
      await tenantRepo.resumeBot(conversationId, new Date().toISOString());
    } else {
      await conversationStub(this.env, route).resume({ tenantId, conversationId });
    }
    logger.info('conversation_resumed_by_admin', { tenant_id: tenantId, conversation_id: conversationId });
    return true;
  }

  async eraseContact(tenantId: string, waId: string): Promise<ErasureReport> {
    assertId(tenantId, 'tenantId');
    if (!WA_ID_RE.test(waId) && waId !== TEST_WA_ID) throw new Error('waId inválido');
    return eraseContactData(tenantId, waId, {
      repo: createRepo(this.env),
      calendar: createCalendar(this.env),
      logger,
      wipeConversation: (metaPhoneNumberId, wa) => conversationStub(this.env, { metaPhoneNumberId, waId: wa }).wipe(),
    });
  }

  async saveMetaAccount(wabaId: string, token: string): Promise<void> {
    const clean = token.trim();
    if (!WABA_RE.test(wabaId)) throw new Error('WABA inválida');
    if (!/^[A-Za-z0-9_-]{20,1000}$/.test(clean)) throw new Error('token inválido');
    if (!this.env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY não configurada');
    const sealed = await encryptSecret(this.env.ENCRYPTION_KEY, clean);
    await createRepo(this.env).ops.upsertMetaAccount(ulid(), wabaId, sealed, 1, new Date().toISOString());
    forgetMetaTokens();
    logger.info('meta_account_saved_by_admin');
  }

  async listMetaNumbers(metaAccountId: string): Promise<{ numbers: MetaNumber[] } | { error: string }> {
    assertId(metaAccountId, 'metaAccountId');
    const secret = await createRepo(this.env).ops.getMetaAccountSecret(metaAccountId);
    if (!secret) return { error: 'Essa conta Meta não tem token gravado.' };
    if (!this.env.ENCRYPTION_KEY) return { error: 'O bot está sem ENCRYPTION_KEY.' };
    try {
      const token = await decryptSecret(this.env.ENCRYPTION_KEY, secret.accessTokenEnc);
      const numbers = await listWabaPhoneNumbers({ graphVersion: this.env.GRAPH_API_VERSION, token, wabaId: secret.wabaId });
      return { numbers };
    } catch (err) {
      if (err instanceof MetaGraphError) {
        return { error: `A Meta recusou a consulta (HTTP ${err.status}). Confira o token e as permissões da conta.` };
      }
      logger.error('meta_numbers_failed', { error_code: err instanceof Error ? err.name : 'unknown' });
      return { error: 'Não consegui falar com a Meta agora. Tente de novo.' };
    }
  }

  async checkCalendar(calendarId: string): Promise<CalendarCheck> {
    if (!CALENDAR_ID_RE.test(calendarId)) {
      return { read: false, write: false, busy: 0, problem: 'ID de agenda inválido (é um e-mail).' };
    }
    const calendar = createCalendar(this.env);
    if (!calendar) {
      return { read: false, write: false, busy: 0, problem: 'A chave da conta de serviço do Google não está no bot.' };
    }
    return checkCalendarAccess(calendar, calendarId, new Date());
  }

  async googleServiceAccount(): Promise<string | null> {
    const raw = this.env.GOOGLE_SERVICE_ACCOUNT?.trim();
    if (!raw) return null;
    try {
      return parseServiceAccount(raw).client_email;
    } catch {
      return null;
    }
  }

  async telegramBotUsername(): Promise<string | null> {
    if (botUsername) return botUsername;
    const tg = createTelegram(this.env);
    if (!tg) return null;
    try {
      botUsername = (await tg.getMe()).username;
      return botUsername;
    } catch {
      return null;
    }
  }
}
