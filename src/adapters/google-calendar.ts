import type { ExternalBusy, ExternalCalendar, ExternalEvent } from '../ports/calendar.ts';

/**
 * Google Agenda via conta de serviço (verificado em 2026-10-04, ARQUITETURA
 * §16). A empresa compartilha a agenda com o e-mail da conta de serviço
 * ("Fazer alterações nos eventos"). Acesso: JWT assinado com RS256 trocado
 * por um token de 1 hora em https://oauth2.googleapis.com/token.
 * A API do Google Agenda é gratuita até 1 milhão de pedidos por dia.
 */

export class GoogleCalendarError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleCalendarError';
  }
}

export interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** Aceita o JSON da chave puro ou em base64 (como fica no .dev.vars). */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : atob(raw.trim());
  const json = JSON.parse(text) as Partial<ServiceAccount>;
  if (!json.client_email || !json.private_key) throw new Error('chave da conta de serviço incompleta');
  return { client_email: json.client_email, private_key: json.private_key };
}

// Só eventos: cobre ler os ocupados (events.list) e criar/alterar/apagar.
const SCOPES = 'https://www.googleapis.com/auth/calendar.events';
const API = 'https://www.googleapis.com/calendar/v3';
const MARK = 'secretaria';

function base64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let bin = '';
  for (const b of data) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface GoogleEvent {
  id?: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

export class GoogleCalendarClient implements ExternalCalendar {
  private readonly fetchFn: typeof fetch;
  private keyPromise: Promise<CryptoKey> | null = null;
  private token: { value: string; exp: number } | null = null;
  private readonly now: () => number;

  constructor(
    private readonly account: ServiceAccount,
    opts: { fetchFn?: typeof fetch; now?: () => number } = {},
  ) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
  }

  private signingKey(): Promise<CryptoKey> {
    this.keyPromise ??= crypto.subtle.importKey(
      'pkcs8',
      pemToDer(this.account.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return this.keyPromise;
  }

  private async accessToken(): Promise<string> {
    const nowSec = Math.floor(this.now() / 1000);
    if (this.token && this.token.exp - 60 > nowSec) return this.token.value;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: this.account.client_email,
        scope: SCOPES,
        aud: 'https://oauth2.googleapis.com/token',
        iat: nowSec,
        exp: nowSec + 3600,
      }),
    );
    const unsigned = `${header}.${claims}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await this.signingKey(), new TextEncoder().encode(unsigned));
    const res = await this.fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${base64url(new Uint8Array(sig))}`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new GoogleCalendarError(res.status, `token HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new GoogleCalendarError(500, 'token sem access_token');
    this.token = { value: json.access_token, exp: nowSec + (json.expires_in ?? 3600) };
    return json.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.accessToken();
    try {
      return await this.fetchFn(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GoogleCalendarError(0, `${method} falha de rede ou timeout`);
    }
  }

  async busy(calendarId: string, timeMin: string, timeMax: string): Promise<ExternalBusy[]> {
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: 'true',
      maxResults: '250',
      fields: 'items(id,status,transparency,start,end,extendedProperties/private)',
    });
    const res = await this.call('GET', `/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
    if (!res.ok) {
      await res.body?.cancel();
      throw new GoogleCalendarError(res.status, `busy HTTP ${res.status}`);
    }
    const json = (await res.json()) as { items?: GoogleEvent[] };
    const out: ExternalBusy[] = [];
    for (const e of json.items ?? []) {
      if (e.status === 'cancelled' || e.transparency === 'transparent') continue;
      if (e.extendedProperties?.private?.[MARK] === '1') continue; // criado por nós
      if (e.start?.dateTime && e.end?.dateTime) out.push({ start: e.start.dateTime, end: e.end.dateTime });
      else if (e.start?.date && e.end?.date) out.push({ allDayStart: e.start.date, allDayEnd: e.end.date });
    }
    return out;
  }

  async upsertEvent(calendarId: string, event: ExternalEvent): Promise<void> {
    const body = {
      id: event.id,
      summary: event.summary,
      description: event.description,
      ...(event.location ? { location: event.location } : {}),
      start: { dateTime: event.start, timeZone: event.timeZone },
      end: { dateTime: event.end, timeZone: event.timeZone },
      extendedProperties: { private: { [MARK]: '1' } },
    };
    const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
    // Atualiza se já existe; senão, cria com o mesmo ID (reenviar não duplica).
    const put = await this.call('PUT', `${base}/${event.id}`, body);
    if (put.ok) return;
    await put.body?.cancel();
    if (put.status !== 404) throw new GoogleCalendarError(put.status, `update HTTP ${put.status}`);
    const post = await this.call('POST', base, body);
    if (post.ok || post.status === 409) {
      await post.body?.cancel();
      return;
    }
    await post.body?.cancel();
    throw new GoogleCalendarError(post.status, `insert HTTP ${post.status}`);
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    const res = await this.call('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`);
    await res.body?.cancel();
    if (res.ok || res.status === 404 || res.status === 410) return;
    throw new GoogleCalendarError(res.status, `delete HTTP ${res.status}`);
  }
}
