import { beforeAll, describe, expect, it } from 'vitest';
import { GoogleCalendarClient, GoogleCalendarError, parseServiceAccount } from '../src/adapters/google-calendar.ts';
import { externalEventId } from '../src/ports/calendar.ts';

let privatePem = '';
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  let bin = '';
  for (const b of der) bin += String.fromCharCode(b);
  privatePem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
});

const b64urlDecode = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

function client(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const c = new GoogleCalendarClient(
    { client_email: 'bot@projeto.iam.gserviceaccount.com', private_key: privatePem },
    {
      now: () => Date.parse('2026-10-14T12:00:00Z'),
      fetchFn: async (input, init) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : String(init?.body ?? '') });
        if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
        return handler(url, init ?? {});
      },
    },
  );
  return { c, calls };
}

describe('Google Agenda (conta de serviço)', () => {
  it('troca um JWT RS256 válido por token e reaproveita o token', async () => {
    const { c, calls } = client(() => Response.json({ items: [] }));
    await c.busy('agenda@gmail.com', '2026-10-14T00:00:00Z', '2026-10-15T00:00:00Z');
    await c.busy('agenda@gmail.com', '2026-10-14T00:00:00Z', '2026-10-15T00:00:00Z');
    const tokenCalls = calls.filter((x) => x.url.includes('oauth2'));
    expect(tokenCalls).toHaveLength(1);

    const form = new URLSearchParams(tokenCalls[0]!.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, p, s] = form.get('assertion')!.split('.');
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p!))) as Record<string, unknown>;
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h!)))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claims).toMatchObject({
      iss: 'bot@projeto.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/calendar.events',
      aud: 'https://oauth2.googleapis.com/token',
    });
    expect((claims.exp as number) - (claims.iat as number)).toBe(3600);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, b64urlDecode(s!), new TextEncoder().encode(`${h}.${p}`));
    expect(valid).toBe(true);
  });

  it('ocupados: ignora livres, cancelados e eventos criados pelo sistema; traz dia inteiro', async () => {
    const { c, calls } = client(() =>
      Response.json({
        items: [
          { id: 'a', start: { dateTime: '2026-10-14T13:00:00-03:00' }, end: { dateTime: '2026-10-14T14:00:00-03:00' } },
          { id: 'b', transparency: 'transparent', start: { dateTime: 'x' }, end: { dateTime: 'y' } },
          { id: 'c', status: 'cancelled', start: { dateTime: 'x' }, end: { dateTime: 'y' } },
          { id: 'd', extendedProperties: { private: { secretaria: '1' } }, start: { dateTime: 'x' }, end: { dateTime: 'y' } },
          { id: 'e', start: { date: '2026-10-15' }, end: { date: '2026-10-16' } },
        ],
      }),
    );
    const busy = await c.busy('agenda@gmail.com', '2026-10-14T00:00:00Z', '2026-10-16T00:00:00Z');
    expect(busy).toEqual([
      { start: '2026-10-14T13:00:00-03:00', end: '2026-10-14T14:00:00-03:00' },
      { allDayStart: '2026-10-15', allDayEnd: '2026-10-16' },
    ]);
    expect(calls[1]!.url).toContain('/calendars/agenda%40gmail.com/events?');
    expect(calls[1]!.url).toContain('singleEvents=true');
  });

  it('cria evento com ID fixo: tenta atualizar e, se não existe, insere', async () => {
    const id = externalEventId('01K6APPT0000000000000000AA');
    const { c, calls } = client((_url, init) => (init.method === 'PUT' ? new Response('', { status: 404 }) : Response.json({ id })));
    await c.upsertEvent('agenda@gmail.com', {
      id,
      summary: 'Corte masculino · Caio',
      description: 'x',
      location: 'Rua das Palmeiras, 120',
      start: '2026-10-14T18:00:00.000Z',
      end: '2026-10-14T18:30:00.000Z',
      timeZone: 'America/Sao_Paulo',
    });
    expect(calls.slice(1).map((x) => x.method)).toEqual(['PUT', 'POST']);
    const body = JSON.parse(calls[2]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ id, extendedProperties: { private: { secretaria: '1' } }, start: { timeZone: 'America/Sao_Paulo' } });
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
  });

  it('apagar evento que não existe não é erro; outros erros viram GoogleCalendarError', async () => {
    const gone = client(() => new Response('', { status: 410 }));
    await expect(gone.c.deleteEvent('a@b.com', 'saxx')).resolves.toBeUndefined();
    const denied = client(() => new Response('', { status: 403 }));
    await expect(denied.c.busy('a@b.com', 'x', 'y')).rejects.toBeInstanceOf(GoogleCalendarError);
  });

  it('lê a chave em JSON puro ou base64', () => {
    const json = JSON.stringify({ client_email: 'x@y.iam.gserviceaccount.com', private_key: 'PEM', type: 'service_account' });
    expect(parseServiceAccount(json).client_email).toBe('x@y.iam.gserviceaccount.com');
    expect(parseServiceAccount(btoa(json)).private_key).toBe('PEM');
    expect(() => parseServiceAccount('{}')).toThrow();
  });
});
