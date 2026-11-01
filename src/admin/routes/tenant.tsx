import type { AgentSettings, TenantSettings } from '../../ports/admin.ts';
import { formValues, loadTenant, tenantPage, type AdminApp, type AdminContext } from '../context.ts';
import { parseAgent, parseTenantSettings, type FormValues } from '../forms.ts';
import { render } from '../views/layout.tsx';
import { AgentPage, OverviewPage, SettingsPage, setupSteps } from '../views/tenant.tsx';

function settingsValues(t: TenantSettings): FormValues {
  return {
    name: t.name,
    segment: t.segment,
    timezone: t.timezone,
    address: t.address ?? '',
    status: t.status,
    remindersEnabled: t.remindersEnabled ? '1' : '',
    messageRetentionDays: String(t.messageRetentionDays),
    contactRetentionDays: String(t.contactRetentionDays),
  };
}

function agentValues(a: AgentSettings): FormValues {
  return {
    name: a.name,
    tone: a.tone,
    instructions: a.instructions,
    knowledgeBase: a.knowledgeBase,
    bookingTerm: a.bookingTerm,
    professionalTerm: a.professionalTerm,
    maxReplyChars: String(a.maxReplyChars),
    handoffResumeHours: String(a.handoffResumeHours),
  };
}

/** Rota de uma empresa: carrega a empresa ou responde 404. */
export function withTenant(handler: (c: AdminContext, tenant: TenantSettings) => Promise<Response> | Response) {
  return async (c: AdminContext) => {
    const tenant = await loadTenant(c);
    if (!tenant) return c.notFound();
    return handler(c, tenant);
  };
}

export function registerTenant(app: AdminApp): void {
  app.get(
    '/empresas/:id',
    withTenant(async (c, tenant) => {
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const [agent, overview] = await Promise.all([repo.getAgent(), repo.overview()]);
      return render(c, <OverviewPage page={tenantPage(c, tenant, 'overview', 'Visão geral')} tenant={tenant} steps={setupSteps(tenant, agent, overview)} />);
    }),
  );

  app.get(
    '/empresas/:id/dados',
    withTenant((c, tenant) =>
      render(c, <SettingsPage page={tenantPage(c, tenant, 'settings', 'Dados')} tenantId={tenant.id} values={settingsValues(tenant)} />),
    ),
  );

  app.post(
    '/empresas/:id/dados',
    withTenant(async (c, tenant) => {
      const values = await formValues(c);
      const parsed = parseTenantSettings(values);
      if ('errors' in parsed) {
        return render(
          c,
          <SettingsPage page={tenantPage(c, tenant, 'settings', 'Dados')} tenantId={tenant.id} values={values} errors={parsed.errors} />,
          422,
        );
      }
      await c.get('deps').repo.forTenant(tenant.id).updateTenant(parsed.ok);
      return c.redirect(`/empresas/${tenant.id}/dados?ok=saved`, 303);
    }),
  );

  app.get(
    '/empresas/:id/atendente',
    withTenant(async (c, tenant) => {
      const agent = await c.get('deps').repo.forTenant(tenant.id).getAgent();
      if (!agent) return c.notFound();
      return render(c, <AgentPage page={tenantPage(c, tenant, 'agent', 'Atendente')} tenantId={tenant.id} values={agentValues(agent)} />);
    }),
  );

  app.post(
    '/empresas/:id/atendente',
    withTenant(async (c, tenant) => {
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const agent = await repo.getAgent();
      if (!agent) return c.notFound();
      const values = await formValues(c);
      const parsed = parseAgent(values);
      if ('errors' in parsed) {
        return render(
          c,
          <AgentPage page={tenantPage(c, tenant, 'agent', 'Atendente')} tenantId={tenant.id} values={values} errors={parsed.errors} />,
          422,
        );
      }
      await repo.updateAgent(agent.id, parsed.ok);
      return c.redirect(`/empresas/${tenant.id}/atendente?ok=saved`, 303);
    }),
  );
}
