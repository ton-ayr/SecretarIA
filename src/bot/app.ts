import { Hono } from 'hono';
import {
  buildIcs,
  CALENDAR_TOKEN_RE,
  calendarLinkPage,
  calendarMessagePage,
  googleCalendarUrl,
  pickCalendarTarget,
} from '../core/calendar-link.ts';
import type { InboxItem } from '../core/conversation-flow.ts';
import type { CalendarLinkView } from '../ports/scheduling.ts';
import { parseWebhook, type InboundEvent, type StatusEvent } from '../core/whatsapp-payload.ts';
import type { PhoneRoute } from '../ports/repo.ts';
import type { Logger } from '../ports/runtime.ts';
import { verifyMetaSignature } from '../shared/signature.ts';
import { handleTelegramUpdate, isTelegramRequestValid, type TelegramWebhookDeps } from './telegram-webhook.ts';

/**
 * Rotas públicas do bot. As dependências entram por WebhookDeps para que a
 * rota seja testada sem Cloudflare.
 */
export interface WebhookDeps {
  verifyToken: string | undefined;
  appSecret: string | undefined;
  logger: Logger;
  resolveRoute(metaPhoneNumberId: string): Promise<PhoneRoute | null>;
  /** Entrega ao Durable Object da conversa e espera a gravação. */
  deliver(route: PhoneRoute, metaPhoneNumberId: string, waId: string, items: InboxItem[]): Promise<void>;
  recordStatus(route: PhoneRoute, status: StatusEvent): Promise<void>;
  /** Link "Salvar na agenda" do cliente (token aleatório, sem tenant). */
  findCalendarLink?(token: string): Promise<CalendarLinkView | null>;
}

// O token no endereço é a chave: nada de cache, indexação ou Referer.
const CALENDAR_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
  'X-Content-Type-Options': 'nosniff',
} as const;
const PAGE_HEADERS = {
  ...CALENDAR_HEADERS,
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
} as const;

function toInboxItem(ev: InboundEvent): InboxItem {
  return {
    waMessageId: ev.waMessageId,
    kind: ev.kind,
    text: ev.text,
    at: ev.at,
    profileName: ev.profileName,
    mediaId: ev.mediaId,
    mime: ev.mime,
    replyId: ev.replyId,
  };
}

