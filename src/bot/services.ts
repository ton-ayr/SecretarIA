import { D1Repo } from '../adapters/d1-repo.ts';
import { ProviderHealth } from '../adapters/llm-chain.ts';
import { GoogleCalendarClient, parseServiceAccount } from '../adapters/google-calendar.ts';
import { buildLLMChain } from '../adapters/llm-config.ts';
import { buildTranscriber } from '../adapters/stt.ts';
import { TelegramClient } from '../adapters/telegram.ts';
import { TelegramOperatorNotifier, TelegramTeamNotifier } from '../adapters/telegram-notifier.ts';
import { DryRunSender, WhatsAppCloudSender } from '../adapters/whatsapp-cloud.ts';
import { DEFAULT_FLOW_CONFIG, type FlowConfig } from '../core/conversation-flow.ts';
import { ConversationEngine } from '../core/engine.ts';
import { readOnlyCalendar, silentTeamNotifier } from '../core/test-chat.ts';
import { DEFAULT_PRICING } from '../core/pricing.ts';
import { parseQuotaLimits } from '../core/quota.ts';
import type { ExternalCalendar } from '../ports/calendar.ts';
import type { ConversationRoute, PhoneRoute } from '../ports/repo.ts';
import { systemClock } from '../ports/runtime.ts';
import type { HandoffNotifier, OperatorNotifier } from '../ports/notifier.ts';
import type { MediaFetcher, Transcriber } from '../ports/transcriber.ts';
import type { WhatsAppSender } from '../ports/whatsapp.ts';
import { decryptSecret } from '../shared/crypto.ts';
import { JsonLogger } from '../shared/logger.ts';
import type { Env } from './env.ts';

// Montagem dos serviços a partir do ambiente. Caches ficam no isolate
// (memória do Worker/objeto), com prazo curto.

export const logger = new JsonLogger({ service: 'bot' });

/** Saúde dos provedores de IA, compartilhada entre turnos do mesmo isolate. */
const providerHealth = new ProviderHealth();

const ROUTE_TTL_MS = 60_000;
const TOKEN_TTL_MS = 10 * 60_000;
const routeCache = new Map<string, { route: PhoneRoute; exp: number }>();
const tokenCache = new Map<string, { token: string; exp: number }>();

export async function resolveRoute(repo: D1Repo, metaPhoneNumberId: string): Promise<PhoneRoute | null> {
  const now = Date.now();
  const hit = routeCache.get(metaPhoneNumberId);
  if (hit && hit.exp > now) return hit.route;
  const route = await repo.lookupPhoneNumber(metaPhoneNumberId);
  // Só guarda número encontrado: "não encontrado" em cache faria o bot
  // ignorar, por até um minuto, um número que acabou de ser cadastrado.
  if (route) routeCache.set(metaPhoneNumberId, { route, exp: now + ROUTE_TTL_MS });
  return route;
}

