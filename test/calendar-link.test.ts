import { describe, expect, it } from 'vitest';
import { createApp, type WebhookDeps } from '../src/bot/app.ts';
import { buildIcs, googleCalendarUrl, pickCalendarTarget } from '../src/core/calendar-link.ts';
import type { CalendarLinkView } from '../src/ports/scheduling.ts';
import { MemoryLogger } from '../src/shared/logger.ts';

const TOKEN = 'abc123'.repeat(3) + 'abcd';

const view: CalendarLinkView = {
  status: 'booked',
  startsAt: '2026-10-14T13:00:00.000Z',
  endsAt: '2026-10-14T13:30:00.000Z',
  serviceName: 'Corte masculino',
  professionalLabel: 'Barbeiro Rafael',
  tenantName: 'Barbearia do Zé',
  address: 'Rua das Palmeiras, 120 - Centro, Campinas/SP',
  timezone: 'America/Sao_Paulo',
};

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

describe('link da agenda do cliente', () => {
  it('escolhe o destino pelo aparelho', () => {
    expect(pickCalendarTarget(ANDROID)).toBe('android');
    expect(pickCalendarTarget(IPHONE)).toBe('ios');
    expect(pickCalendarTarget('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('page');
    expect(pickCalendarTarget('WhatsApp/2.24.20.89 A')).toBe('page');
    expect(pickCalendarTarget(undefined)).toBe('page');
  });

  it('monta o endereço do Google Agenda com horário em UTC', () => {
    const url = new URL(googleCalendarUrl(view));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe('Corte masculino · Barbearia do Zé');
    expect(url.searchParams.get('dates')).toBe('20261014T130000Z/20261014T133000Z');
    expect(url.searchParams.get('location')).toBe(view.address);
    expect(url.searchParams.get('ctz')).toBe('America/Sao_Paulo');
    expect(url.searchParams.get('details')).toContain('Com Barbeiro Rafael.');
  });

  it('gera .ics válido: CRLF, escapes, linhas de até 75 bytes e lembretes', () => {
    const ics = buildIcs(view, TOKEN, new Date('2026-10-13T11:00:00.000Z'));
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
    const lines = ics.split('\r\n');
    for (const l of lines) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('DTSTART:20261014T130000Z');
    expect(unfolded).toContain('DTEND:20261014T133000Z');
    expect(unfolded).toContain('DTSTAMP:20261013T110000Z');
    expect(unfolded).toContain(`UID:${TOKEN}@secretaria`);
    expect(unfolded).toContain('LOCATION:Rua das Palmeiras\\, 120 - Centro\\, Campinas/SP');
    expect(unfolded).toContain('DESCRIPTION:Com Barbeiro Rafael.\\nMarcado pelo WhatsApp');
    expect(unfolded.match(/BEGIN:VALARM/g)).toHaveLength(2);
    expect(unfolded).toContain('TRIGGER:-P1D');
    expect(unfolded).toContain('TRIGGER:-PT1H');
  });

  it('não parte caractere acentuado ao dobrar a linha', () => {
    const long = { ...view, serviceName: 'Coloração com hidratação profunda e finalização ção ção ção ção ção' };
    const ics = buildIcs(long, TOKEN, new Date());
    expect(ics.replace(/\r\n /g, '')).toContain(`SUMMARY:${long.serviceName} · Barbearia do Zé`);
  });
});

describe('rota /a/:token', () => {
  function app(found: CalendarLinkView | null | Error) {
    const logger = new MemoryLogger();
    const lookups: string[] = [];
    const deps: WebhookDeps = {
      verifyToken: 'v',
      appSecret: 's',
      logger,
      resolveRoute: async () => null,
      deliver: async () => {},
      recordStatus: async () => {},
      async findCalendarLink(token) {
        lookups.push(token);
        if (found instanceof Error) throw found;
        return found;
      },
    };
    return { app: createApp<object>(() => deps), lookups, logger };
  }
  const get = (a: ReturnType<typeof app>['app'], path: string, ua?: string) =>
    a.request(path, { headers: ua ? { 'user-agent': ua } : {} });

  it('Android vai direto ao Google Agenda', async () => {
    const { app: a } = app(view);
    const res = await get(a, `/a/${TOKEN}`, ANDROID);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('iPhone recebe o .ics', async () => {
    const { app: a } = app(view);
    const res = await get(a, `/a/${TOKEN}`, IPHONE);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(await res.text()).toContain('BEGIN:VEVENT');
  });

  it('computador vê a página com as duas opções; /ics baixa o arquivo', async () => {
    const { app: a } = app(view);
    const res = await get(a, `/a/${TOKEN}`, 'Mozilla/5.0 (Windows NT 10.0)');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('quarta-feira, 14/10 às 10:00');
    expect(html).toContain('href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;');
    expect(html).toContain(`href="/a/${TOKEN}/ics"`);
    const ics = await get(a, `/a/${TOKEN}/ics`, 'Mozilla/5.0 (Windows NT 10.0)');
    expect(ics.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
  });

  it('escapa HTML vindo do cadastro', async () => {
    const { app: a } = app({ ...view, serviceName: '<script>x</script>' });
    const html = await (await get(a, `/a/${TOKEN}`)).text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('token mal formado nem consulta o banco; inexistente dá 404; cancelado dá 410', async () => {
    const bad = app(view);
    expect((await get(bad.app, '/a/curto')).status).toBe(404);
    expect((await get(bad.app, `/a/${TOKEN}/pdf`)).status).toBe(404);
    expect(bad.lookups).toEqual([]);
    expect((await get(app(null).app, `/a/${TOKEN}`)).status).toBe(404);
    const cancelled = await get(app({ ...view, status: 'cancelled' }).app, `/a/${TOKEN}`, ANDROID);
    expect(cancelled.status).toBe(410);
    expect(await cancelled.text()).toContain('Este horário foi cancelado');
  });

  it('falha no banco vira 503 sem vazar detalhe', async () => {
    const { app: a, logger } = app(new Error('D1 down'));
    const res = await get(a, `/a/${TOKEN}`);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('D1 down');
    expect(JSON.stringify(logger.lines)).not.toContain(TOKEN);
  });
});
