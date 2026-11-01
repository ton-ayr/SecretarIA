import { monthKey } from '../../shared/time.ts';
import { ID_RE, formValues, tenantPage, type AdminApp } from '../context.ts';
import { first } from '../forms.ts';
import { ConversationPage, ConversationsPage, UsagePage } from '../views/conversations.tsx';
import { render } from '../views/layout.tsx';
import { withTenant } from './tenant.tsx';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function registerConversations(app: AdminApp): void {
  app.get(
    '/empresas/:id/conversas',
    withTenant(async (c, tenant) => {
      const { repo, clock } = c.get('deps');
      const since = new Date(clock.now().getTime() - WEEK_MS).toISOString();
      const items = await repo.forTenant(tenant.id).listConversations(since);
      return render(
        c,
        <ConversationsPage page={tenantPage(c, tenant, 'conversations', 'Conversas')} tenantId={tenant.id} timezone={tenant.timezone} items={items} />,
      );
    }),
  );

  app.get(
    '/empresas/:id/conversas/:cid',
    withTenant(async (c, tenant) => {
      const cid = c.req.param('cid') ?? '';
      if (!ID_RE.test(cid)) return c.notFound();
      const conv = await c.get('deps').repo.forTenant(tenant.id).getConversation(cid);
      if (!conv) return c.notFound();
      return render(
        c,
        <ConversationPage
          page={tenantPage(c, tenant, 'conversations', conv.summary.contactName ?? 'Conversa')}
          tenantId={tenant.id}
          timezone={tenant.timezone}
          summary={conv.summary}
          messages={conv.messages}
        />,
      );
    }),
  );

  app.post(
    '/empresas/:id/conversas/:cid/reativar',
    withTenant(async (c, tenant) => {
      const cid = c.req.param('cid') ?? '';
      if (!ID_RE.test(cid)) return c.notFound();
      // A conversa precisa ser desta empresa (o bot confere de novo).
      if (!(await c.get('deps').repo.forTenant(tenant.id).getConversation(cid))) return c.notFound();
      await c.get('deps').bot.resumeConversation(tenant.id, cid);
      return c.redirect(`/empresas/${tenant.id}/conversas/${cid}?ok=resumed`, 303);
    }),
  );

  app.post(
    '/empresas/:id/conversas/:cid/apagar',
    withTenant(async (c, tenant) => {
      const cid = c.req.param('cid') ?? '';
      if (!ID_RE.test(cid)) return c.notFound();
      const { repo, bot, logger } = c.get('deps');
      const conv = await repo.forTenant(tenant.id).getConversation(cid);
      if (!conv) return c.notFound();
      if (first(await formValues(c), 'confirm') !== '1') return c.redirect(`/empresas/${tenant.id}/conversas/${cid}`, 303);
      // O telefone vem do banco, nunca do formulário.
      const report = await bot.eraseContact(tenant.id, conv.summary.waId);
      logger.info('admin_contact_erased', { tenant_id: tenant.id, conversations: report.conversations, messages: report.messages });
      return c.redirect(`/empresas/${tenant.id}/conversas?ok=erased`, 303);
    }),
  );

  app.get(
    '/empresas/:id/medidor',
    withTenant(async (c, tenant) => {
      const { repo, clock, metaPriceBrlMilli } = c.get('deps');
      const now = clock.now();
      // Este mês e os dois anteriores.
      const from = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)));
      const rows = await repo.forTenant(tenant.id).listUsage(from);
      return render(c, <UsagePage page={tenantPage(c, tenant, 'usage', 'Medidor')} rows={rows} metaPriceBrlMilli={metaPriceBrlMilli} />);
    }),
  );
}
