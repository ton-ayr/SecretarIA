import { monthKey } from '../shared/time.ts';
import { createApp, type WebhookDeps } from './app.ts';
import type { Env } from './env.ts';
import { systemClock } from '../ports/runtime.ts';
import type { TelegramWebhookDeps } from './telegram-webhook.ts';
import { runSchedulingCron } from './scheduling-cron.ts';
import { runMaintenanceCron } from './maintenance-cron.ts';
import { conversationStub, createRepo, createTelegram, logger, resolveRoute } from './services.ts';

// Worker público: webhook da Meta, link da agenda, Durable Objects (conversas
// e chat de teste do painel), RPC do painel (AdminRpc, só por service
// binding) e crons: limpeza diária, manutenção de hora em hora (pedidos de
// exclusão, alerta de mensagens cobradas) e, a cada 15 min, lembretes e agenda
// Google.

/** Iguais aos crons do wrangler.jsonc. */
const DAILY_CRON = '0 6 * * *';
const HOURLY_CRON = '17 * * * *';

export { AdminRpc } from './admin-rpc.ts';
export { ConversationDO } from './conversation-do.ts';
export { TestChatDO } from './test-chat-do.ts';
export type { Env } from './env.ts';

function webhookDeps(env: Env): WebhookDeps {
  const repo = createRepo(env);
  return {
    verifyToken: env.META_VERIFY_TOKEN,
    appSecret: env.META_APP_SECRET,
    logger,
    resolveRoute: (metaPhoneNumberId) => resolveRoute(repo, metaPhoneNumberId),
    async deliver(route, metaPhoneNumberId, waId, items) {
      const r = await conversationStub(env, { metaPhoneNumberId, waId }).enqueue({ metaPhoneNumberId, waId }, items);
      if (r.duplicates) logger.info('webhook_duplicates', { tenant_id: route.tenantId, duplicates: r.duplicates });
    },
    recordStatus: (route, st) =>
      repo.forTenant(route.tenantId).recordDeliveryStatus(route.phoneNumberId, monthKey(new Date()), st),
    findCalendarLink: (token) => repo.schedulingOps.findByCalendarToken(token),
  };
}

function telegramDeps(env: Env): TelegramWebhookDeps | null {
  const tg = createTelegram(env);
  if (!tg || !env.TELEGRAM_WEBHOOK_SECRET || !env.ENCRYPTION_KEY) return null;
  const repo = createRepo(env);
  return {
    secret: env.TELEGRAM_WEBHOOK_SECRET,
    encryptionKey: env.ENCRYPTION_KEY,
    logger,
    clock: systemClock,
    repo,
    tg,
    async humanReply(tenantId, conversationId, text) {
      const route = await repo.forTenant(tenantId).getConversationRoute(conversationId);
      if (!route) return 'not_found';
      return conversationStub(env, route).humanReply({
        tenantId,
        conversationId,
        phoneNumberId: route.phoneNumberId,
        text,
        lastCustomerMsgAt: route.lastCustomerMsgAt,
        resumeHours: route.handoffResumeHours,
        route: { metaPhoneNumberId: route.metaPhoneNumberId, waId: route.waId },
      });
    },
    async resume(tenantId, conversationId) {
      const route = await repo.forTenant(tenantId).getConversationRoute(conversationId);
      if (!route) return false;
      await conversationStub(env, route).resume({ tenantId, conversationId });
      return true;
    },
  };
}

const app = createApp<Env>(webhookDeps, telegramDeps);

export default {
  fetch: app.fetch,

  async scheduled(controller, env, ctx) {
    if (controller.cron === HOURLY_CRON) {
      ctx.waitUntil(runMaintenanceCron(env));
      return;
    }
    if (controller.cron !== DAILY_CRON) {
      ctx.waitUntil(runSchedulingCron(env));
      return;
    }
    // Limpeza LGPD (mensagens, contatos inativos, logs de turno, agenda antiga).
    ctx.waitUntil(
      createRepo(env)
        .ops.runRetention(new Date().toISOString())
        .then((report) => logger.info('retention_done', { ...report }))
        .catch((err: unknown) => logger.error('retention_failed', { error_code: err instanceof Error ? err.name : 'unknown' })),
    );
  },
} satisfies ExportedHandler<Env>;
