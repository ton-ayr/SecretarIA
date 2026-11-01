import { formValues, tenantPage, type AdminApp } from '../context.ts';
import { first } from '../forms.ts';
import { render } from '../views/layout.tsx';
import { ChatError, ChatTurn, TestChatPage } from '../views/test-chat.tsx';
import { withTenant } from './tenant.tsx';

export function registerTestChat(app: AdminApp): void {
  app.get(
    '/empresas/:id/testar',
    withTenant(async (c, tenant) => {
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const [conv, overview] = await Promise.all([repo.testConversation(), repo.overview()]);
      return render(
        c,
        <TestChatPage
          page={tenantPage(c, tenant, 'test', 'Testar atendente')}
          tenantId={tenant.id}
          timezone={tenant.timezone}
          messages={conv?.messages ?? []}
          ready={{ services: overview.services, hours: overview.hours }}
        />,
      );
    }),
  );

  app.post(
    '/empresas/:id/testar',
    withTenant(async (c, tenant) => {
      const { bot, logger } = c.get('deps');
      const values = await formValues(c);
      const replyId = first(values, 'replyId');
      const input = replyId ? { replyId: replyId.slice(0, 200), title: first(values, 'title').slice(0, 100) } : { text: first(values, 'text').slice(0, 1000) };
      const viaHtmx = c.req.header('hx-request') === 'true';
      try {
        const result = await bot.testTurn(tenant.id, input);
        // Sem JavaScript: volta para a página inteira (o histórico vem do banco).
        if (!viaHtmx) return c.redirect(`/empresas/${tenant.id}/testar`, 303);
        return c.html(<ChatTurn tenantId={tenant.id} sent={'title' in input ? input.title || 'opção' : input.text} result={result} />);
      } catch (err) {
        logger.error('admin_test_turn_failed', { tenant_id: tenant.id, error_code: err instanceof Error ? err.name : 'unknown' });
        if (!viaHtmx) return c.redirect(`/empresas/${tenant.id}/testar`, 303);
        return c.html(<ChatError tenantId={tenant.id} />);
      }
    }),
  );

  app.post(
    '/empresas/:id/testar/limpar',
    withTenant(async (c, tenant) => {
      await c.get('deps').bot.resetTest(tenant.id);
      return c.redirect(`/empresas/${tenant.id}/testar?ok=test-cleared`, 303);
    }),
  );
}
