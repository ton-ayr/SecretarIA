import { DEFAULT_RULES } from '../../core/availability.ts';
import type { TenantSettings } from '../../ports/admin.ts';
import type { MetaNumber } from '../../ports/bot-admin.ts';
import type { SchedulingRules } from '../../ports/scheduling.ts';
import { randomToken } from '../../shared/crypto.ts';
import { ID_RE, formValues, tenantPage, type AdminContext, type AdminApp } from '../context.ts';
import { first, parseCalendarId, parseChannelLabel, parsePhone, parseRules, type FormValues } from '../forms.ts';
import { CalendarCheckResult, CalendarPage, TeamPage, WhatsAppPage } from '../views/channels.tsx';
import { render } from '../views/layout.tsx';
import { withTenant } from './tenant.tsx';

const LINK_TTL_MS = 24 * 60 * 60 * 1000;

function rulesValues(r: SchedulingRules): FormValues {
  return {
    slotStepMin: String(r.slotStepMin),
    minAdvanceMin: String(r.minAdvanceMin),
    maxDaysAhead: String(r.maxDaysAhead),
    maxOptions: String(r.maxOptions),
  };
}

async function calendarPage(
  c: AdminContext,
  tenant: TenantSettings,
  opts: { rules?: FormValues; errors?: Record<string, string>; calendar?: FormValues; calendarErrors?: Record<string, string> } = {},
  status: 200 | 422 = 200,
) {
  const { repo, bot } = c.get('deps');
  const [rules, serviceAccount] = await Promise.all([repo.forTenant(tenant.id).getRules(), bot.googleServiceAccount().catch(() => null)]);
  return render(
    c,
    <CalendarPage
      page={tenantPage(c, tenant, 'calendar', 'Agenda')}
      tenantId={tenant.id}
      rules={opts.rules ?? rulesValues(rules ?? DEFAULT_RULES)}
      calendar={opts.calendar ?? { calendarId: tenant.googleCalendarId ?? '' }}
      serviceAccount={serviceAccount}
      errors={opts.errors}
      calendarErrors={opts.calendarErrors}
    />,
    status,
  );
}

async function whatsappPage(
  c: AdminContext,
  tenant: TenantSettings,
  opts: { accountId?: string | undefined; values?: FormValues; errors?: Record<string, string> } = {},
  status: 200 | 422 | 409 = 200,
) {
  const { repo, bot } = c.get('deps');
  const [phones, accounts] = await Promise.all([repo.forTenant(tenant.id).listPhones(), repo.ops.listMetaAccounts()]);
  const selectedAccount = opts.accountId ? (accounts.find((a) => a.id === opts.accountId && a.hasToken) ?? null) : null;
  let numbers: MetaNumber[] | null = null;
  let lookupError: string | null = null;
  if (selectedAccount) {
    const r = await bot.listMetaNumbers(selectedAccount.id).catch(() => ({ error: 'Não consegui falar com o bot.' }));
    if ('numbers' in r) numbers = r.numbers;
    else lookupError = r.error;
  }
  return render(
    c,
    <WhatsAppPage
      page={tenantPage(c, tenant, 'whatsapp', 'WhatsApp')}
      tenantId={tenant.id}
      phones={phones}
      accounts={accounts}
      selectedAccount={selectedAccount}
      numbers={numbers}
      lookupError={lookupError}
      values={opts.values ?? {}}
      errors={opts.errors}
    />,
    status,
  );
}

async function teamPage(
  c: AdminContext,
  tenant: TenantSettings,
  opts: { newLink?: string | null; values?: FormValues; errors?: Record<string, string> } = {},
  status: 200 | 422 = 200,
) {
  const { repo, bot, clock } = c.get('deps');
  const [channels, username] = await Promise.all([repo.forTenant(tenant.id).listChannels(), bot.telegramBotUsername().catch(() => null)]);
  return render(
    c,
    <TeamPage
      page={tenantPage(c, tenant, 'team', 'Equipe')}
      tenantId={tenant.id}
      timezone={tenant.timezone}
      now={clock.now().toISOString()}
      channels={channels}
      newLink={opts.newLink ?? null}
      botMissing={!username}
      values={opts.values ?? {}}
      errors={opts.errors}
    />,
    status,
  );
}

