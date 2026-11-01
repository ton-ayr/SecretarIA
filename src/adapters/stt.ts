import type { Transcriber, Transcription } from '../ports/transcriber.ts';

/**
 * Transcrição de áudio (verificado em 2026-10-03, ARQUITETURA §16):
 * - Groq: POST /audio/transcriptions (multipart), ogg/mp3/m4a/wav/webm...,
 *   até 25 MB no plano grátis, cobra no mínimo 10 s;
 * - Workers AI: POST /ai/run/@cf/openai/whisper-large-v3-turbo com o áudio
 *   em base64; devolve transcription_info.duration.
 *
 * Silêncio: o Whisper "inventa" texto em áudio sem fala (testado em
 * 2026-10-03: 1 s de silêncio virou "E aí" na Groq e "Obrigado." no Workers
 * AI). Na Groq, o no_speech_prob veio 0; o sinal confiável foi o trecho
 * terminar depois do fim do áudio. No Workers AI, vad_filter resolve.
 * Sem fala, devolvemos texto vazio (o fluxo responde "não consegui entender").
 */

/** Folga para arredondamento dos tempos dos trechos. */
const SEGMENT_SLACK_SEC = 1.5;

export class SttError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'rate_limit' | 'server' | 'client' | 'invalid_response',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

function extFor(mime: string): string {
  return EXT_BY_MIME[mime.split(';')[0]!.trim().toLowerCase()] ?? 'ogg';
}

async function post(fetchFn: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    throw new SttError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', 'falha ao chamar a transcrição');
  }
  if (!res.ok) {
    await res.body?.cancel();
    const kind = res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'server' : 'client';
    throw new SttError(kind, `transcrição HTTP ${res.status}`, res.status);
  }
  try {
    return await res.json();
  } catch {
    throw new SttError('invalid_response', 'resposta da transcrição não é JSON');
  }
}

export class GroqTranscriber implements Transcriber {
  readonly provider = 'groq';
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: { apiKey: string; baseUrl: string; model: string; fetchFn?: typeof fetch }) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async transcribe(audio: Uint8Array, mime: string, o: { language: string; timeoutMs: number }): Promise<Transcription> {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), `audio.${extFor(mime)}`);
    form.append('model', this.opts.model);
    form.append('language', o.language);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    const json = (await post(
      this.fetchFn,
      `${this.opts.baseUrl}/audio/transcriptions`,
      { method: 'POST', headers: { authorization: `Bearer ${this.opts.apiKey}` }, body: form },
      o.timeoutMs,
    )) as { text?: string; duration?: number; segments?: Array<{ end?: number }> };
    if (typeof json.text !== 'string') throw new SttError('invalid_response', 'transcrição sem texto');
    const lastEnd = json.segments?.at(-1)?.end;
    const duration = typeof json.duration === 'number' ? json.duration : null;
    // Trecho terminando depois do fim do áudio = texto inventado (sem fala).
    const hallucinated =
      duration !== null && (json.segments ?? []).some((s) => typeof s.end === 'number' && s.end > duration + SEGMENT_SLACK_SEC);
    return {
      text: hallucinated ? '' : json.text.trim(),
      durationSec: duration ?? (typeof lastEnd === 'number' ? lastEnd : null),
      provider: this.provider,
      model: this.opts.model,
    };
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export class WorkersAITranscriber implements Transcriber {
  readonly provider = 'workersai';
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: { accountId: string; apiKey: string; model: string; fetchFn?: typeof fetch }) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async transcribe(audio: Uint8Array, _mime: string, o: { language: string; timeoutMs: number }): Promise<Transcription> {
    const json = (await post(
      this.fetchFn,
      `https://api.cloudflare.com/client/v4/accounts/${this.opts.accountId}/ai/run/${this.opts.model}`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        // vad_filter: tira o silêncio antes de transcrever (evita texto inventado).
        body: JSON.stringify({ audio: toBase64(audio), language: o.language, vad_filter: true }),
      },
      o.timeoutMs,
    )) as { result?: { text?: string; transcription_info?: { duration?: number; duration_after_vad?: number } } };
    const text = json.result?.text;
    if (typeof text !== 'string') throw new SttError('invalid_response', 'transcrição sem texto');
    const info = json.result?.transcription_info;
    const duration = info?.duration;
    const noSpeech = info?.duration_after_vad === 0;
    return {
      text: noSpeech ? '' : text.trim(),
      durationSec: typeof duration === 'number' ? duration : null,
      provider: this.provider,
      model: this.opts.model,
    };
  }
}

/** Tenta cada provedor em ordem; o primeiro que responder vence. */
export class TranscriberChain implements Transcriber {
  constructor(private readonly items: Transcriber[]) {}

  async transcribe(audio: Uint8Array, mime: string, o: { language: string; timeoutMs: number }): Promise<Transcription> {
    let last: unknown = new SttError('client', 'nenhum provedor de transcrição configurado');
    for (const t of this.items) {
      try {
        return await t.transcribe(audio, mime, o);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }
}

export interface SttEnv {
  STT_CHAIN?: string;
  GROQ_BASE_URL?: string;
  GROQ_API_KEY?: string;
  WORKERSAI_ACCOUNT_ID?: string;
  WORKERSAI_API_KEY?: string;
}

/** Lê STT_CHAIN ("groq:whisper-large-v3-turbo,workersai:@cf/openai/whisper-large-v3-turbo"). */
export function buildTranscriber(env: SttEnv, fetchFn?: typeof fetch): TranscriberChain | null {
  const items: Transcriber[] = [];
  for (const entry of (env.STT_CHAIN ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const sep = entry.indexOf(':');
    const provider = entry.slice(0, sep);
    const model = entry.slice(sep + 1);
    if (provider === 'groq' && env.GROQ_API_KEY && env.GROQ_BASE_URL) {
      items.push(new GroqTranscriber({ apiKey: env.GROQ_API_KEY, baseUrl: env.GROQ_BASE_URL, model, fetchFn }));
    } else if (provider === 'workersai' && env.WORKERSAI_API_KEY && env.WORKERSAI_ACCOUNT_ID) {
      items.push(
        new WorkersAITranscriber({ accountId: env.WORKERSAI_ACCOUNT_ID, apiKey: env.WORKERSAI_API_KEY, model, fetchFn }),
      );
    }
  }
  return items.length ? new TranscriberChain(items) : null;
}
