import type { CalendarLinkView } from '../ports/scheduling.ts';
import { formatAppointmentTime } from '../shared/time.ts';

/**
 * Link "Salvar na agenda" enviado ao cliente depois de marcar.
 * Android abre o Google Agenda já preenchido; iPhone recebe um .ics (o app
 * Calendário oferece "Adicionar"); os demais veem uma página com as duas
 * opções. O lembrete fica por conta do próprio celular (custo zero).
 */

/** Token gerado por randomToken(22): só letras e números. */
export const CALENDAR_TOKEN_RE = /^[A-Za-z0-9]{22}$/;

export type CalendarTarget = 'android' | 'ios' | 'page';

export function pickCalendarTarget(userAgent: string | undefined): CalendarTarget {
  const ua = userAgent ?? '';
  // Prévia de link (WhatsApp, Facebook etc.): página, para mostrar título.
  if (/^WhatsApp\/|facebookexternalhit|bot|crawler|spider/i.test(ua)) return 'page';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return 'page';
}

function eventTitle(v: CalendarLinkView): string {
  return `${v.serviceName} · ${v.tenantName}`;
}

function eventDetails(v: CalendarLinkView): string {
  return `Com ${v.professionalLabel}.\nMarcado pelo WhatsApp de ${v.tenantName}. Para remarcar ou cancelar, é só chamar por lá.`;
}

/** 2026-10-14T13:00:00.000Z → 20261014T130000Z */
function utcStamp(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function googleCalendarUrl(v: CalendarLinkView): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: eventTitle(v),
    dates: `${utcStamp(v.startsAt)}/${utcStamp(v.endsAt)}`,
    details: eventDetails(v),
    ctz: v.timezone,
  });
  if (v.address) params.set('location', v.address);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

const encoder = new TextEncoder();

/** Dobra linhas em 75 bytes (RFC 5545 §3.1), sem partir caractere UTF-8. */
function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74; // continuação começa com espaço
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(v: CalendarLinkView, token: string, now: Date): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SecretarIA//Agenda//PT-BR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${token}@secretaria`,
    `DTSTAMP:${utcStamp(now.toISOString())}`,
    `DTSTART:${utcStamp(v.startsAt)}`,
    `DTEND:${utcStamp(v.endsAt)}`,
    `SUMMARY:${icsEscape(eventTitle(v))}`,
    `DESCRIPTION:${icsEscape(eventDetails(v))}`,
    ...(v.address ? [`LOCATION:${icsEscape(v.address)}`] : []),
    'STATUS:CONFIRMED',
    // Lembretes do próprio celular: 1 dia e 1 hora antes.
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(eventTitle(v))}`,
    'TRIGGER:-P1D',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(eventTitle(v))}`,
    'TRIGGER:-PT1H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#1d2329;--muted:#5b6670;--accent:#1a7f5a;--line:#dfe3e8}
@media (prefers-color-scheme:dark){:root{--bg:#111417;--card:#1b2025;--text:#e9edf0;--muted:#a3adb6;--accent:#3fbf8c;--line:#2c333a}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:420px;margin:0 auto;padding:32px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
h1{font-size:20px;margin:0 0 12px}
p{margin:4px 0;color:var(--muted)}
p strong{color:var(--text)}
a.btn{display:block;text-align:center;margin-top:14px;padding:13px;border-radius:10px;text-decoration:none;font-weight:600;border:1px solid var(--accent);color:var(--accent)}
a.btn.primary{background:var(--accent);color:#fff}
small{display:block;margin-top:16px;color:var(--muted)}
</style>
</head>
<body><main><div class="card">${body}</div></main></body>
</html>`;
}

export function calendarLinkPage(v: CalendarLinkView, token: string): string {
  const title = eventTitle(v);
  const when = formatAppointmentTime(new Date(v.startsAt), v.timezone);
  return page(
    title,
    `<h1>${escapeHtml(v.serviceName)}</h1>
<p><strong>${escapeHtml(when)}</strong></p>
<p>Com ${escapeHtml(v.professionalLabel)} · ${escapeHtml(v.tenantName)}</p>
${v.address ? `<p>${escapeHtml(v.address)}</p>` : ''}
<a class="btn primary" href="${escapeHtml(googleCalendarUrl(v))}">Salvar no Google Agenda</a>
<a class="btn" href="/a/${escapeHtml(token)}/ics">Salvar no iPhone / outro app (.ics)</a>
<small>Para remarcar ou cancelar, é só chamar no WhatsApp.</small>`,
  );
}

export function calendarMessagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
