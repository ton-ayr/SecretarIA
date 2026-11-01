import { externalEventId, type ExternalCalendar } from '../ports/calendar.ts';
import type { HandoffNotifier } from '../ports/notifier.ts';
import type { Repo } from '../ports/repo.ts';
import type { Clock, Logger } from '../ports/runtime.ts';
import { formatWaId } from '../shared/phone.ts';
import { formatAppointmentTime } from '../shared/time.ts';
import type { PostJob } from './scheduling.ts';

/**
 * Trabalhos depois de responder ao cliente (não atrasam a resposta):
 * - calendar_sync: agendamento ativo vira evento na agenda Google da
 *   empresa; cancelado sai de lá. Falha fica 'failed' e o cron tenta de novo;
 * - notify_booking: aviso à equipe no Telegram.
 */
export interface PostJobDeps {
  repo: Repo;
  calendar?: ExternalCalendar;
  notifier?: HandoffNotifier;
  clock: Clock;
  logger: Logger;
}

export async function runPostJobs(jobs: PostJob[], deps: PostJobDeps): Promise<void> {
  for (const job of jobs) {
    try {
      if (job.kind === 'calendar_sync') await syncCalendar(job.tenantId, job.appointmentId, deps);
      else await notifyBooking(job.tenantId, job.appointmentId, job.change, deps);
    } catch (err) {
      deps.logger.error('post_job_failed', {
        tenant_id: job.tenantId,
        kind: job.kind,
        error_code: err instanceof Error ? err.name : 'unknown',
      });
    }
  }
}

export async function syncCalendar(tenantId: string, appointmentId: string, deps: PostJobDeps): Promise<void> {
  const sched = deps.repo.forTenant(tenantId).scheduling();
  const now = deps.clock.now().toISOString();
  const a = await sched.getDetails(appointmentId);
  if (!a) return;
  if (!a.calendarId || !deps.calendar) {
    await sched.setCalendarSync(appointmentId, 'none', now);
    return;
  }
  const eventId = externalEventId(a.id);
  try {
    if (a.status === 'booked' || a.status === 'confirmed') {
      const name = a.customerName ?? 'Cliente';
      await deps.calendar.upsertEvent(a.calendarId, {
        id: eventId,
        summary: `${a.serviceName} · ${name}`,
        description: [
          'Agendado pelo WhatsApp (SecretárIA).',
          `Cliente: ${name} · ${formatWaId(a.waId)}`,
          `Com: ${a.professionalLabel}`,
          `Código: ${a.code}`,
        ].join('\n'),
        location: a.address,
        start: a.startsAt,
        end: a.endsAt,
        timeZone: a.timezone,
      });
    } else {
      await deps.calendar.deleteEvent(a.calendarId, eventId);
    }
    await sched.setCalendarSync(appointmentId, 'synced', now);
    deps.logger.info('calendar_synced', { tenant_id: tenantId, appointment_id: appointmentId, status: a.status });
  } catch (err) {
    await sched.setCalendarSync(appointmentId, 'failed', now);
    deps.logger.warn('calendar_sync_failed', {
      tenant_id: tenantId,
      appointment_id: appointmentId,
      error_code: err instanceof Error ? err.name : 'unknown',
      http_status: (err as { status?: number }).status ?? null,
    });
  }
}

async function notifyBooking(
  tenantId: string,
  appointmentId: string,
  change: 'created' | 'rescheduled' | 'cancelled',
  deps: PostJobDeps,
): Promise<void> {
  if (!deps.notifier) return;
  const a = await deps.repo.forTenant(tenantId).scheduling().getDetails(appointmentId);
  if (!a?.conversationId) return;
  await deps.notifier.notifyBooking({
    tenantId,
    tenantName: a.tenantName,
    conversationId: a.conversationId,
    waId: a.waId,
    contactName: a.customerName,
    change,
    serviceName: a.serviceName,
    professionalLabel: a.professionalLabel,
    when: formatAppointmentTime(new Date(a.startsAt), a.timezone),
    code: a.code,
  });
}
