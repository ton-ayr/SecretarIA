// Leitura do corpo do webhook da Meta (field "messages"). Formato verificado
// em 2026-10-03 (ARQUITETURA §16). Tudo que não é reconhecido é ignorado.

export type InboundKind =
  | 'text'
  | 'interactive'
  | 'button'
  | 'audio'
  | 'image'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'other';

export interface InboundEvent {
  metaPhoneNumberId: string;
  waId: string;
  profileName: string | null;
  waMessageId: string;
  /** ISO 8601 UTC. */
  at: string;
  kind: InboundKind;
  /** Texto, título do botão escolhido ou legenda da mídia ('' se não houver). */
  text: string;
  /** id da opção escolhida numa lista ou botão. */
  replyId: string | null;
  /** id da mídia na Meta (áudio é baixado e transcrito). */
  mediaId: string | null;
  /** Tipo do arquivo informado pela Meta (ex.: "audio/ogg; codecs=opus"). */
  mime: string | null;
}

export interface StatusEvent {
  metaPhoneNumberId: string;
  waMessageId: string;
  status: string;
  at: string;
  errorCode: number | null;
  billable: boolean;
  /** utility, marketing, authentication, service... */
  category: string | null;
}

export interface ParsedWebhook {
  messages: InboundEvent[];
  statuses: StatusEvent[];
}

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function tsToIso(ts: unknown): string {
  const sec = Number(ts);
  return new Date(Number.isFinite(sec) && sec > 0 ? sec * 1000 : Date.now()).toISOString();
}

const MEDIA_KINDS = ['audio', 'image', 'video', 'document', 'sticker'] as const;

function parseMessage(m: Json, metaPhoneNumberId: string, names: Map<string, string>): InboundEvent | null {
  const waId = str(m.from);
  const waMessageId = str(m.id);
  const type = str(m.type);
  if (!waId || !waMessageId || !type) return null;
  // Reações e mensagens de sistema não pedem resposta.
  if (type === 'reaction' || type === 'system' || type === 'unsupported' || type === 'ephemeral') return null;

  const base = {
    metaPhoneNumberId,
    waId,
    profileName: names.get(waId) ?? null,
    waMessageId,
    at: tsToIso(m.timestamp),
    replyId: null as string | null,
    mediaId: null as string | null,
    mime: null as string | null,
  };

  if (type === 'text' && isObj(m.text)) {
    return { ...base, kind: 'text', text: str(m.text.body) ?? '' };
  }
  if (type === 'interactive' && isObj(m.interactive)) {
    const reply = isObj(m.interactive.list_reply)
      ? m.interactive.list_reply
      : isObj(m.interactive.button_reply)
        ? m.interactive.button_reply
        : null;
    if (!reply) return null;
    return { ...base, kind: 'interactive', text: str(reply.title) ?? '', replyId: str(reply.id) };
  }
  if (type === 'button' && isObj(m.button)) {
    // Botão de resposta rápida de template (lembrete).
    return { ...base, kind: 'button', text: str(m.button.text) ?? '', replyId: str(m.button.payload) };
  }
  for (const kind of MEDIA_KINDS) {
    if (type === kind) {
      const media = isObj(m[kind]) ? (m[kind] as Json) : {};
      return { ...base, kind, text: str(media.caption) ?? '', mediaId: str(media.id), mime: str(media.mime_type) };
    }
  }
  if (type === 'location' || type === 'contacts') return { ...base, kind: type, text: '' };
  return { ...base, kind: 'other', text: '' };
}

function parseStatus(s: Json, metaPhoneNumberId: string): StatusEvent | null {
  const waMessageId = str(s.id);
  const status = str(s.status);
  if (!waMessageId || !status) return null;
  const firstError = arr(s.errors).find(isObj);
  const pricing = isObj(s.pricing) ? s.pricing : null;
  return {
    metaPhoneNumberId,
    waMessageId,
    status,
    at: tsToIso(s.timestamp),
    errorCode: firstError && typeof firstError.code === 'number' ? firstError.code : null,
    billable: pricing?.billable === true,
    category: str(pricing?.category),
  };
}

export function parseWebhook(body: unknown): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], statuses: [] };
  if (!isObj(body) || body.object !== 'whatsapp_business_account') return out;

  for (const entry of arr(body.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue;
      const value = change.value;
      const metaPhoneNumberId = isObj(value.metadata) ? str(value.metadata.phone_number_id) : null;
      if (!metaPhoneNumberId) continue;

      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        if (isObj(c) && str(c.wa_id) && isObj(c.profile) && str(c.profile.name)) {
          names.set(c.wa_id as string, c.profile.name as string);
        }
      }
      for (const m of arr(value.messages)) {
        const ev = isObj(m) ? parseMessage(m, metaPhoneNumberId, names) : null;
        if (ev) out.messages.push(ev);
      }
      for (const s of arr(value.statuses)) {
        const ev = isObj(s) ? parseStatus(s, metaPhoneNumberId) : null;
        if (ev) out.statuses.push(ev);
      }
    }
  }
  return out;
}

/** Tipos que viram texto para a IA. */
export function isTextual(kind: string): boolean {
  return kind === 'text' || kind === 'interactive' || kind === 'button';
}

/** Como uma mensagem não textual aparece para a IA e no histórico. */
export function mediaPlaceholder(kind: string): string {
  switch (kind) {
    case 'audio':
      return '[o cliente enviou um áudio]';
    case 'image':
      return '[o cliente enviou uma imagem]';
    case 'video':
      return '[o cliente enviou um vídeo]';
    case 'document':
      return '[o cliente enviou um documento]';
    case 'sticker':
      return '[o cliente enviou uma figurinha]';
    case 'location':
      return '[o cliente enviou uma localização]';
    case 'contacts':
      return '[o cliente enviou um contato]';
    default:
      return '[o cliente enviou uma mensagem que não é texto]';
  }
}
