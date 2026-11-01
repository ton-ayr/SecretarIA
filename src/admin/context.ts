import type { Context, Hono } from 'hono';
import type { AdminRepo, TenantSettings } from '../ports/admin.ts';
import type { BotAdminApi } from '../ports/bot-admin.ts';
import type { Clock, Logger } from '../ports/runtime.ts';
import type { FormValues } from './forms.ts';
import { flashFrom, type Flash, type PageProps, type TenantTab } from './views/layout.tsx';

/** Dependências do painel (entram por injeção para testar sem Cloudflare). */
export interface AdminDeps {
  repo: AdminRepo;
  /** RPC do bot (service binding): tudo que precisa de segredo passa por ele. */
  bot: BotAdminApi;
  /** E-mail de quem passou pelo Cloudflare Access; null se não passou. */
  identify(c: Context): Promise<string | null>;
  /** Só estes e-mails entram, mesmo que a política do Access deixe mais gente. */
  allowedEmails: readonly string[];
  clock: Clock;
  logger: Logger;
  /** Preço estimado de uma mensagem cobrada pela Meta, em milésimos de real. */
  metaPriceBrlMilli: number;
}

export interface AdminVars {
  deps: AdminDeps;
  email: string;
}

export type AdminApp = Hono<{ Variables: AdminVars }>;
export type AdminContext = Context<{ Variables: AdminVars }>;

/** Corpo do formulário (só texto; campos repetidos viram lista). */
export async function formValues(c: AdminContext): Promise<FormValues> {
  const body = await c.req.parseBody({ all: true });
  const out: FormValues = {};
  for (const [key, v] of Object.entries(body)) {
    if (typeof v === 'string') out[key] = v;
    else if (Array.isArray(v)) out[key] = v.filter((x): x is string => typeof x === 'string');
  }
  return out;
}

export function pageProps(c: AdminContext, title: string, extra: Partial<PageProps> = {}): PageProps {
  return { title, email: c.get('email'), flash: flashFrom(c.req.query('ok')), ...extra };
}

export function tenantPage(
  c: AdminContext,
  tenant: Pick<TenantSettings, 'id' | 'name'>,
  tab: TenantTab,
  title: string,
  flash?: Flash | null,
): PageProps {
  return pageProps(c, title, { tenant: { id: tenant.id, name: tenant.name }, tab, ...(flash !== undefined ? { flash } : {}) });
}

/** IDs do painel são ULID (ou os fixos do seed): letras e números. */
export const ID_RE = /^[0-9A-Za-z]{10,40}$/;

export async function loadTenant(c: AdminContext): Promise<TenantSettings | null> {
  const id = c.req.param('id') ?? '';
  if (!ID_RE.test(id)) return null;
  return c.get('deps').repo.forTenant(id).getTenant();
}
