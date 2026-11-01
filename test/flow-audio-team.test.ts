import { describe, expect, it } from 'vitest';
import { GroqTranscriber, SttError, TranscriberChain, WorkersAITranscriber, buildTranscriber } from '../src/adapters/stt.ts';
import { MediaTooLargeError, WhatsAppCloudSender } from '../src/adapters/whatsapp-cloud.ts';
import { ConversationFlow, type HumanReplyInput, type InboxItem } from '../src/core/conversation-flow.ts';
import type { TurnInput, TurnResult } from '../src/core/engine.ts';
import type { HumanReplyRecord } from '../src/ports/repo.ts';
import type { MediaFetcher, Transcriber } from '../src/ports/transcriber.ts';
import { WhatsAppError, type ListMessage, type WhatsAppSender } from '../src/ports/whatsapp.ts';
import { MemoryLogger } from '../src/shared/logger.ts';
import { MemoryInboxStore } from './helpers/fixtures.ts';

const T0 = Date.parse('2026-10-14T13:00:00.000Z');
const ROUTE = { metaPhoneNumberId: 'PNID', waId: '5511999990099' };

function result(_input: TurnInput, over: Partial<TurnResult> = {}): TurnResult {
  return {
    turnId: 'T',
    outcome: 'replied',
    reply: { text: 'ok' },
    replyMessageId: 'OUT',
    tenantId: 'TEN',
    conversationId: 'CONV',
    provider: 'fake',
    model: 'm',
    usage: { inputTokens: 1, outputTokens: 1 },
    llmRequests: 1,
    latencyMs: 1,
    summaryJob: null,
    errorCode: null,
    failedAttempts: [],
    pausedUntil: null,
    handoffReason: null,
    action: null,
    postJobs: [],
    ...over,
  };
}

class Sender implements WhatsAppSender {
  texts: string[] = [];
  typing: string[] = [];
  fail: Error | null = null;
  async sendText(_f: string, _t: string, body: string) {
    if (this.fail) throw this.fail;
    this.texts.push(body);
    return { waMessageId: `wamid.${this.texts.length}` };
  }
  async sendList(_f: string, _t: string, _l: ListMessage) {
    return { waMessageId: 'wamid.list' };
  }
  buttons: Array<{ body: string; buttons: Array<{ id: string; title: string }> }> = [];
  templates: Array<{ name: string; bodyParams: string[]; quickReplyPayloads: string[] }> = [];
  async sendButtons(_f: string, _t: string, m: { body: string; buttons: Array<{ id: string; title: string }> }) {
    if (this.fail) throw this.fail;
    this.buttons.push(m);
    return { waMessageId: 'wamid.buttons' };
  }
  async sendTemplate(_f: string, _t: string, m: { name: string; language: string; bodyParams: string[]; quickReplyPayloads: string[] }) {
    if (this.fail) throw this.fail;
    this.templates.push(m);
    return { waMessageId: 'wamid.template' };
  }
  async markReadWithTyping(_f: string, id: string) {
    this.typing.push(id);
  }
}

