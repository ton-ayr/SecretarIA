import type { FC } from 'hono/jsx';
import type { HoursRow, ProfessionalRow, ServiceRow, TimeOffRow } from '../../ports/admin.ts';
import { formatServicePrice, professionalLabel } from '../../core/catalog.ts';
import type { FormValues } from '../forms.ts';
import { fmtDateTime, intervalsText, WEEKDAYS } from '../format.ts';
import { CheckField, Empty, FormErrors, Layout, SelectField, TextArea, TextField, value, type PageProps } from './layout.tsx';

export function centsToInput(cents: number | null): string {
  if (cents === null) return '';
  return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
}

export function serviceValues(s: ServiceRow): FormValues {
  return {
    name: s.name,
    description: s.description,
    durationMin: String(s.durationMin),
    bufferMin: String(s.bufferMin),
    priceMode: s.priceMode,
    price: centsToInput(s.priceCents),
    active: s.active ? '1' : '',
    professionalIds: s.professionalIds,
  };
}

const ServiceForm: FC<{
  action: string;
  values: FormValues;
  errors?: Record<string, string> | undefined;
  professionals: ProfessionalRow[];
  submit: string;
  /** Dentro de um <details> (sem moldura própria). */
  plain?: boolean;
}> = ({ action, values, errors, professionals, submit, plain }) => {
  const chosen = new Set(Array.isArray(values.professionalIds) ? values.professionalIds : values.professionalIds ? [values.professionalIds] : []);
  return (
    <form method="post" action={action} class={plain ? 'stack' : 'card stack'}>
      <FormErrors errors={errors} />
      <TextField name="name" label="Nome do serviço" values={values} errors={errors} required />
      <TextArea name="description" label="Descrição" hint="Opcional. O bot usa para explicar o serviço." rows={2} values={values} errors={errors} />
      <div class="row">
        <TextField name="durationMin" label="Duração (min)" values={values} errors={errors} inputmode="numeric" />
        <TextField
          name="bufferMin"
          label="Intervalo depois (min)"
          hint="Tempo para arrumar antes do próximo cliente."
          values={values}
          errors={errors}
          inputmode="numeric"
        />
      </div>
      <div class="row">
        <SelectField
          name="priceMode"
          label="Como mostrar o preço"
          values={values}
          errors={errors}
          options={[
            ['fixed', 'Valor fixo'],
            ['from', 'A partir de'],
            ['on_request', 'Sob consulta (o bot não fala valor)'],
          ]}
        />
        <TextField name="price" label="Preço (R$)" hint="Ex.: 45,00. Vazio só em “sob consulta”." values={values} errors={errors} inputmode="decimal" />
      </div>
      {professionals.length ? (
        <fieldset>
          <legend>Quem faz</legend>
          <span class="hint">Nenhum marcado = todos os profissionais fazem.</span>
          <div class="checks">
            {professionals
              .filter((p) => p.active)
              .map((p) => (
                <CheckField name="professionalIds" value={p.id} label={professionalLabel(p)} checked={chosen.has(p.id)} />
              ))}
          </div>
        </fieldset>
      ) : null}
      <CheckField name="active" label="Ativo (o bot oferece este serviço)" checked={value(values, 'active') === '1'} />
      <div class="form-foot">
        <button type="submit">{submit}</button>
      </div>
    </form>
  );
};

