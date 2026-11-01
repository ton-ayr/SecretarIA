import type { Context } from 'hono';
import { D1AdminRepo } from '../adapters/d1-admin.ts';
import { systemClock } from '../ports/runtime.ts';
import { JsonLogger } from '../shared/logger.ts';
import { unverifiedAudience, verifyAccessJwt } from './access-jwt.ts';
import { createAdminApp } from './app.tsx';
import type { AdminEnv } from './env.ts';

// Worker "admin": o painel do operador. Fica atrás do Cloudflare Access
// (aba Access do Worker) e confere de novo quem entrou (ADMIN_EMAILS).

const logger = new JsonLogger({ service: 'admin' });

export function parseEmails(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

/**
 * Identidade do Access. Primeiro `ctx.access` (Access no próprio Worker); se o
 * runtime não preencher, valida o token do cabeçalho Cf-Access-Jwt-Assertion
 * (RS256, emissor e audiência). Sem nenhum dos dois, ninguém entra.
 */
async function identify(c: Context): Promise<string | null> {
  let access: CloudflareAccessContext | undefined;
  try {
    access = (c.executionCtx as ExecutionContext).access;
  } catch {
    return null;
  }
  if (access) {
    const identity = await access.getIdentity();
    if (typeof identity?.email === 'string' && identity.email) return identity.email;
  }
  const token = c.req.header('cf-access-jwt-assertion');
  if (!token) {
    logger.warn('admin_identity_missing', { has_access_ctx: Boolean(access), has_jwt_header: false });
    return null;
  }
  const env = c.env as AdminEnv;
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim() ?? '';
  const aud = env.ACCESS_AUD?.trim() ?? '';
  if (!teamDomain || !aud) {
    // A tag AUD não é segredo: vem no próprio token. Registrada para configurar ACCESS_AUD.
    logger.warn('admin_access_config_missing', { team_domain: Boolean(teamDomain), token_aud: unverifiedAudience(token).join(',') });
    return null;
  }
  try {
    const email = await verifyAccessJwt(token, { teamDomain, aud, now: Date.now });
    if (!email) logger.warn('admin_access_jwt_invalid', { token_aud: unverifiedAudience(token).join(',') });
    return email;
  } catch (err) {
    logger.error('admin_access_certs_failed', { error_code: err instanceof Error ? err.name : 'unknown' });
    return null;
  }
}

const app = createAdminApp<AdminEnv>((env) => ({
  repo: new D1AdminRepo(env.DB),
  bot: env.BOT,
  identify,
  allowedEmails: parseEmails(env.ADMIN_EMAILS),
  clock: systemClock,
  logger,
  metaPriceBrlMilli: Number(env.META_PRICE_BRL_MILLI) > 0 ? Number(env.META_PRICE_BRL_MILLI) : 35,
}));

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<AdminEnv>;
