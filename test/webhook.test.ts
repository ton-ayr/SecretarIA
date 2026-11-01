import { describe, expect, it } from 'vitest';
import { WhatsAppCloudSender } from '../src/adapters/whatsapp-cloud.ts';
import { buildListMessage } from '../src/core/interactive.ts';
import { isTextual, mediaPlaceholder, parseWebhook } from '../src/core/whatsapp-payload.ts';
import { isServiceWindowOpen } from '../src/core/window.ts';
import { WhatsAppError } from '../src/ports/whatsapp.ts';
import { signBody, verifyMetaSignature } from '../src/shared/signature.ts';
import { sampleWebhook } from './helpers/fixtures.ts';

const enc = (s: string) => new TextEncoder().encode(s);

describe('assinatura X-Hub-Signature-256', () => {
  const secret = 'segredo-do-app';
  const body = enc('{"object":"whatsapp_business_account","entry":[]}');

  it('aceita assinatura válida', async () => {
    const header = `sha256=${await signBody(secret, body)}`;
    expect(await verifyMetaSignature(secret, body, header)).toBe(true);
    expect(await verifyMetaSignature(secret, body, header.toUpperCase().replace('SHA256=', 'sha256='))).toBe(true);
  });

  it('recusa assinatura inválida, ausente, sem prefixo ou com outro segredo', async () => {
    const good = await signBody(secret, body);
    expect(await verifyMetaSignature(secret, body, `sha256=${good.slice(0, -1)}0`)).toBe(false);
    expect(await verifyMetaSignature(secret, body, null)).toBe(false);
    expect(await verifyMetaSignature(secret, body, good)).toBe(false);
    expect(await verifyMetaSignature('outro', body, `sha256=${good}`)).toBe(false);
    expect(await verifyMetaSignature('', body, `sha256=${good}`)).toBe(false);
  });

  it('corpo alterado invalida a assinatura', async () => {
    const header = `sha256=${await signBody(secret, body)}`;
    expect(await verifyMetaSignature(secret, enc('{"object":"x"}'), header)).toBe(false);
  });
});

describe('leitura do webhook', () => {
  it('lê texto, nome do perfil e horário', () => {
    const parsed = parseWebhook(
      sampleWebhook({
        messages: [{ from: '5511999990001', id: 'wamid.A', timestamp: '1790000000', type: 'text', text: { body: 'oi' } }],
      }),
    );
    expect(parsed.messages).toEqual([
      {
        metaPhoneNumberId: '100000000000001',
        waId: '5511999990001',
        profileName: 'Maria',
        waMessageId: 'wamid.A',
        at: new Date(1790000000 * 1000).toISOString(),
        kind: 'text',
        text: 'oi',
        replyId: null,
        mediaId: null,
        mime: null,
      },
    ]);
  });

  it('lê resposta de lista, botão de template, mídia com legenda e ignora reação', () => {
    const parsed = parseWebhook(
      sampleWebhook({
        messages: [
          { from: '1', id: 'L', timestamp: '1', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'slot:1', title: 'Ter 14/10 · 15:00' } } },
          { from: '1', id: 'B', timestamp: '1', type: 'button', button: { text: 'Confirmar', payload: 'confirm:1' } },
          { from: '1', id: 'I', timestamp: '1', type: 'image', image: { id: 'media-1', caption: 'quanto custa?' } },
          { from: '1', id: 'A', timestamp: '1', type: 'audio', audio: { id: 'media-2' } },
          { from: '1', id: 'R', timestamp: '1', type: 'reaction', reaction: { emoji: '👍' } },
        ],
      }),
    );
    expect(parsed.messages.map((m) => [m.waMessageId, m.kind, m.text, m.replyId, m.mediaId])).toEqual([
      ['L', 'interactive', 'Ter 14/10 · 15:00', 'slot:1', null],
      ['B', 'button', 'Confirmar', 'confirm:1', null],
      ['I', 'image', 'quanto custa?', null, 'media-1'],
      ['A', 'audio', '', null, 'media-2'],
    ]);
  });

  it('lê status com erro e preço', () => {
    const parsed = parseWebhook(
      sampleWebhook({
        statuses: [
          { id: 'wamid.X', status: 'failed', timestamp: '1', recipient_id: '1', errors: [{ code: 131047, title: 't' }] },
          { id: 'wamid.Y', status: 'sent', timestamp: '1', recipient_id: '1', pricing: { billable: true, pricing_model: 'PMP', category: 'utility', type: 'regular' } },
        ],
      }),
    );
    expect(parsed.statuses.map((s) => [s.waMessageId, s.status, s.errorCode, s.billable, s.category])).toEqual([
      ['wamid.X', 'failed', 131047, false, null],
      ['wamid.Y', 'sent', null, true, 'utility'],
    ]);
  });

  it('ignora corpo estranho sem quebrar', () => {
    expect(parseWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook({ object: 'page', entry: [] })).toEqual({ messages: [], statuses: [] });
    expect(parseWebhook({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {} }] }] })).toEqual({
      messages: [],
      statuses: [],
    });
  });

  it('classifica tipos textuais e avisos de mídia', () => {
    expect(['text', 'interactive', 'button'].every(isTextual)).toBe(true);
    expect(isTextual('audio')).toBe(false);
    expect(mediaPlaceholder('image')).toBe('[o cliente enviou uma imagem]');
  });
});