/** OGG/Opus mínimo com a duração pedida (só cabeçalhos). */
function oggOfSeconds(seconds: number): Uint8Array {
  const page = (granule: bigint, payload: Uint8Array) => {
    const p = new Uint8Array(28 + payload.length);
    p.set([0x4f, 0x67, 0x67, 0x53], 0);
    new DataView(p.buffer).setBigUint64(6, granule, true);
    p[26] = 1;
    p[27] = payload.length;
    p.set(payload, 28);
    return p;
  };
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  const a = page(0n, head);
  const b = page(BigInt(Math.round(seconds * 48_000)), new Uint8Array(10));
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function setup(opts: {
  media?: MediaFetcher;
  transcriber?: Transcriber;
  handle?: (i: TurnInput) => TurnResult;
} = {}) {
  let now = T0;
  const store = new MemoryInboxStore();
  const sender = new Sender();
  const logger = new MemoryLogger();
  const inputs: TurnInput[] = [];
  const saved: HumanReplyRecord[] = [];
  const resumed: string[] = [];
  const alerts: string[] = [];
  let saveFails = false;
  const flow = new ConversationFlow({
    store,
    sender,
    logger,
    clock: { now: () => new Date(now) },
    markSent: async () => undefined,
    media: opts.media,
    transcriber: opts.transcriber,
    engine: {
      async handleTurn(i) {
        inputs.push(i);
        return opts.handle ? opts.handle(i) : result(i);
      },
      runSummary: async () => true,
    },
    conversations: {
      async saveHumanReply(_t, r) {
        if (saveFails) throw new Error('D1 fora');
        saved.push(r);
      },
      async resumeBot(_t, c) {
        resumed.push(c);
      },
    },
    alertOperator: async (kind) => {
      alerts.push(kind);
    },
  });
  const audio = (id: string, mediaId = `media-${id}`): InboxItem => ({
    waMessageId: id,
    kind: 'audio',
    text: '',
    at: new Date(now).toISOString(),
    profileName: 'Caio',
    mediaId,
    mime: 'audio/ogg; codecs=opus',
  });
  return {
    flow,
    store,
    sender,
    logger,
    inputs,
    saved,
    resumed,
    alerts,
    audio,
    failSave: () => (saveFails = true),
    advance: (ms: number) => (now += ms),
  };
}

const fakeMedia = (bytes: Uint8Array | Error): MediaFetcher => ({
  async download() {
    if (bytes instanceof Error) throw bytes;
    return { bytes, mime: 'audio/ogg' };
  },
});

class FakeTranscriber implements Transcriber {
  calls = 0;
  constructor(private readonly out: { text: string; durationSec: number | null } | Error) {}
  async transcribe() {
    this.calls++;
    if (this.out instanceof Error) throw this.out;
    return { ...this.out, provider: 'groq', model: 'whisper-large-v3-turbo' };
  }
}

describe('áudio no fluxo', () => {
  it('baixa, transcreve e entrega o texto ao motor com os segundos usados', async () => {
    const tr = new FakeTranscriber({ text: 'quero marcar um corte', durationSec: 6.2 });
    const s = setup({ media: fakeMedia(oggOfSeconds(6.2)), transcriber: tr });
    s.flow.enqueue(ROUTE, [s.audio('A1')]);
    await s.flow.process();
    expect(s.inputs[0]!.messages[0]).toMatchObject({ kind: 'audio', text: 'quero marcar um corte' });
    expect(s.inputs[0]!.messages[0]!.mediaNote).toBeUndefined();
    expect(s.inputs[0]!.stt).toEqual([{ seconds: 7, provider: 'groq', model: 'whisper-large-v3-turbo' }]);
  });

  it('áudio OGG com mais de 2 minutos nem é transcrito', async () => {
    const tr = new FakeTranscriber({ text: 'x', durationSec: 150 });
    const s = setup({ media: fakeMedia(oggOfSeconds(150)), transcriber: tr });
    s.flow.enqueue(ROUTE, [s.audio('A2')]);
    await s.flow.process();
    expect(tr.calls).toBe(0);
    expect(s.inputs[0]!.messages[0]!.mediaNote).toBe('too_long');
  });

  it('formato sem duração no arquivo: confere pela duração da transcrição', async () => {
    const tr = new FakeTranscriber({ text: 'texto longo', durationSec: 130 });
    const s = setup({ media: fakeMedia(new Uint8Array([1, 2, 3])), transcriber: tr });
    s.flow.enqueue(ROUTE, [s.audio('A3')]);
    await s.flow.process();
    expect(s.inputs[0]!.messages[0]).toMatchObject({ text: '', mediaNote: 'too_long' });
    expect(s.inputs[0]!.stt![0]!.seconds).toBe(130);
  });

  it('arquivo grande demais vira "longo"; falha de transcrição vira "não entendi"', async () => {
    const big = setup({ media: fakeMedia(new MediaTooLargeError()), transcriber: new FakeTranscriber({ text: 'x', durationSec: 1 }) });
    big.flow.enqueue(ROUTE, [big.audio('A4')]);
    await big.flow.process();
    expect(big.inputs[0]!.messages[0]!.mediaNote).toBe('too_long');

    const broken = setup({ media: fakeMedia(oggOfSeconds(5)), transcriber: new FakeTranscriber(new SttError('server', 'caiu', 500)) });
    broken.flow.enqueue(ROUTE, [broken.audio('A5')]);
    await broken.flow.process();
    expect(broken.inputs[0]!.messages[0]!.mediaNote).toBe('failed');
    expect(broken.logger.lines.some((l) => l.event === 'audio_not_transcribed')).toBe(true);
  });

  it('sem transcrição configurada, o áudio segue sem texto (o motor responde fixo)', async () => {
    const s = setup();
    s.flow.enqueue(ROUTE, [s.audio('A6')]);
    await s.flow.process();
    expect(s.inputs[0]!.messages[0]).toMatchObject({ kind: 'audio', text: '' });
  });
});

describe('equipe pelo Telegram', () => {
  const reply = (over: Partial<HumanReplyInput> = {}): HumanReplyInput => ({
    tenantId: 'TEN',
    conversationId: 'CONV',
    phoneNumberId: 'PN',
    text: 'Oi, aqui é o Zé!',
    lastCustomerMsgAt: new Date(T0 - 60_000).toISOString(),
    resumeHours: 12,
    route: ROUTE,
    ...over,
  });

  it('envia pelo mesmo número, grava e mantém a conversa pausada', async () => {
    const s = setup();
    expect(await s.flow.sendHumanReply(reply())).toBe('sent');
    expect(s.sender.texts).toEqual(['Oi, aqui é o Zé!']);
    expect(s.saved[0]).toMatchObject({ body: 'Oi, aqui é o Zé!', waMessageId: 'wamid.1', phoneNumberId: 'PN' });
    expect(Date.parse(s.saved[0]!.pausedUntil) - T0).toBe(12 * 3_600_000);
    // Pausada: mensagem nova do cliente não mostra "digitando".
    expect(s.flow.enqueue(ROUTE, [{ ...s.audio('X'), kind: 'text', text: 'obrigado' }]).typingFor).toBeNull();
  });

  it('fora da janela de 24 h não envia', async () => {
    const s = setup();
    const status = await s.flow.sendHumanReply(reply({ lastCustomerMsgAt: new Date(T0 - 25 * 3_600_000).toISOString() }));
    expect(status).toBe('window_closed');
    expect(s.sender.texts).toHaveLength(0);
  });

  it('Meta recusando por janela fechada também vira "window_closed"; outro erro vira "failed"', async () => {
    const s = setup();
    s.sender.fail = new WhatsAppError('window_closed', 'x', 400, 131047);
    expect(await s.flow.sendHumanReply(reply())).toBe('window_closed');
    s.sender.fail = new WhatsAppError('server', 'x', 500);
    expect(await s.flow.sendHumanReply(reply())).toBe('failed');
  });

  it('se já enviou mas não gravou, responde "sent" (para a equipe não reenviar)', async () => {
    const s = setup();
    s.failSave();
    expect(await s.flow.sendHumanReply(reply())).toBe('sent');
    expect(s.logger.lines.some((l) => l.event === 'human_reply_save_failed')).toBe(true);
  });

  it('"Devolver ao bot" despausa a conversa', async () => {
    const s = setup();
    await s.flow.sendHumanReply(reply());
    await s.flow.resume('TEN', 'CONV');
    expect(s.resumed).toEqual(['CONV']);
    expect(s.flow.enqueue(ROUTE, [{ ...s.audio('Y'), kind: 'text', text: 'oi' }]).typingFor).toBe('Y');
  });

  it('token da Meta recusado avisa o operador', async () => {
    const s = setup();
    s.sender.fail = new WhatsAppError('auth', 'x', 401, 190);
    s.flow.enqueue(ROUTE, [{ ...s.audio('Z'), kind: 'text', text: 'oi' }]);
    await s.flow.process();
    expect(s.alerts).toEqual(['whatsapp_auth']);
  });

  it('a pausa vem do motor (pausedUntil) e vence sozinha', async () => {
    const s = setup({
      handle: (i) => result(i, { outcome: 'handoff', pausedUntil: new Date(T0 + 3_600_000).toISOString() }),
    });
    s.flow.enqueue(ROUTE, [{ ...s.audio('P1'), kind: 'text', text: 'falar com atendente' }]);
    await s.flow.process();
    expect(s.flow.enqueue(ROUTE, [{ ...s.audio('P2'), kind: 'text', text: 'oi' }]).typingFor).toBeNull();
    s.advance(2 * 3_600_000);
    expect(s.flow.enqueue(ROUTE, [{ ...s.audio('P3'), kind: 'text', text: 'oi' }]).typingFor).toBe('P3');
  });
});

describe('adaptadores de transcrição', () => {
  it('Groq: multipart com modelo, idioma e verbose_json; duração pelo último segmento', async () => {
    let form: FormData | null = null;
    const groq = new GroqTranscriber({
      apiKey: 'k',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3-turbo',
      fetchFn: async (_url, init) => {
        form = init?.body as FormData;
        return Response.json({ text: ' Olá, quero marcar. ', segments: [{ end: 2.5 }, { end: 4.75 }] });
      },
    });
    const out = await groq.transcribe(new Uint8Array([1, 2]), 'audio/ogg; codecs=opus', { language: 'pt', timeoutMs: 1000 });
    expect(out).toEqual({ text: 'Olá, quero marcar.', durationSec: 4.75, provider: 'groq', model: 'whisper-large-v3-turbo' });
    expect(form!.get('model')).toBe('whisper-large-v3-turbo');
    expect(form!.get('language')).toBe('pt');
    expect(form!.get('response_format')).toBe('verbose_json');
    expect((form!.get('file') as File).name).toBe('audio.ogg');
  });

  it('Workers AI: áudio em base64 e duração do transcription_info', async () => {
    let body: Record<string, unknown> = {};
    const wai = new WorkersAITranscriber({
      accountId: 'ACC',
      apiKey: 'k',
      model: '@cf/openai/whisper-large-v3-turbo',
      fetchFn: async (url, init) => {
        expect(String(url)).toBe('https://api.cloudflare.com/client/v4/accounts/ACC/ai/run/@cf/openai/whisper-large-v3-turbo');
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ result: { text: 'oi', transcription_info: { duration: 3.2 } }, success: true });
      },
    });
    const out = await wai.transcribe(new Uint8Array([104, 105]), 'audio/ogg', { language: 'pt', timeoutMs: 1000 });
    expect(body).toEqual({ audio: 'aGk=', language: 'pt', vad_filter: true });
    expect(out.durationSec).toBe(3.2);
  });

  it('silêncio não vira texto inventado (Groq: trecho além do fim; Workers AI: VAD sem fala)', async () => {
    const groq = new GroqTranscriber({
      apiKey: 'k',
      baseUrl: 'https://x',
      model: 'whisper-large-v3-turbo',
      // Resposta real da Groq para 1 s de silêncio (2026-10-03).
      fetchFn: async () => Response.json({ text: ' E aí', duration: 1, segments: [{ end: 5.12, no_speech_prob: 0 }] }),
    });
    expect((await groq.transcribe(new Uint8Array(), 'audio/wav', { language: 'pt', timeoutMs: 1 })).text).toBe('');

    const fala = new GroqTranscriber({
      apiKey: 'k',
      baseUrl: 'https://x',
      model: 'whisper-large-v3-turbo',
      fetchFn: async () => Response.json({ text: 'quero marcar', duration: 3.4, segments: [{ end: 3.4 }] }),
    });
    expect((await fala.transcribe(new Uint8Array(), 'audio/ogg', { language: 'pt', timeoutMs: 1 })).text).toBe('quero marcar');

    const wai = new WorkersAITranscriber({
      accountId: 'A',
      apiKey: 'k',
      model: '@cf/openai/whisper-large-v3-turbo',
      fetchFn: async () =>
        Response.json({ result: { text: 'Obrigado.', transcription_info: { duration: 1, duration_after_vad: 0 } } }),
    });
    expect((await wai.transcribe(new Uint8Array([1]), 'audio/wav', { language: 'pt', timeoutMs: 1 })).text).toBe('');
  });

  it('cadeia: usa a reserva quando o primeiro falha', async () => {
    const failing: Transcriber = { transcribe: async () => Promise.reject(new SttError('rate_limit', '429', 429)) };
    const ok: Transcriber = { transcribe: async () => ({ text: 'ok', durationSec: 1, provider: 'b', model: 'm' }) };
    expect((await new TranscriberChain([failing, ok]).transcribe(new Uint8Array(), 'audio/ogg', { language: 'pt', timeoutMs: 1 })).provider).toBe('b');
    await expect(new TranscriberChain([failing]).transcribe(new Uint8Array(), 'a', { language: 'pt', timeoutMs: 1 })).rejects.toBeInstanceOf(SttError);
  });

  it('monta a cadeia pela variável STT_CHAIN e ignora quem não tem chave', () => {
    expect(buildTranscriber({ STT_CHAIN: 'groq:whisper-large-v3-turbo' })).toBeNull();
    expect(
      buildTranscriber({ STT_CHAIN: 'groq:whisper-large-v3-turbo', GROQ_API_KEY: 'k', GROQ_BASE_URL: 'https://x' }),
    ).not.toBeNull();
  });
});