async function tokenFor(env: Env, repo: D1Repo, metaPhoneNumberId: string): Promise<string> {
  const route = await resolveRoute(repo, metaPhoneNumberId);
  if (!route?.metaAccountId) throw new Error('número sem conta Meta vinculada');
  const now = Date.now();
  const hit = tokenCache.get(route.metaAccountId);
  if (hit && hit.exp > now) return hit.token;
  if (!env.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY não configurada');
  const secret = await repo.ops.getMetaAccountSecret(route.metaAccountId);
  if (!secret) throw new Error('conta Meta sem token');
  const token = await decryptSecret(env.ENCRYPTION_KEY, secret.accessTokenEnc);
  tokenCache.set(route.metaAccountId, { token, exp: now + TOKEN_TTL_MS });
  return token;
}

/** Esquece os tokens da Meta em memória (depois de trocar um no painel). */
export function forgetMetaTokens(): void {
  tokenCache.clear();
}

/** Durable Object da conversa: um por número da empresa + cliente. */
export function conversationStub(env: Env, route: Pick<ConversationRoute, 'metaPhoneNumberId' | 'waId'>) {
  return env.CONVERSATION.get(env.CONVERSATION.idFromName(`${route.metaPhoneNumberId}:${route.waId}`));
}

export function createRepo(env: Env): D1Repo {
  return new D1Repo(env.DB);
}

export function createSender(env: Env, repo: D1Repo): WhatsAppSender & MediaFetcher {
  if (env.WHATSAPP_DRY_RUN === '1') return new DryRunSender();
  return new WhatsAppCloudSender({
    graphVersion: env.GRAPH_API_VERSION,
    getToken: (from) => tokenFor(env, repo, from),
  });
}

export function createTelegram(env: Env): TelegramClient | null {
  return env.TELEGRAM_BOT_TOKEN ? new TelegramClient(env.TELEGRAM_BOT_TOKEN) : null;
}

/** Avisos à equipe e ao operador. Sem token do Telegram, o bot não chama a equipe. */
export function createNotifiers(env: Env, repo: D1Repo): { team?: HandoffNotifier; operator?: OperatorNotifier } {
  const tg = createTelegram(env);
  if (!tg || !env.ENCRYPTION_KEY) return {};
  const deps = { repo, tg, encryptionKey: env.ENCRYPTION_KEY, clock: systemClock, logger };
  return { team: new TelegramTeamNotifier(deps), operator: new TelegramOperatorNotifier(deps) };
}

/** Cliente do Google Agenda, reaproveitado no isolate (guarda o token de acesso). */
let calendarCache: { raw: string; client: ExternalCalendar } | null = null;

export function createCalendar(env: Env): ExternalCalendar | undefined {
  const raw = env.GOOGLE_SERVICE_ACCOUNT?.trim();
  if (!raw) return undefined;
  if (calendarCache?.raw === raw) return calendarCache.client;
  try {
    const client = new GoogleCalendarClient(parseServiceAccount(raw));
    calendarCache = { raw, client };
    return client;
  } catch {
    logger.error('google_service_account_invalid');
    return undefined;
  }
}

export function createTranscriber(env: Env): Transcriber | undefined {
  return buildTranscriber(env) ?? undefined;
}

/**
 * Motor de conversa. `test`: chat de teste do painel — a equipe não é avisada
 * de verdade e a agenda Google é só lida (ver core/test-chat.ts).
 */
export function createEngine(env: Env, repo: D1Repo, opts: { test?: boolean } = {}): ConversationEngine {
  const { chain, skipped } = buildLLMChain(env, { health: providerHealth });
  if (skipped.length) logger.warn('llm_providers_skipped', { providers: skipped.join(',') });
  const { team, operator } = createNotifiers(env, repo);
  const calendar = createCalendar(env);
  return new ConversationEngine({
    repo,
    llm: chain,
    clock: systemClock,
    logger,
    notifier: opts.test ? silentTeamNotifier : team,
    operator,
    scheduling: env.PUBLIC_BASE_URL
      ? { calendar: opts.test ? readOnlyCalendar(calendar) : calendar, publicBaseUrl: env.PUBLIC_BASE_URL }
      : undefined,
    onQuotaAlert: async (a) => {
      await operator?.notifyOperator(
        `quota:${a.provider}:${a.model}`,
        `⚠️ Cota grátis da IA: ${a.provider}:${a.model} passou de ${Math.round(a.usedRatio * 100)}% hoje.`,
      );
    },
    config: {
      pricing: DEFAULT_PRICING,
      quotaLimits: parseQuotaLimits(env.LLM_DAILY_LIMITS),
      logHashKey: env.LOG_HASH_KEY ?? '',
    },
  });
}

function intVar(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function flowConfig(env: Env): FlowConfig {
  return {
    ...DEFAULT_FLOW_CONFIG,
    debounceMs: intVar(env.GROUPING_DEBOUNCE_MS, DEFAULT_FLOW_CONFIG.debounceMs),
    maxWaitMs: intVar(env.GROUPING_MAX_WAIT_MS, DEFAULT_FLOW_CONFIG.maxWaitMs),
    rateLimitPerHour: intVar(env.RATE_LIMIT_PER_HOUR, DEFAULT_FLOW_CONFIG.rateLimitPerHour),
  };
}
