import { ID_RE, formValues, tenantPage, type AdminApp } from '../context.ts';
import { parseCalendarId, parseProfessional, parseService, parseTimeOff, parseWeekHours, type FormValues } from '../forms.ts';
import {
  HoursPage,
  ProfessionalEditPage,
  ProfessionalsPage,
  ServiceEditPage,
  ServicesPage,
  TimeOffPage,
  professionalValues,
  serviceValues,
  weekValues,
} from '../views/catalog.tsx';
import { render } from '../views/layout.tsx';
import { withTenant } from './tenant.tsx';

const NEW_SERVICE: FormValues = { durationMin: '30', bufferMin: '0', priceMode: 'fixed', active: '1' };
const NEW_PROFESSIONAL: FormValues = { active: '1' };

export function registerCatalog(app: AdminApp): void {
  // ------------------------------------------------------------ serviços
  app.get(
    '/empresas/:id/servicos',
    withTenant(async (c, tenant) => {
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const [services, professionals] = await Promise.all([repo.listServices(), repo.listProfessionals()]);
      return render(
        c,
        <ServicesPage
          page={tenantPage(c, tenant, 'services', 'Serviços')}
          tenantId={tenant.id}
          services={services}
          professionals={professionals}
          values={NEW_SERVICE}
        />,
      );
    }),
  );

  app.post(
    '/empresas/:id/servicos',
    withTenant(async (c, tenant) => {
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const [services, professionals] = await Promise.all([repo.listServices(), repo.listProfessionals()]);
      const values = await formValues(c);
      const parsed = parseService(values, new Set(professionals.map((p) => p.id)));
      if ('errors' in parsed) {
        return render(
          c,
          <ServicesPage
            page={tenantPage(c, tenant, 'services', 'Serviços')}
            tenantId={tenant.id}
            services={services}
            professionals={professionals}
            values={values}
            errors={parsed.errors}
          />,
          422,
        );
      }
      await repo.saveService(null, parsed.ok);
      return c.redirect(`/empresas/${tenant.id}/servicos?ok=saved`, 303);
    }),
  );

  app.get(
    '/empresas/:id/servicos/:sid',
    withTenant(async (c, tenant) => {
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const [services, professionals] = await Promise.all([repo.listServices(), repo.listProfessionals()]);
      const service = services.find((s) => s.id === c.req.param('sid'));
      if (!service) return c.notFound();
      return render(
        c,
        <ServiceEditPage
          page={tenantPage(c, tenant, 'services', service.name)}
          tenantId={tenant.id}
          serviceId={service.id}
          professionals={professionals}
          values={serviceValues(service)}
        />,
      );
    }),
  );

  app.post(
    '/empresas/:id/servicos/:sid',
    withTenant(async (c, tenant) => {
      const sid = c.req.param('sid') ?? '';
      if (!ID_RE.test(sid)) return c.notFound();
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const professionals = await repo.listProfessionals();
      const values = await formValues(c);
      const parsed = parseService(values, new Set(professionals.map((p) => p.id)));
      if ('errors' in parsed) {
        return render(
          c,
          <ServiceEditPage
            page={tenantPage(c, tenant, 'services', 'Serviço')}
            tenantId={tenant.id}
            serviceId={sid}
            professionals={professionals}
            values={values}
            errors={parsed.errors}
          />,
          422,
        );
      }
      if (!(await repo.saveService(sid, parsed.ok))) return c.notFound();
      return c.redirect(`/empresas/${tenant.id}/servicos?ok=saved`, 303);
    }),
  );

  // ------------------------------------------------------- profissionais
  app.get(
    '/empresas/:id/profissionais',
    withTenant(async (c, tenant) => {
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const [professionals, services] = await Promise.all([repo.listProfessionals(), repo.listServices()]);
      return render(
        c,
        <ProfessionalsPage
          page={tenantPage(c, tenant, 'professionals', 'Profissionais')}
          tenantId={tenant.id}
          professionals={professionals}
          services={services}
          values={NEW_PROFESSIONAL}
        />,
      );
    }),
  );

  app.post(
    '/empresas/:id/profissionais',
    withTenant(async (c, tenant) => {
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const values = await formValues(c);
      const parsed = parseProfessional(values);
      if ('errors' in parsed) {
        const [professionals, services] = await Promise.all([repo.listProfessionals(), repo.listServices()]);
        return render(
          c,
          <ProfessionalsPage
            page={tenantPage(c, tenant, 'professionals', 'Profissionais')}
            tenantId={tenant.id}
            professionals={professionals}
            services={services}
            values={values}
            errors={parsed.errors}
          />,
          422,
        );
      }
      await repo.saveProfessional(null, parsed.ok);
      return c.redirect(`/empresas/${tenant.id}/profissionais?ok=saved`, 303);
    }),
  );

  app.get(
    '/empresas/:id/profissionais/:pid',
    withTenant(async (c, tenant) => {
      const professional = (await c.get('deps').repo.forTenant(tenant.id).listProfessionals()).find((p) => p.id === c.req.param('pid'));
      if (!professional) return c.notFound();
      return render(
        c,
        <ProfessionalEditPage
          page={tenantPage(c, tenant, 'professionals', professional.name)}
          tenantId={tenant.id}
          professionalId={professional.id}
          values={professionalValues(professional)}
        />,
      );
    }),
  );

  app.post(
    '/empresas/:id/profissionais/:pid',
    withTenant(async (c, tenant) => {
      const pid = c.req.param('pid') ?? '';
      if (!ID_RE.test(pid)) return c.notFound();
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const values = await formValues(c);
      const parsed = parseProfessional(values);
      const calendar = parseCalendarId(values);
      if ('errors' in parsed || 'errors' in calendar) {
        const errors = { ...('errors' in parsed ? parsed.errors : {}), ...('errors' in calendar ? calendar.errors : {}) };
        return render(
          c,
          <ProfessionalEditPage
            page={tenantPage(c, tenant, 'professionals', 'Profissional')}
            tenantId={tenant.id}
            professionalId={pid}
            values={values}
            errors={errors}
          />,
          422,
        );
      }
      if (!(await repo.saveProfessional(pid, parsed.ok))) return c.notFound();
      await repo.setProfessionalCalendar(pid, calendar.ok);
      return c.redirect(`/empresas/${tenant.id}/profissionais?ok=saved`, 303);
    }),
  );

  // ------------------------------------------------------------- horários
  app.get(
    '/empresas/:id/horarios',
    withTenant(async (c, tenant) => {
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const [professionals, hours] = await Promise.all([repo.listProfessionals(), repo.listHours()]);
      const pid = c.req.query('p');
      const selected = pid ? (professionals.find((p) => p.id === pid) ?? null) : null;
      if (pid && !selected) return c.notFound();
      return render(
        c,
        <HoursPage
          page={tenantPage(c, tenant, 'hours', 'Horários')}
          tenantId={tenant.id}
          professionals={professionals}
          selected={selected}
          values={weekValues(hours, selected?.id ?? null)}
        />,
      );
    }),
  );

  app.post(
    '/empresas/:id/horarios',
    withTenant(async (c, tenant) => {
      const repo = c.get('deps').repo.forTenant(tenant.id);
      const values = await formValues(c);
      const pid = typeof values.professionalId === 'string' && values.professionalId ? values.professionalId : null;
      const professionals = await repo.listProfessionals();
      const selected = pid ? (professionals.find((p) => p.id === pid) ?? null) : null;
      if (pid && !selected) return c.notFound();
      const parsed = parseWeekHours(values);
      if ('errors' in parsed) {
        return render(
          c,
          <HoursPage
            page={tenantPage(c, tenant, 'hours', 'Horários')}
            tenantId={tenant.id}
            professionals={professionals}
            selected={selected}
            values={values}
            errors={parsed.errors}
          />,
          422,
        );
      }
      await repo.replaceHours(selected?.id ?? null, parsed.ok);
      return c.redirect(`/empresas/${tenant.id}/horarios${selected ? `?p=${selected.id}&ok=saved` : '?ok=saved'}`, 303);
    }),
  );

  // --------------------------------------------------------------- folgas
  app.get(
    '/empresas/:id/folgas',
    withTenant(async (c, tenant) => {
      const { repo, clock } = c.get('deps');
      const t = repo.forTenant(tenant.id);
      const [items, professionals] = await Promise.all([t.listTimeOff(clock.now().toISOString()), t.listProfessionals()]);
      return render(
        c,
        <TimeOffPage
          page={tenantPage(c, tenant, 'timeoff', 'Folgas')}
          tenantId={tenant.id}
          timezone={tenant.timezone}
          items={items}
          professionals={professionals}
          values={{}}
        />,
      );
    }),
  );

  app.post(
    '/empresas/:id/folgas',
    withTenant(async (c, tenant) => {
      const { repo, clock } = c.get('deps');
      const t = repo.forTenant(tenant.id);
      const professionals = await t.listProfessionals();
      const values = await formValues(c);
      const parsed = parseTimeOff(values, tenant.timezone, new Set(professionals.map((p) => p.id)));
      if ('errors' in parsed) {
        const items = await t.listTimeOff(clock.now().toISOString());
        return render(
          c,
          <TimeOffPage
            page={tenantPage(c, tenant, 'timeoff', 'Folgas')}
            tenantId={tenant.id}
            timezone={tenant.timezone}
            items={items}
            professionals={professionals}
            values={values}
            errors={parsed.errors}
          />,
          422,
        );
      }
      await t.addTimeOff(parsed.ok);
      return c.redirect(`/empresas/${tenant.id}/folgas?ok=saved`, 303);
    }),
  );

  app.post(
    '/empresas/:id/folgas/:fid/apagar',
    withTenant(async (c, tenant) => {
      const fid = c.req.param('fid') ?? '';
      if (!ID_RE.test(fid)) return c.notFound();
      await c.get('deps').repo.forTenant(tenant.id).deleteTimeOff(fid);
      return c.redirect(`/empresas/${tenant.id}/folgas?ok=removed`, 303);
    }),
  );
}
