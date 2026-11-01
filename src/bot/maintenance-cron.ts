import { eraseContactData } from '../core/erasure.ts';
import { systemClock } from '../ports/runtime.ts';
import { monthKey } from '../shared/time.ts';
import type { Env } from './env.ts';
import { conversationStub, createCalendar, createNotifiers, createRepo, logger } from './services.ts';

/** Pedidos de exclusão por rodada (~6 subrequisições cada; teto de 50). */
const ERASURES_PER_RUN = 3;
const DEFAULT_BILLED_ALERT = 800;

/**
 * Cron de hora em hora:
 * - pedidos de exclusão feitos pelo terminal (npm run lgpd:apagar);
 * - alerta ao operador quando um número passa do limite de mensagens de
 *   serviço cobradas pela Meta no mês (uma vez por número por mês).
 * Cada parte falha sozinha.
 */
export async function runMaintenanceCron(env: Env): Promise<void> {
  const repo = createRepo(env);

  try {
    const pending = await repo.ops.pendingErasures(ERASURES_PER_RUN);
    for (const req of pending) {
      await eraseContactData(req.tenantId, req.waId, {
        repo,
        calendar: createCalendar(env),
        logger,
        wipeConversation: (metaPhoneNumberId, waId) => conversationStub(env, { metaPhoneNumberId, waId }).wipe(),
      });
    }
  } catch (err) {
    logger.error('erasure_requests_failed', { error_code: err instanceof Error ? err.name : 'unknown' });
  }

  try {
    const { operator } = createNotifiers(env, repo);
    if (!operator) return;
    const month = monthKey(systemClock.now());
    const min = Number(env.META_BILLED_ALERT) > 0 ? Number(env.META_BILLED_ALERT) : DEFAULT_BILLED_ALERT;
    for (const row of await repo.ops.billedOverThreshold(month, min)) {
      const key = `billed_alert:${row.phoneNumberId}:${month}`;
      if (await repo.ops.getSetting(key)) continue;
      await operator.notifyOperator(
        key,
        `⚠️ Mensagens cobradas pela Meta: o número ${row.displayPhone} (${row.tenantName}) já tem ${row.billed} ` +
          `mensagens de serviço cobradas em ${month}. Cada uma custa ~R$ 0,035 (terceiros citam 1.000 grátis por mês, sem confirmação oficial).`,
      );
      await repo.ops.setSetting(key, systemClock.now().toISOString(), systemClock.now().toISOString());
    }
  } catch (err) {
    logger.error('billed_alert_failed', { error_code: err instanceof Error ? err.name : 'unknown' });
  }
}
