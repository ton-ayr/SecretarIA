import { dayKey, monthKey } from '../../shared/time.ts';
import { formValues, pageProps, type AdminApp } from '../context.ts';
import { parseMetaAccount, parseNewTenant } from '../forms.ts';
import { HomePage, MetaAccountsPage, NewTenantPage } from '../views/home.tsx';
import { render } from '../views/layout.tsx';

export function registerHome(app: AdminApp): void {
  app.get('/', async (c) => {
    const { repo, clock, metaPriceBrlMilli } = c.get('deps');
    const now = clock.now();
    const month = monthKey(now);
    const [tenants, usage, llm] = await Promise.all([repo.ops.listTenants(), repo.ops.listUsage(month), repo.ops.llmUsage(dayKey(now))]);
    return render(
      c,
      <HomePage page={pageProps(c, 'Empresas')} tenants={tenants} usage={usage} llm={llm} month={month} metaPriceBrlMilli={metaPriceBrlMilli} />,
    );
  });

  app.get('/empresas/nova', (c) =>
    render(c, <NewTenantPage page={pageProps(c, 'Nova empresa')} values={{ segment: 'general', timezone: 'America/Sao_Paulo' }} />),
  );

  app.post('/empresas', async (c) => {
    const { repo, clock, logger } = c.get('deps');
    const values = await formValues(c);
    const parsed = parseNewTenant(values);
    if ('errors' in parsed) {
      return render(c, <NewTenantPage page={pageProps(c, 'Nova empresa')} values={values} errors={parsed.errors} />, 422);
    }
    const id = await repo.ops.createTenant(parsed.ok, clock.now().toISOString());
    logger.info('admin_tenant_created', { tenant_id: id });
    return c.redirect(`/empresas/${id}?ok=created`, 303);
  });

  app.get('/meta', async (c) => {
    const accounts = await c.get('deps').repo.ops.listMetaAccounts();
    return render(c, <MetaAccountsPage page={pageProps(c, 'Contas Meta')} accounts={accounts} values={{}} />);
  });

  app.post('/meta', async (c) => {
    const { repo, bot, logger } = c.get('deps');
    const values = await formValues(c);
    const parsed = parseMetaAccount(values);
    if ('errors' in parsed) {
      const accounts = await repo.ops.listMetaAccounts();
      return render(c, <MetaAccountsPage page={pageProps(c, 'Contas Meta')} accounts={accounts} values={values} errors={parsed.errors} />, 422);
    }
    try {
      await bot.saveMetaAccount(parsed.ok.wabaId, parsed.ok.token);
    } catch (err) {
      logger.error('admin_meta_save_failed', { error_code: err instanceof Error ? err.name : 'unknown' });
      const accounts = await repo.ops.listMetaAccounts();
      return render(
        c,
        <MetaAccountsPage
          page={pageProps(c, 'Contas Meta', { flash: { kind: 'error', text: 'Não consegui gravar o token. Confira e tente de novo.' } })}
          accounts={accounts}
          values={{ wabaId: parsed.ok.wabaId }}
        />,
        500,
      );
    }
    return c.redirect('/meta?ok=token-saved', 303);
  });
}