describe('janela de 24 horas', () => {
  const now = new Date('2026-10-03T12:00:00.000Z');
  it('aberta até 24h depois da última mensagem do cliente (com margem)', () => {
    expect(isServiceWindowOpen('2026-10-03T11:59:00.000Z', now)).toBe(true);
    expect(isServiceWindowOpen('2026-10-02T12:30:00.000Z', now)).toBe(true);
    expect(isServiceWindowOpen('2026-10-02T12:00:30.000Z', now)).toBe(false);
    expect(isServiceWindowOpen('2026-10-01T12:00:00.000Z', now)).toBe(false);
    expect(isServiceWindowOpen(null, now)).toBe(false);
    expect(isServiceWindowOpen('lixo', now)).toBe(false);
  });
});

describe('lista interativa', () => {
  const options = [
    { id: 'slot:1', title: 'Ter 14/10 · 15:00', description: 'com Rafael' },
    { id: 'slot:2', title: 'Ter 14/10 · 16:00' },
  ];

  it('monta a lista dentro dos limites', () => {
    expect(buildListMessage({ text: 'Tenho estes horários:', options }, 'Ver horários')).toEqual({
      body: 'Tenho estes horários:',
      button: 'Ver horários',
      rows: [
        { id: 'slot:1', title: 'Ter 14/10 · 15:00', description: 'com Rafael' },
        { id: 'slot:2', title: 'Ter 14/10 · 16:00' },
      ],
    });
  });

  it('volta para texto quando não há opções ou algo passa do limite', () => {
    expect(buildListMessage({ text: 'oi' })).toBeNull();
    expect(buildListMessage({ text: 'x', options: [{ id: 'a', title: 'T'.repeat(25) }] })).toBeNull();
    expect(buildListMessage({ text: 'x', options: [{ id: 'a', title: 't', description: 'd'.repeat(73) }] })).toBeNull();
    expect(buildListMessage({ text: 'x', options: Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, title: 't' })) })).toBeNull();
    expect(buildListMessage({ text: 'x', options: [{ id: 'a', title: 't' }, { id: 'a', title: 'u' }] })).toBeNull();
    expect(buildListMessage({ text: 'x'.repeat(1025), options })).toBeNull();
    expect(buildListMessage({ text: 'x', options }, 'B'.repeat(21))).toBeNull();
  });
});

describe('adaptador da Cloud API', () => {
  function sender(handler: (url: string, body: Record<string, unknown>) => Response) {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const s = new WhatsAppCloudSender({
      graphVersion: 'v25.0',
      getToken: async (from) => `token-de-${from}`,
      fetchFn: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push({ url: String(url), body, auth: new Headers(init?.headers).get('authorization') });
        return handler(String(url), body);
      },
    });
    return { s, calls };
  }

  it('envia texto e devolve o wamid', async () => {
    const { s, calls } = sender(() => Response.json({ messages: [{ id: 'wamid.OK' }] }));
    expect(await s.sendText('PNID', '5511999990001', 'Olá')).toEqual({ waMessageId: 'wamid.OK' });
    expect(calls[0]).toEqual({
      url: 'https://graph.facebook.com/v25.0/PNID/messages',
      auth: 'Bearer token-de-PNID',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: '5511999990001', type: 'text', text: { body: 'Olá', preview_url: false } },
    });
  });

  it('envia lista e marca como lida com "digitando"', async () => {
    const { s, calls } = sender(() => Response.json({ messages: [{ id: 'wamid.L' }], success: true }));
    await s.sendList('PNID', '1', { body: 'Escolha:', button: 'Ver horários', rows: [{ id: 'a', title: 'A' }] });
    await s.markReadWithTyping('PNID', 'wamid.IN');
    expect(calls[0]!.body).toMatchObject({
      type: 'interactive',
      interactive: { type: 'list', body: { text: 'Escolha:' }, action: { button: 'Ver horários', sections: [{ rows: [{ id: 'a', title: 'A' }] }] } },
    });
    expect(calls[1]!.body).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN', typing_indicator: { type: 'text' } });
  });

  it('traduz erros da Meta', async () => {
    const cases: Array<[number, number | undefined, string]> = [
      [400, 131047, 'window_closed'],
      [400, 131030, 'recipient'],
      [401, 190, 'auth'],
      [500, undefined, 'server'],
      [429, undefined, 'rate_limit'],
      [400, 100, 'client'],
    ];
    for (const [status, code, kind] of cases) {
      const { s } = sender(() => Response.json(code ? { error: { code } } : {}, { status }));
      const err = await s.sendText('P', '1', 'x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WhatsAppError);
      expect(err).toMatchObject({ kind, status, metaCode: code });
    }
  });
});