export function registerChannels(app: AdminApp): void {
  // ---------------------------------------------------- agenda e Google
  app.get('/empresas/:id/agenda', withTenant((c, tenant) => calendarPage(c, tenant)));

  app.post(
    '/empresas/:id/agenda',
    withTenant(async (c, tenant) => {
      const values = await formValues(c);
      const parsed = parseRules(values);
      if ('errors' in parsed) return calendarPage(c, tenant, { rules: values, errors: parsed.errors }, 422);
      await c.get('deps').repo.forTenant(tenant.id).saveRules(parsed.ok);
      return c.redirect(`/empresas/${tenant.id}/agenda?ok=saved`, 303);
    }),
  );

  app.post(
    '/empresas/:id/agenda/google',
    withTenant(async (c, tenant) => {
      const { repo, bot, logger } = c.get('deps');
      const values = await formValues(c);
      const parsed = parseCalendarId(values);
      if ('errors' in parsed) return calendarPage(c, tenant, { calendar: values, calendarErrors: parsed.errors }, 422);
      if (parsed.ok) {
        // Só liga se o bot conseguir ler e escrever (senão as marcações falhariam em silêncio).
        const check = await bot.checkCalendar(parsed.ok);
        if (check.problem) return calendarPage(c, tenant, { calendar: values, calendarErrors: { calendarId: check.problem } }, 422);
      }
      await repo.forTenant(tenant.id).setGoogleCalendar(parsed.ok);
      logger.info('admin_calendar_set', { tenant_id: tenant.id, connected: Boolean(parsed.ok) });
      return c.redirect(`/empresas/${tenant.id}/agenda?ok=saved`, 303);
    }),
  );

  // Fragmento para o htmx (botão "Testar").
  app.post(
    '/empresas/:id/agenda/testar',
    withTenant(async (c) => {
      const parsed = parseCalendarId(await formValues(c));
      if ('errors' in parsed) return c.html(<span class="pending">✗ {parsed.errors.calendarId}</span>);
      if (!parsed.ok) return c.html(<span class="pending">Informe o ID da agenda.</span>);
      return c.html(<CalendarCheckResult check={await c.get('deps').bot.checkCalendar(parsed.ok)} />);
    }),
  );

  // ------------------------------------------------------------ WhatsApp
  app.get('/empresas/:id/whatsapp', withTenant((c, tenant) => whatsappPage(c, tenant, { accountId: c.req.query('conta') })));

  app.post(
    '/empresas/:id/whatsapp',
    withTenant(async (c, tenant) => {
      const { repo, bot, clock, logger } = c.get('deps');
      const values = await formValues(c);
      const accounts = await repo.ops.listMetaAccounts();
      const accountId = first(values, 'metaAccountId');
      let phone: { metaAccountId: string; metaPhoneNumberId: string; displayPhone: string };
      if (first(values, 'manual') === '1') {
        const parsed = parsePhone(values, new Set(accounts.map((a) => a.id)));
        if ('errors' in parsed) return whatsappPage(c, tenant, { accountId, values, errors: parsed.errors }, 422);
        phone = parsed.ok;
      } else {
        // Confere na Meta que o número é mesmo da conta e pega o número formatado.
        const chosen = first(values, 'metaPhoneNumberId');
        const r = accounts.some((a) => a.id === accountId) ? await bot.listMetaNumbers(accountId) : { error: 'Conta Meta inválida.' };
        const number = 'numbers' in r ? r.numbers.find((n) => n.id === chosen) : undefined;
        if (!number) {
          return whatsappPage(c, tenant, { accountId, values, errors: { metaPhoneNumberId: 'Escolha um número da lista.' } }, 422);
        }
        phone = { metaAccountId: accountId, metaPhoneNumberId: number.id, displayPhone: number.displayPhoneNumber };
      }
      if (!(await repo.forTenant(tenant.id).addPhone(phone, clock.now().toISOString()))) {
        return whatsappPage(
          c,
          tenant,
          { accountId, values, errors: { metaPhoneNumberId: 'Esse número já está ligado a uma empresa.' } },
          409,
        );
      }
      logger.info('admin_phone_added', { tenant_id: tenant.id });
      return c.redirect(`/empresas/${tenant.id}/whatsapp?ok=phone-added`, 303);
    }),
  );

  app.post(
    '/empresas/:id/whatsapp/:pid/status',
    withTenant(async (c, tenant) => {
      const pid = c.req.param('pid') ?? '';
      if (!ID_RE.test(pid)) return c.notFound();
      const status = first(await formValues(c), 'status') === 'disabled' ? 'disabled' : 'active';
      await c.get('deps').repo.forTenant(tenant.id).setPhoneStatus(pid, status);
      return c.redirect(`/empresas/${tenant.id}/whatsapp?ok=saved`, 303);
    }),
  );

  // ------------------------------------------------------- equipe (Telegram)
  app.get('/empresas/:id/equipe', withTenant((c, tenant) => teamPage(c, tenant)));

  app.post(
    '/empresas/:id/equipe',
    withTenant(async (c, tenant) => {
      const { repo, bot, clock, logger } = c.get('deps');
      const values = await formValues(c);
      const parsed = parseChannelLabel(values);
      if ('errors' in parsed) return teamPage(c, tenant, { values, errors: parsed.errors }, 422);
      const username = await bot.telegramBotUsername().catch(() => null);
      if (!username) return teamPage(c, tenant, { values }, 422);
      const now = clock.now();
      const code = randomToken(32);
      await repo.forTenant(tenant.id).createChannelLink(parsed.ok, code, new Date(now.getTime() + LINK_TTL_MS).toISOString(), now.toISOString());
      logger.info('admin_channel_link_created', { tenant_id: tenant.id });
      // Mostra o link uma vez, nesta resposta (sem redirecionar).
      return teamPage(c, tenant, { newLink: `https://t.me/${username}?start=${code}` });
    }),
  );

  app.post(
    '/empresas/:id/equipe/:cid/remover',
    withTenant(async (c, tenant) => {
      const cid = c.req.param('cid') ?? '';
      if (!ID_RE.test(cid)) return c.notFound();
      await c.get('deps').repo.forTenant(tenant.id).removeChannel(cid);
      return c.redirect(`/empresas/${tenant.id}/equipe?ok=removed`, 303);
    }),
  );
}
