import { runPostJobs } from '../core/scheduling-jobs.ts';
import { REMINDER_TEMPLATE, sendDueReminders } from '../core/reminders.ts';
import { systemClock } from '../ports/runtime.ts';
import type { Env } from './env.ts';
import { createCalendar, createRepo, createSender, logger } from './services.ts';

/** Sincronização parada há mais disso volta a ser tentada pelo cron. */
const SYNC_IDLE_MS = 5 * 60 * 1000;
/** ~3 subrequisições cada (ver REMINDER_BATCH): cabe no limite de 50 com os lembretes. */
const SYNC_BATCH = 3;

/**
 * Cron a cada 15 minutos: lembretes do dia seguinte e nova tentativa de
 * levar agendamentos à agenda Google da empresa. Cada parte falha sozinha.
 */
export async function runSchedulingCron(env: Env): Promise<void> {
  const repo = createRepo(env);
  const now = systemClock.now();

  try {
    const report = await sendDueReminders({
      ops: repo.schedulingOps,
      sender: createSender(env, repo),
      saveMessage: ({ tenantId, ...record }) => repo.forTenant(tenantId).saveBotMessage(record),
      clock: systemClock,
      logger,
      template: env.REMINDER_TEMPLATE?.trim() ? { name: env.REMINDER_TEMPLATE.trim(), language: REMINDER_TEMPLATE.language } : null,
    });
    if (report.due) logger.info('reminders_done', { ...report });
  } catch (err) {
    logger.error('reminders_failed', { error_code: err instanceof Error ? err.name : 'unknown' });
  }

  try {
    const pending = await repo.schedulingOps.pendingCalendarSync(
      SYNC_BATCH,
      new Date(now.getTime() - SYNC_IDLE_MS).toISOString(),
    );
    if (pending.length) {
      await runPostJobs(
        pending.map((p) => ({ kind: 'calendar_sync' as const, tenantId: p.tenantId, appointmentId: p.appointmentId })),
        { repo, calendar: createCalendar(env), clock: systemClock, logger },
      );
      logger.info('calendar_sync_retried', { count: pending.length });
    }
  } catch (err) {
    logger.error('calendar_sync_retry_failed', { error_code: err instanceof Error ? err.name : 'unknown' });
  }
}