export function createApp<E extends object>(
  getDeps: (env: E) => WebhookDeps,
  getTelegramDeps?: (env: E) => TelegramWebhookDeps | null,
): Hono<{ Bindings: E }> {
  const app = new Hono<{ Bindings: E }>();

  // Telegram: avisos da equipe, respostas do dono e "devolver ao bot".
  // Responde sempre 200 (depois de processar): reenviar não ajudaria e
  // poderia duplicar a resposta ao cliente.
  app.post('/telegram/webhook', async (c) => {
    const deps = getTelegramDeps?.(c.env) ?? null;
    if (!deps) return c.text('not configured', 404);
    if (!isTelegramRequestValid(deps.secret, c.req.header('x-telegram-bot-api-secret-token'))) {
      deps.logger.warn('telegram_secret_invalid');
      return c.text('unauthorized', 401);
    }
    try {
      await handleTelegramUpdate(await c.req.json(), deps);
    } catch (err) {
      deps.logger.error('telegram_update_failed', { error_code: err instanceof Error ? err.name : 'unknown' });
    }
    return c.text('ok', 200);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // "Salvar na agenda": Android vai ao Google Agenda, iPhone recebe .ics.
  app.get('/a/:token/:format?', async (c) => {
    const deps = getDeps(c.env);
    const token = c.req.param('token');
    const format = c.req.param('format');
    if (!deps.findCalendarLink || !CALENDAR_TOKEN_RE.test(token) || (format !== undefined && format !== 'ics')) {
      return c.body(calendarMessagePage('Link inválido', 'Este link não existe ou já expirou.'), 404, PAGE_HEADERS);
    }
    let view: CalendarLinkView | null;
    try {
      view = await deps.findCalendarLink(token);
    } catch (err) {
      deps.logger.error('calendar_link_failed', { error_code: err instanceof Error ? err.name : 'unknown' });
      return c.body(calendarMessagePage('Tente de novo', 'Não consegui abrir agora. Tente de novo em instantes.'), 503, PAGE_HEADERS);
    }
    if (!view) return c.body(calendarMessagePage('Link inválido', 'Este link não existe ou já expirou.'), 404, PAGE_HEADERS);
    if (view.status === 'cancelled') {
      return c.body(calendarMessagePage('Horário cancelado', 'Este horário foi cancelado. Para marcar outro, é só chamar no WhatsApp.'), 410, PAGE_HEADERS);
    }

    const target = format === 'ics' ? 'ios' : pickCalendarTarget(c.req.header('user-agent'));
    deps.logger.info('calendar_link_opened', { target });
    if (target === 'android') return c.body(null, 302, { ...CALENDAR_HEADERS, Location: googleCalendarUrl(view) });
    if (target === 'ios') {
      return c.body(buildIcs(view, token, new Date()), 200, {
        ...CALENDAR_HEADERS,
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="agendamento.ics"',
      });
    }
    return c.body(calendarLinkPage(view, token), 200, PAGE_HEADERS);
  });

  // Verificação do webhook pela Meta.
  app.get('/webhook', (c) => {
    const deps = getDeps(c.env);
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge') ?? '';
    if (mode === 'subscribe' && deps.verifyToken && token === deps.verifyToken) {
      deps.logger.info('webhook_verified');
      return c.text(challenge, 200);
    }
    deps.logger.warn('webhook_verify_rejected');
    return c.text('forbidden', 403);
  });

  // Eventos da Meta: valida a assinatura, entrega ao Durable Object e só
  // então responde 200. Se algo falhar, responde 500 e a Meta reenvia (a
  // reentrega é descartada pela idempotência).
  app.post('/webhook', async (c) => {
    const deps = getDeps(c.env);
    if (!deps.appSecret) {
      deps.logger.error('webhook_config_missing', { missing: 'META_APP_SECRET' });
      return c.text('config', 500);
    }
    const raw = await c.req.arrayBuffer();
    if (!(await verifyMetaSignature(deps.appSecret, raw, c.req.header('x-hub-signature-256')))) {
      deps.logger.warn('webhook_signature_invalid', { bytes: raw.byteLength });
      return c.text('invalid signature', 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      // Assinatura válida mas JSON inválido: não adianta a Meta reenviar.
      deps.logger.warn('webhook_invalid_json');
      return c.text('ok', 200);
    }
    const parsed = parseWebhook(body);
    deps.logger.info('webhook_received', { messages: parsed.messages.length, statuses: parsed.statuses.length });

    // Agrupa por conversa (número da empresa + cliente), mantendo a ordem.
    const groups = new Map<string, InboundEvent[]>();
    for (const ev of parsed.messages) {
      const key = `${ev.metaPhoneNumberId}:${ev.waId}`;
      groups.set(key, [...(groups.get(key) ?? []), ev]);
    }

    try {
      await Promise.all([
        ...[...groups.values()].map(async (events) => {
          const first = events[0]!;
          const route = await deps.resolveRoute(first.metaPhoneNumberId);
          if (!route) {
            deps.logger.warn('webhook_unknown_number', { meta_phone_number_id: first.metaPhoneNumberId });
            return;
          }
          await deps.deliver(route, first.metaPhoneNumberId, first.waId, events.map(toInboxItem));
        }),
        ...parsed.statuses.map(async (st) => {
          const route = await deps.resolveRoute(st.metaPhoneNumberId);
          if (!route) return;
          if (st.status === 'failed') {
            deps.logger.warn('delivery_failed', { tenant_id: route.tenantId, meta_code: st.errorCode });
          }
          await deps.recordStatus(route, st);
        }),
      ]);
    } catch (err) {
      deps.logger.error('webhook_failed', { error_code: err instanceof Error ? err.name : 'unknown' });
      return c.text('retry', 500);
    }
    return c.text('ok', 200);
  });

  return app;
}
