import {
  WhatsAppError,
  type ButtonsMessage,
  type ListMessage,
  type TemplateMessage,
  type SendResult,
  type WhatsAppErrorKind,
  type WhatsAppSender,
} from '../ports/whatsapp.ts';
import type { MediaFetcher } from '../ports/transcriber.ts';

/**
 * Adaptador da WhatsApp Cloud API (Graph API). Formatos verificados em
 * 2026-10-02/03 (ARQUITETURA §16).
 *
 * Envio não é repetido automaticamente: num timeout não dá para saber se a
 * mensagem saiu, e mandar duas vezes é pior que avisar a equipe.
 */
export interface WhatsAppCloudOptions {
  graphVersion: string;
  /** Token da conta Meta dona do número `from` (decifrado do D1). */
  getToken: (from: string) => Promise<string>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

// Códigos da Meta mais comuns (a confirmar na lista oficial quando aparecerem).
const META_CODE_KIND: Record<number, WhatsAppErrorKind> = {
  190: 'auth', // token inválido ou expirado
  131047: 'window_closed', // mais de 24h desde a última mensagem do cliente
  131030: 'recipient', // número de teste: destino fora da lista permitida
  131026: 'recipient', // não foi possível entregar
  130429: 'rate_limit',
  131056: 'rate_limit',
};

/** Mídia maior que o limite pedido (áudio longo demais para transcrever). */
export class MediaTooLargeError extends Error {
  constructor() {
    super('mídia maior que o limite');
    this.name = 'MediaTooLargeError';
  }
}

export class WhatsAppCloudSender implements WhatsAppSender, MediaFetcher {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: WhatsAppCloudOptions) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  }

  sendText(from: string, to: string, body: string): Promise<SendResult> {
    return this.send(from, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: false },
    });
  }

  sendList(from: string, to: string, list: ListMessage): Promise<SendResult> {
    return this.send(from, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: list.body },
        action: { button: list.button, sections: [{ title: 'Opções', rows: list.rows }] },
      },
    });
  }

  sendButtons(from: string, to: string, message: ButtonsMessage): Promise<SendResult> {
    return this.send(from, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: message.body },
        action: { buttons: message.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
      },
    });
  }

  sendTemplate(from: string, to: string, t: TemplateMessage): Promise<SendResult> {
    return this.send(from, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: t.name,
        language: { code: t.language },
        components: [
          { type: 'body', parameters: t.bodyParams.map((text) => ({ type: 'text', text })) },
          ...t.quickReplyPayloads.map((payload, index) => ({
            type: 'button',
            sub_type: 'quick_reply',
            index: String(index),
            parameters: [{ type: 'payload', payload }],
          })),
        ],
      },
    });
  }

  async markReadWithTyping(from: string, waMessageId: string): Promise<void> {
    await this.post(from, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: waMessageId,
      typing_indicator: { type: 'text' },
    });
  }

  /**
   * Baixa mídia recebida: GET /{media-id} devolve uma URL que vale 5 minutos;
   * o arquivo exige o mesmo token (ARQUITETURA §16).
   */
  async download(from: string, mediaId: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string }> {
    const token = await this.opts.getToken(from);
    const auth = { authorization: `Bearer ${token}`, 'user-agent': 'SecretarIA/1.0' };
    let meta: Response;
    try {
      meta = await this.fetchFn(`https://graph.facebook.com/${this.opts.graphVersion}/${mediaId}`, {
        headers: auth,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch {
      throw new WhatsAppError('network', 'falha ao consultar a mídia');
    }
    if (!meta.ok) {
      await meta.body?.cancel();
      throw new WhatsAppError(meta.status === 401 ? 'auth' : 'client', `mídia HTTP ${meta.status}`, meta.status);
    }
    const info = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
    if (!info.url) throw new WhatsAppError('server', 'mídia sem URL');
    if (typeof info.file_size === 'number' && info.file_size > maxBytes) throw new MediaTooLargeError();

    let file: Response;
    try {
      file = await this.fetchFn(info.url, { headers: auth, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new WhatsAppError('network', 'falha ao baixar a mídia');
    }
    if (!file.ok) {
      await file.body?.cancel();
      throw new WhatsAppError('client', `download HTTP ${file.status}`, file.status);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > maxBytes) throw new MediaTooLargeError();
    return { bytes, mime: info.mime_type ?? file.headers.get('content-type') ?? 'application/octet-stream' };
  }

  private async send(from: string, payload: unknown): Promise<SendResult> {
    const json = (await this.post(from, payload)) as { messages?: Array<{ id?: string }> };
    const id = json.messages?.[0]?.id;
    if (!id) throw new WhatsAppError('server', 'resposta sem id da mensagem');
    return { waMessageId: id };
  }

  private async post(from: string, payload: unknown): Promise<unknown> {
    const token = await this.opts.getToken(from);
    let res: Response;
    try {
      res = await this.fetchFn(`https://graph.facebook.com/${this.opts.graphVersion}/${from}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch {
      throw new WhatsAppError('network', 'falha de rede ou timeout ao chamar a Graph API');
    }
    if (res.ok) return res.json();

    let metaCode: number | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: number } };
      metaCode = body.error?.code;
    } catch {
      // corpo não é JSON
    }
    const kind: WhatsAppErrorKind =
      (metaCode !== undefined ? META_CODE_KIND[metaCode] : undefined) ??
      (res.status === 401 ? 'auth' : res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'server' : 'client');
    throw new WhatsAppError(kind, `Graph API HTTP ${res.status}`, res.status, metaCode);
  }
}

/** Envio de mentira para `wrangler dev`: mostra no terminal e não chama a Meta. */
export class DryRunSender implements WhatsAppSender, MediaFetcher {
  async download(): Promise<{ bytes: Uint8Array; mime: string }> {
    throw new WhatsAppError('client', 'dry-run não baixa mídia');
  }

  private counter = 0;

  async sendText(_from: string, _to: string, body: string): Promise<SendResult> {
    console.log(`[dry-run] resposta: ${body}`);
    return { waMessageId: `dryrun.${Date.now()}.${++this.counter}` };
  }

  async sendList(_from: string, _to: string, list: ListMessage): Promise<SendResult> {
    console.log(`[dry-run] lista: ${list.body} | ${list.rows.map((r) => r.title).join(' / ')}`);
    return { waMessageId: `dryrun.${Date.now()}.${++this.counter}` };
  }

  async sendButtons(_from: string, _to: string, m: ButtonsMessage): Promise<SendResult> {
    console.log(`[dry-run] botões: ${m.body} | ${m.buttons.map((b) => b.title).join(' / ')}`);
    return { waMessageId: `dryrun.${Date.now()}.${++this.counter}` };
  }

  async sendTemplate(_from: string, _to: string, t: TemplateMessage): Promise<SendResult> {
    console.log(`[dry-run] template ${t.name}: ${t.bodyParams.join(' | ')}`);
    return { waMessageId: `dryrun.${Date.now()}.${++this.counter}` };
  }

  async markReadWithTyping(): Promise<void> {
    console.log('[dry-run] lida + digitando…');
  }
}
