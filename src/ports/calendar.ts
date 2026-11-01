// Agenda externa da empresa (Google Agenda).

export interface ExternalEvent {
  /** ID estável derivado do agendamento: reenviar não duplica. */
  id: string;
  summary: string;
  description: string;
  location: string | null;
  start: string;
  end: string;
  timeZone: string;
}

/** Período ocupado. Eventos de dia inteiro vêm como datas locais da agenda. */
export type ExternalBusy = { start: string; end: string } | { allDayStart: string; allDayEnd: string };

export interface ExternalCalendar {
  /** Ocupados no período: eventos "ocupado" que não foram criados pelo sistema. */
  busy(calendarId: string, timeMin: string, timeMax: string): Promise<ExternalBusy[]>;
  upsertEvent(calendarId: string, event: ExternalEvent): Promise<void>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

/** ID do evento no Google (só a-v e 0-9): "sa" + hex do ID do agendamento. */
export function externalEventId(appointmentId: string): string {
  let hex = '';
  for (let i = 0; i < appointmentId.length; i++) hex += appointmentId.charCodeAt(i).toString(16).padStart(2, '0');
  return `sa${hex.toLowerCase()}`;
}
