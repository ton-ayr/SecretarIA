import { D1AdminRepo } from '../../src/adapters/d1-admin.ts';
import { createAdminApp } from '../../src/admin/app.tsx';
import type { AdminDeps } from '../../src/admin/context.ts';
import type { BotAdminApi, CalendarCheck, TestTurnInput, TestTurnResult } from '../../src/ports/bot-admin.ts';
import { MemoryLogger } from '../../src/shared/logger.ts';

export const ORIGIN = 'http://admin.test';
export const OPERATOR = 'operador@exemplo.dev';

/** Bot de mentira: registra as chamadas do painel. */
export class FakeBot implements BotAdminApi {
  calls: Array<[string, ...unknown[]]> = [];
  testReplies: TestTurnResult[] = [];
  calendar: CalendarCheck = { read: true, write: true, busy: 0, problem: null };
  metaNumbers: Awaited<ReturnType<BotAdminApi['listMetaNumbers']>> = { numbers: [] };
  failSaveMeta = false;

  async testTurn(tenantId: string, input: TestTurnInput): Promise<TestTurnResult> {
    this.calls.push(['testTurn', tenantId, input]);
    return this.testReplies.shift() ?? { outcome: 'replied', reply: { text: 'Oi!' }, action: null, handoff: false, errorCode: null };
  }
  async resetTest(tenantId: string) {
    this.calls.push(['resetTest', tenantId]);
  }
  async resumeConversation(tenantId: string, conversationId: string) {
    this.calls.push(['resumeConversation', tenantId, conversationId]);
    return true;
  }
  async eraseContact(tenantId: string, waId: string) {
    this.calls.push(['eraseContact', tenantId, waId]);
    return { contacts: 1, conversations: 1, messages: 3, appointments: 0, calendarEvents: 0, calendarFailures: 0, stateWipeFailures: 0 };
  }
  async saveMetaAccount(wabaId: string, token: string) {
    this.calls.push(['saveMetaAccount', wabaId, token.length]);
    if (this.failSaveMeta) throw new Error('falhou');
  }
  async listMetaNumbers(metaAccountId: string) {
    this.calls.push(['listMetaNumbers', metaAccountId]);
    return this.metaNumbers;
  }
  async checkCalendar(calendarId: string) {
    this.calls.push(['checkCalendar', calendarId]);
    return this.calendar;
  }
  async googleServiceAccount() {
    return 'secretaria@projeto.iam.gserviceaccount.com';
  }
  async telegramBotUsername() {
    return 'SecretariaTesteBot';
  }
}

export function adminApp(db: D1Database, opts: { email?: string | null; bot?: FakeBot; now?: string } = {}) {
  const bot = opts.bot ?? new FakeBot();
  const logger = new MemoryLogger();
  const email = opts.email === undefined ? OPERATOR : opts.email;
  const deps: AdminDeps = {
    repo: new D1AdminRepo(db),
    bot,
    identify: async () => email,
    allowedEmails: [OPERATOR],
    clock: { now: () => new Date(opts.now ?? '2026-10-13T11:00:00.000Z') },
    logger,
    metaPriceBrlMilli: 35,
  };
  const app = createAdminApp<object>(() => deps);
  const get = (path: string) => app.request(`${ORIGIN}${path}`);
  const post = (path: string, form: Record<string, string | string[]>, origin: string | null = ORIGIN) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (origin) headers.origin = origin;
    return app.request(`${ORIGIN}${path}`, { method: 'POST', body, headers });
  };
  return { app, bot, logger, get, post };
}
