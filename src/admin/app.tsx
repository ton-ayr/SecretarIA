import { Hono } from 'hono';
import type { AdminDeps, AdminVars } from './context.ts';
import { registerCatalog } from './routes/catalog.tsx';
import { registerChannels } from './routes/channels.tsx';
import { registerConversations } from './routes/conversations.tsx';
import { registerHome } from './routes/home.tsx';
import { registerTenant } from './routes/tenant.tsx';
import { registerTestChat } from './routes/test-chat.tsx';
import { Layout, render } from './views/layout.tsx';

/**
 * Painel do operador (Worker "admin"). Camadas de proteção:
 * 1. Cloudflare Access na frente do Worker (login por e-mail);
 * 2. aqui: identidade do Access + lista de e-mails permitidos (ADMIN_EMAILS);
 * 3. todo POST confere o cabeçalho Origin (contra CSRF);
 * 4. CSP sem script de fora, sem iframe e sem cache.
 */

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'private, no-store',
};

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function createAdminApp<E extends object>(getDeps: (env: E) => AdminDeps) {
  const app = new Hono<{ Bindings: E; Variables: AdminVars }>();

  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(k, v);
  });

  app.use('*', async (c, next) => {
    const deps = getDeps(c.env);
    const email = (await deps.identify(c))?.trim().toLowerCase() ?? null;
    if (!email || !deps.allowedEmails.includes(email)) {
      // Sem e-mail no log (dado pessoal): só o motivo.
      deps.logger.warn('admin_forbidden', { reason: email ? 'not_allowed' : 'no_access' });
      // Quem vê esta resposta já passou pelo Access: mostrar o próprio e-mail ajuda a configurar.
      return c.text(
        email
          ? `Acesso negado: ${email} não está na lista de e-mails do painel (ADMIN_EMAILS).`
          : 'Acesso negado: o pedido não chegou pelo Cloudflare Access (sem identidade).',
        403,
      );
    }
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (!origin || origin !== new URL(c.req.url).origin) {
        deps.logger.warn('admin_csrf_blocked', { method: c.req.method });
        return c.text('Pedido recusado: origem diferente do painel.', 403);
      }
    }
    c.set('deps', deps);
    c.set('email', email);
    await next();
  });

  // As rotas usam só Variables; o tipo das Bindings não importa para elas.
  const routes = app as unknown as Parameters<typeof registerHome>[0];
  registerHome(routes);
  registerTenant(routes);
  registerCatalog(routes);
  registerChannels(routes);
  registerConversations(routes);
  registerTestChat(routes);

  app.notFound((c) =>
    render(
      c,
      <Layout title="Não encontrado" email={c.get('email') ?? ''}>
        <h1>Não encontrado</h1>
        <p>
          <a href="/">Voltar às empresas</a>
        </p>
      </Layout>,
      404,
    ),
  );

  app.onError((err, c) => {
    c.get('deps')?.logger.error('admin_error', { error_code: err instanceof Error ? err.name : 'unknown' });
    return render(
      c,
      <Layout title="Erro" email={c.get('email') ?? ''}>
        <h1>Algo deu errado</h1>
        <p>Não consegui concluir. Tente de novo; se continuar, veja os logs do Worker.</p>
        <p>
          <a href="/">Voltar às empresas</a>
        </p>
      </Layout>,
      500,
    );
  });

  return app;
}