export const ServicesPage: FC<{
  page: PageProps;
  tenantId: string;
  services: ServiceRow[];
  professionals: ProfessionalRow[];
  values: FormValues;
  errors?: Record<string, string> | undefined;
}> = ({ page, tenantId, services, professionals, values, errors }) => {
  const byId = new Map(professionals.map((p) => [p.id, p]));
  return (
    <Layout {...page} intro="O que a empresa faz. O bot só oferece serviços ativos, com a duração e o preço daqui.">
      {services.length ? (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Serviço</th>
                <th class="num">Duração</th>
                <th>Preço</th>
                <th>Quem faz</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr>
                  <td>
                    <a href={`/empresas/${tenantId}/servicos/${s.id}`}>{s.name}</a>
                  </td>
                  <td class="num">
                    {s.durationMin} min{s.bufferMin ? ` + ${s.bufferMin}` : ''}
                  </td>
                  <td>{formatServicePrice(s)}</td>
                  <td>
                    {s.professionalIds.length
                      ? s.professionalIds.map((id) => (byId.get(id) ? professionalLabel(byId.get(id)!) : '?')).join(', ')
                      : 'Todos'}
                  </td>
                  <td>{s.active ? <span class="badge">ativo</span> : <span class="badge off">inativo</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Nenhum serviço ainda. Cadastre o primeiro abaixo.</Empty>
      )}
      <details class="card" open={!services.length || Boolean(errors)}>
        <summary>Novo serviço</summary>
        <ServiceForm
          action={`/empresas/${tenantId}/servicos`}
          values={values}
          errors={errors}
          professionals={professionals}
          submit="Adicionar serviço"
          plain
        />
      </details>
    </Layout>
  );
};

export const ServiceEditPage: FC<{
  page: PageProps;
  tenantId: string;
  serviceId: string;
  professionals: ProfessionalRow[];
  values: FormValues;
  errors?: Record<string, string> | undefined;
}> = ({ page, tenantId, serviceId, professionals, values, errors }) => (
  <Layout {...page}>
    <p class="small">
      <a href={`/empresas/${tenantId}/servicos`}>← Voltar para serviços</a>
    </p>
    <ServiceForm
      action={`/empresas/${tenantId}/servicos/${serviceId}`}
      values={values}
      errors={errors}
      professionals={professionals}
      submit="Salvar serviço"
    />
    <p class="small muted">Para tirar do ar, desmarque “Ativo”. O histórico de agendamentos continua.</p>
  </Layout>
);

export function professionalValues(p: ProfessionalRow): FormValues {
  return { name: p.name, title: p.title ?? '', active: p.active ? '1' : '', calendarId: p.googleCalendarId ?? '' };
}

const ProfessionalForm: FC<{
  action: string;
  tenantId: string;
  values: FormValues;
  errors?: Record<string, string> | undefined;
  submit: string;
  withCalendar: boolean;
  plain?: boolean;
}> = ({ action, tenantId, values, errors, submit, withCalendar, plain }) => (
  <form method="post" action={action} class={plain ? 'stack' : 'card stack'}>
    <FormErrors errors={errors} />
    <div class="row">
      <TextField name="name" label="Nome" values={values} errors={errors} required />
      <TextField name="title" label="Título" hint="Opcional: Barbeiro, Dra., Taróloga…" values={values} errors={errors} />
    </div>
    <CheckField name="active" label="Ativo (aparece nos horários)" checked={value(values, 'active') === '1'} />
    {withCalendar ? (
      <div>
        <TextField
          name="calendarId"
          label="Agenda Google própria (opcional)"
          hint="ID da agenda deste profissional. Vazio = usa a agenda da empresa."
          values={values}
          errors={errors}
        />
        <div class="actions">
          <button
            type="button"
            class="secondary"
            hx-post={`/empresas/${tenantId}/agenda/testar`}
            hx-include="[name='calendarId']"
            hx-target="#calendar-check"
          >
            Testar agenda
          </button>
          <span id="calendar-check" class="small"></span>
        </div>
      </div>
    ) : null}
    <div class="form-foot">
      <button type="submit">{submit}</button>
    </div>
  </form>
);

export const ProfessionalsPage: FC<{
  page: PageProps;
  tenantId: string;
  professionals: ProfessionalRow[];
  services: ServiceRow[];
  values: FormValues;
  errors?: Record<string, string> | undefined;
}> = ({ page, tenantId, professionals, services, values, errors }) => {
  const serviceName = new Map(services.map((s) => [s.id, s.name]));
  const doesAll = services.filter((s) => s.active && s.professionalIds.length === 0).map((s) => s.name);
  return (
    <Layout {...page} intro="Quem atende. “Quem faz” cada serviço se define na tela de Serviços.">
      {professionals.length ? (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Profissional</th>
                <th>Faz</th>
                <th>Agenda própria</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {professionals.map((p) => (
                <tr>
                  <td>
                    <a href={`/empresas/${tenantId}/profissionais/${p.id}`}>{professionalLabel(p)}</a>
                  </td>
                  <td>{[...p.serviceIds.map((id) => serviceName.get(id) ?? '?'), ...doesAll].join(', ') || '—'}</td>
                  <td>{p.googleCalendarId ? <span class="badge">sim</span> : <span class="muted">da empresa</span>}</td>
                  <td>{p.active ? <span class="badge">ativo</span> : <span class="badge off">inativo</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Nenhum profissional ainda. Se só o dono atende, cadastre só ele.</Empty>
      )}
      <details class="card" open={!professionals.length || Boolean(errors)}>
        <summary>Novo profissional</summary>
        <ProfessionalForm
          action={`/empresas/${tenantId}/profissionais`}
          tenantId={tenantId}
          values={values}
          errors={errors}
          submit="Adicionar profissional"
          withCalendar={false}
          plain
        />
      </details>
    </Layout>
  );
};

export const ProfessionalEditPage: FC<{
  page: PageProps;
  tenantId: string;
  professionalId: string;
  values: FormValues;
  errors?: Record<string, string> | undefined;
}> = ({ page, tenantId, professionalId, values, errors }) => (
  <Layout {...page}>
    <p class="small">
      <a href={`/empresas/${tenantId}/profissionais`}>← Voltar para profissionais</a> ·{' '}
      <a href={`/empresas/${tenantId}/horarios?p=${professionalId}`}>Horário próprio</a>
    </p>
    <ProfessionalForm
      action={`/empresas/${tenantId}/profissionais/${professionalId}`}
      tenantId={tenantId}
      values={values}
      errors={errors}
      submit="Salvar"
      withCalendar
    />
  </Layout>
);

export function weekValues(rows: HoursRow[], professionalId: string | null): FormValues {
  const values: FormValues = {};
  for (let d = 0; d <= 6; d++) {
    values[`d${d}`] = intervalsText(rows.filter((r) => r.professionalId === professionalId && r.weekday === d));
  }
  return values;
}

export const HoursPage: FC<{
  page: PageProps;
  tenantId: string;
  professionals: ProfessionalRow[];
  selected: ProfessionalRow | null;
  values: FormValues;
  errors?: Record<string, string> | undefined;
}> = ({ page, tenantId, professionals, selected, values, errors }) => (
  <Layout {...page} intro="Dias e horas de atendimento. Intervalos separados por vírgula; dia vazio = fechado.">
    <nav class="segmented" aria-label="De quem é o horário">
      <a href={`/empresas/${tenantId}/horarios`} aria-current={selected ? undefined : 'page'}>
        Empresa
      </a>
      {professionals
        .filter((p) => p.active)
        .map((p) => (
          <a href={`/empresas/${tenantId}/horarios?p=${p.id}`} aria-current={selected?.id === p.id ? 'page' : undefined}>
            {professionalLabel(p)}
          </a>
        ))}
    </nav>
    <p class="muted small">
      {selected
        ? `Horário próprio de ${professionalLabel(selected)}. Deixe tudo vazio para seguir o horário da empresa.`
        : 'Vale para todos os profissionais que não têm horário próprio.'}
    </p>
    <FormErrors errors={errors} />
    <form method="post" action={`/empresas/${tenantId}/horarios`} class="card">
      <input type="hidden" name="professionalId" value={selected?.id ?? ''} />
      <div class="hours-grid">
        {WEEKDAYS.map((day, d) => (
          <>
            <label for={`d${d}`}>{day}</label>
            <div>
              <input
                id={`d${d}`}
                name={`d${d}`}
                type="text"
                value={value(values, `d${d}`)}
                placeholder="Fechado"
                aria-invalid={errors?.[`d${d}`] ? 'true' : undefined}
              />
              {errors?.[`d${d}`] ? <div class="field-error">{errors[`d${d}`]}</div> : null}
            </div>
          </>
        ))}
      </div>
      <span class="hint">Ex.: 09:00-12:00, 13:00-18:00 (fecha no almoço). Também vale “9h às 18h”.</span>
      <div class="form-foot">
        <button type="submit">Salvar horário</button>
      </div>
    </form>
  </Layout>
);

export const TimeOffPage: FC<{
  page: PageProps;
  tenantId: string;
  timezone: string;
  items: TimeOffRow[];
  professionals: ProfessionalRow[];
  values: FormValues;
  errors?: Record<string, string> | undefined;
}> = ({ page, tenantId, timezone, items, professionals, values, errors }) => {
  const byId = new Map(professionals.map((p) => [p.id, p]));
  return (
    <Layout {...page} intro="Feriados, férias e bloqueios. Nesses períodos o bot não oferece horário.">
      {items.length ? (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Quem</th>
                <th>Início</th>
                <th>Fim</th>
                <th>Motivo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr>
                  <td>{t.professionalId ? (byId.get(t.professionalId) ? professionalLabel(byId.get(t.professionalId)!) : '?') : 'Todos'}</td>
                  <td>{fmtDateTime(t.startsAt, timezone)}</td>
                  <td>{fmtDateTime(t.endsAt, timezone)}</td>
                  <td>{t.reason ?? ''}</td>
                  <td>
                    <form method="post" action={`/empresas/${tenantId}/folgas/${t.id}/apagar`} class="inline">
                      <button type="submit" class="link danger-text">
                        Apagar
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Nenhuma folga marcada.</Empty>
      )}
      <h2>Nova folga ou bloqueio</h2>
      <FormErrors errors={errors} />
      <form method="post" action={`/empresas/${tenantId}/folgas`} class="card stack">
        <SelectField
          name="professionalId"
          label="Quem"
          values={values}
          errors={errors}
          options={[['', 'Todos (empresa fechada)'], ...professionals.filter((p) => p.active).map((p): [string, string] => [p.id, professionalLabel(p)])]}
        />
        <div class="row">
          <TextField name="startDate" type="date" label="Início (data)" values={values} errors={errors} />
          <TextField name="startTime" type="time" label="Início (hora)" hint="Vazio = desde 00:00." values={values} errors={errors} />
        </div>
        <div class="row">
          <TextField name="endDate" type="date" label="Fim (data)" hint="Vazio = mesmo dia." values={values} errors={errors} />
          <TextField name="endTime" type="time" label="Fim (hora)" hint="Vazio = até o fim do dia." values={values} errors={errors} />
        </div>
        <TextField name="reason" label="Motivo (opcional)" values={values} errors={errors} />
        <div class="form-foot">
          <button type="submit">Adicionar</button>
        </div>
      </form>
    </Layout>
  );
};
