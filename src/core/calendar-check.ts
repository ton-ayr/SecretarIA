import type { CalendarCheck } from '../ports/bot-admin.ts';
import { externalEventId, type ExternalCalendar } from '../ports/calendar.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Lê os ocupados dos próximos 7 dias e cria/apaga um evento de teste daqui a
 * 30 dias. Usado pelo painel e por `npm run google -- testar`.
 */
export async function checkCalendarAccess(calendar: ExternalCalendar, calendarId: string, now: Date): Promise<CalendarCheck> {
  let busy = 0;
  try {
    busy = (await calendar.busy(calendarId, now.toISOString(), new Date(now.getTime() + 7 * DAY_MS).toISOString())).length;
  } catch {
    return {
      read: false,
      write: false,
      busy: 0,
      problem: 'Não consegui ler a agenda. Confira o ID e se ela foi compartilhada com o e-mail da conta de serviço.',
    };
  }
  const start = new Date(now.getTime() + 30 * DAY_MS);
  const eventId = externalEventId(`teste${start.getTime()}`);
  try {
    await calendar.upsertEvent(calendarId, {
      id: eventId,
      summary: 'Teste SecretárIA (pode apagar)',
      description: 'Evento de teste da conexão. É apagado logo em seguida.',
      location: null,
      start: start.toISOString(),
      end: new Date(start.getTime() + 15 * 60_000).toISOString(),
      timeZone: 'America/Sao_Paulo',
    });
    await calendar.deleteEvent(calendarId, eventId);
  } catch {
    return {
      read: true,
      write: false,
      busy,
      problem: 'Li a agenda, mas não consegui criar evento. No compartilhamento, use "Fazer alterações nos eventos".',
    };
  }
  return { read: true, write: true, busy, problem: null };
}