describe('download de mídia da Meta', () => {
  it('consulta a URL, baixa com o token e respeita o limite', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const sender = new WhatsAppCloudSender({
      graphVersion: 'v26.0',
      getToken: async () => 'tok',
      fetchFn: async (url, init) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
        if (String(url).includes('graph.facebook.com')) {
          return Response.json({ url: 'https://lookaside.fbsbx.com/file', mime_type: 'audio/ogg', file_size: 3 });
        }
        return new Response(new Uint8Array([7, 8, 9]));
      },
    });
    const file = await sender.download('PNID', 'MEDIA1', 1000);
    expect([...file.bytes]).toEqual([7, 8, 9]);
    expect(file.mime).toBe('audio/ogg');
    expect(calls).toEqual([
      { url: 'https://graph.facebook.com/v26.0/MEDIA1', auth: 'Bearer tok' },
      { url: 'https://lookaside.fbsbx.com/file', auth: 'Bearer tok' },
    ]);
    await expect(sender.download('PNID', 'MEDIA1', 2)).rejects.toBeInstanceOf(MediaTooLargeError);
  });
});

describe('falhas depois do envio', () => {
  it('se gravar o wamid falhar, a resposta conta como enviada (sem "falha no envio")', async () => {
    const store = new MemoryInboxStore();
    const sender = new Sender();
    const logger = new MemoryLogger();
    const flow = new ConversationFlow({
      store,
      sender,
      logger,
      clock: { now: () => new Date(T0) },
      markSent: async () => {
        throw new Error('UNIQUE constraint failed');
      },
      engine: { handleTurn: async (i) => result(i), runSummary: async () => true },
    });
    flow.enqueue(ROUTE, [{ waMessageId: 'M1', kind: 'text', text: 'oi', at: new Date(T0).toISOString(), profileName: null }]);
    await flow.process();
    expect(sender.texts).toEqual(['ok']);
    const events = logger.lines.map((l) => l.event);
    expect(events).toContain('mark_sent_failed');
    expect(events).not.toContain('whatsapp_send_failed');
  });
});
