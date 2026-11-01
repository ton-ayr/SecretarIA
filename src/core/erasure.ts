import { TEST_PHONE_PREFIX } from '../ports/admin.ts';
import type { ErasureReport } from '../ports/bot-admin.ts';
import { externalEventId, type ExternalCalendar } from '../ports/calendar.ts';
import type { Repo } from '../ports/repo.ts';
import type { Logger } from '../ports/runtime.ts';

/**
 * Exclusão dos dados de um contato (LGPD), pelo botão do painel ou por pedido
 * do terminal (npm run lgpd:apagar). Ordem:
 *  1. levanta o que existe fora do D1 (eventos na agenda Google, conversas);
 *  2. apaga os eventos da agenda da empresa (eles levam nome e telefone);
 *  3. apaga tudo no D1 numa transação;
 *  4. apaga o estado do Durable Object de cada conversa.
 * Falhas em 2 e 4 não impedem 3: ficam no log (sem dado pessoal). O estado
 * do objeto também some sozinho depois de 8 dias sem mensagens.
 */

export interface ErasureDeps {
  repo: Repo;
  /** Sem agenda (ou no teste do painel), pula o passo 2. */
  calendar?: ExternalCalendar;
  /** Apaga o estado do Durable Object da conversa. */
  wipeConversation(metaPhoneNumberId: string, waId: string): Promise<void>;
  logger: Logger;
}

export async function eraseContactData(tenantId: string, waId: string, deps: ErasureDeps): Promise<ErasureReport> {
  const tenantRepo = deps.repo.forTenant(tenantId);
  const plan = await tenantRepo.erasurePlan(waId);

  let calendarEvents = 0;
  let calendarFailures = 0;
  if (deps.calendar) {
    for (const ev of plan.calendarEvents) {
      if (!ev.calendarId) continue;
      try {
        await deps.calendar.deleteEvent(ev.calendarId, externalEventId(ev.appointmentId));
        calendarEvents += 1;
      } catch {
        calendarFailures += 1;
      }
    }
  }

  const counts = await tenantRepo.eraseContact(waId);

  let stateWipeFailures = 0;
  for (const conv of plan.conversations) {
    // O chat de teste do painel não usa o objeto da conversa.
    if (conv.metaPhoneNumberId.startsWith(TEST_PHONE_PREFIX)) continue;
    try {
      await deps.wipeConversation(conv.metaPhoneNumberId, waId);
    } catch {
      stateWipeFailures += 1;
    }
  }

  const report: ErasureReport = { ...counts, calendarEvents, calendarFailures, stateWipeFailures };
  const level = calendarFailures || stateWipeFailures ? 'warn' : 'info';
  deps.logger[level]('contact_erased', {
    tenant_id: tenantId,
    contacts: report.contacts,
    conversations: report.conversations,
    messages: report.messages,
    appointments: report.appointments,
    calendar_events: calendarEvents,
    calendar_failures: calendarFailures,
    state_wipe_failures: stateWipeFailures,
  });
  return report;
}
