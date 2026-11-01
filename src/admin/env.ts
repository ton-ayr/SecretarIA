import type { BotAdminApi } from '../ports/bot-admin.ts';

/** Bindings e variáveis do Worker "admin" (wrangler.admin.jsonc). Não há segredos de integração aqui. */
export interface AdminEnv {
  DB: D1Database;
  /** Service binding para o named entrypoint AdminRpc do Worker "bot". */
  BOT: BotAdminApi;
  /** E-mails que podem entrar, separados por vírgula (wrangler secret, fora do git). */
  ADMIN_EMAILS?: string;
  /** Preço estimado de uma mensagem cobrada pela Meta, em milésimos de real (35 = R$ 0,035). */
  META_PRICE_BRL_MILLI?: string;
  /** Domínio da equipe do Zero Trust (ex.: minha-equipe.cloudflareaccess.com). */
  ACCESS_TEAM_DOMAIN?: string;
  /** Tag AUD da aplicação do Access que protege este Worker. */
  ACCESS_AUD?: string;
}
