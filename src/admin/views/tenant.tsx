import type { FC } from 'hono/jsx';
import type { AgentSettings, TenantOverview, TenantSettings } from '../../ports/admin.ts';
import { TIMEZONE_LABELS, TIMEZONES, type FormValues } from '../forms.ts';
import { CheckField, FormErrors, Layout, SelectField, TextArea, TextField, type PageProps } from './layout.tsx';

interface Step {
  path: string;
  title: string;
  done: boolean;
  doneText: string;
  todoText: string;
  optional?: boolean;
}

export function setupSteps(t: TenantSettings, agent: AgentSettings | null, o: TenantOverview): Step[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    {
      path: '/atendente',
      title: 'Atendente',
      done: o.agentReady,
      doneText: `${agent?.name ?? 'Atendente'} com instruções próprias`,
      todoText: 'Conte como falar e o que o bot precisa saber (pagamento, estacionamento…)',
    },
    {
      path: '/servicos',
      title: 'Serviços',
      done: o.services > 0,
      doneText: plural(o.services, 'serviço ativo', 'serviços ativos'),
      todoText: 'Cadastre o que a empresa faz, com duração e preço',
    },
    {
      path: '/profissionais',
      title: 'Profissionais',
      done: o.professionals > 0,
      doneText: plural(o.professionals, 'profissional', 'profissionais'),
      todoText: 'Quem atende (pode ser só o dono)',
    },
    {
      path: '/horarios',
      title: 'Horários',
      done: o.hours > 0,
      doneText: 'Horário de atendimento definido',
      todoText: 'Dias e horas em que a empresa atende',
    },
    {
      path: '/testar',
      title: 'Testar o atendente',
      done: o.testMessages > 0,
      doneText: 'Já foi testado no painel',
      todoText: 'Converse com o bot aqui antes de ligar o WhatsApp',
    },
    {
      path: '/whatsapp',
      title: 'Número do WhatsApp',
      done: o.numbers > 0,
      doneText: plural(o.numbers, 'número ligado', 'números ligados'),
      todoText: 'Ligue o número da Meta a esta empresa',
    },
    {
      path: '/equipe',
      title: 'Quem recebe os avisos',
      done: o.channels > 0,
      doneText: plural(o.channels, 'pessoa no Telegram', 'pessoas no Telegram'),
      todoText: 'Sem isso o bot não consegue chamar a equipe',
    },
    {
      path: '/agenda',
      title: 'Agenda Google',
      done: Boolean(t.googleCalendarId),
      doneText: 'Marcações vão para a agenda da empresa',
      todoText: 'Opcional: espelhar as marcações na agenda Google',
      optional: true,
    },
    {
      path: '/dados',
      title: 'Lembretes pelo WhatsApp',
      done: t.remindersEnabled,
      doneText: 'Ligados',
      todoText: 'Opcional: só para cliente pagante (mensagens cobradas pela Meta)',
      optional: true,
    },
  ];
}

export const OverviewPage: FC<{ page: PageProps; tenant: TenantSettings; steps: Step[] }> = ({ page, tenant, steps }) => {
  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.done).length;
  const optional = steps.filter((s) => s.optional);
  const pct = Math.round((done / required.length) * 100);
  const item = (s: Step, n: number) => (
    <li class={s.done ? 'done' : s.optional ? 'optional' : ''}>
      <a href={`/empresas/${tenant.id}${s.path}`}>
        <span class="step-mark">{s.done ? '✓' : n || '+'}</span>
        <span class="step-body">
          <span class="step-title">{s.title}</span>
          <span class="step-text">{s.done ? s.doneText : s.todoText}</span>
        </span>
        <span class="step-go" aria-hidden="true">
          ›
        </span>
      </a>
    </li>
  );
  return (
    <Layout {...page}>
      {tenant.status === 'suspended' ? <p class="note">Empresa suspensa: o bot não responde. Reative em Dados.</p> : null}
      <div class="card">
        <div class="card-head">
          <div>
            <h2>{done === required.length ? 'Tudo pronto' : 'Configuração'}</h2>
            <p class="muted small">
              {done === required.length
                ? 'O atendente já pode conversar com os clientes.'
                : `${done} de ${required.length} passos feitos. Siga na ordem.`}
            </p>
          </div>
          <strong>{pct}%</strong>
        </div>
        <progress class="progress" value={done} max={required.length} aria-label={`${pct}% configurado`}></progress>
      </div>
      <ol class="steps">{required.map((s, i) => item(s, i + 1))}</ol>
      <h2>Opcionais</h2>
      <ol class="steps">{optional.map((s) => item(s, 0))}</ol>
    </Layout>
  );
};

export const SettingsPage: FC<{ page: PageProps; tenantId: string; values: FormValues; errors?: Record<string, string> }> = ({
  page,
  tenantId,
  values,
  errors,
}) => (
  <Layout {...page}>
    <FormErrors errors={errors} />
    <form method="post" action={`/empresas/${tenantId}/dados`} class="card stack">
      <TextField name="name" label="Nome da empresa" values={values} errors={errors} required />
      <div class="row">
        <SelectField
          name="segment"
          label="Segmento"
          values={values}
          errors={errors}
          options={[
            ['general', 'Geral'],
            ['health', 'Saúde (regras extras)'],
          ]}
        />
        <SelectField
          name="timezone"
          label="Fuso horário"
          values={values}
          errors={errors}
          options={TIMEZONES.map((tz): [string, string] => [tz, TIMEZONE_LABELS[tz]])}
        />
        <SelectField
          name="status"
          label="Situação"
          hint="Suspensa: o bot para de responder."
          values={values}
          errors={errors}
          options={[
            ['active', 'Ativa'],
            ['suspended', 'Suspensa'],
          ]}
        />
      </div>
      <TextArea name="address" label="Endereço" rows={2} values={values} errors={errors} />
      <fieldset>
        <legend>Lembretes pelo WhatsApp</legend>
        <CheckField
          name="remindersEnabled"
          label="Oferecer lembrete um dia antes (botão “🔔 Lembrete aqui”)"
          hint="Fora da janela de 24 h o lembrete precisa de template pago, e desde 01/10/2026 a Meta cobra também as mensagens dentro da janela (~R$ 0,035 cada). Ligue só para cliente pagante. O “Salvar na agenda” do celular continua grátis."
          checked={values.remindersEnabled === '1'}
        />
      </fieldset>
      <fieldset>
        <legend>Por quanto tempo guardar (LGPD)</legend>
        <div class="row">
          <TextField name="messageRetentionDays" label="Mensagens (dias)" hint="De 1 a 30. Padrão: 7." values={values} errors={errors} inputmode="numeric" />
          <TextField
            name="contactRetentionDays"
            label="Contatos e agendamentos sem atividade (dias)"
            hint="De 30 a 730. Padrão: 365."
            values={values}
            errors={errors}
            inputmode="numeric"
          />
        </div>
      </fieldset>
      <div class="form-foot">
        <button type="submit">Salvar</button>
      </div>
    </form>
  </Layout>
);

export const AgentPage: FC<{ page: PageProps; tenantId: string; values: FormValues; errors?: Record<string, string> }> = ({
  page,
  tenantId,
  values,
  errors,
}) => (
  <Layout
    {...page}
    intro="O que o atendente sabe e como ele fala. Preço, horário e disponibilidade ele sempre tira do cadastro (serviços e agenda), nunca daqui."
  >
    <FormErrors errors={errors} />
    <form method="post" action={`/empresas/${tenantId}/atendente`} class="card stack">
      <TextField name="name" label="Nome do atendente" values={values} errors={errors} required />
      <TextArea
        name="tone"
        label="Jeito de falar"
        hint="Ex.: acolhedor e tranquilo, sem gírias. Até 300 caracteres."
        rows={2}
        values={values}
        errors={errors}
      />
      <TextArea
        name="instructions"
        label="Instruções"
        hint="Regras da empresa para o atendente. Ex.: “Chame o cliente pelo primeiro nome. Se perguntarem sobre trabalhos espirituais, diga que a equipe explica pessoalmente.” Até 2.000 caracteres."
        rows={5}
        values={values}
        errors={errors}
      />
      <TextArea
        name="knowledgeBase"
        label="Informações da empresa"
        hint="Fatos que o cliente costuma perguntar: formas de pagamento, estacionamento, atendimento online, política de atraso. Até 4.000 caracteres."
        rows={8}
        values={values}
        errors={errors}
      />
      <div class="row">
        <TextField
          name="bookingTerm"
          label="Como chamar o agendamento"
          hint="horário, consulta, sessão, leitura…"
          values={values}
          errors={errors}
          required
        />
        <TextField
          name="professionalTerm"
          label="Como chamar quem atende"
          hint="profissional, barbeiro, taróloga…"
          values={values}
          errors={errors}
          required
        />
      </div>
      <div class="row">
        <TextField name="maxReplyChars" label="Tamanho máximo da resposta" hint="De 200 a 1.000 caracteres. Padrão: 500." values={values} errors={errors} inputmode="numeric" />
        <TextField
          name="handoffResumeHours"
          label="Horas com a equipe"
          hint="Depois que a equipe responde, o bot espera isso para voltar (1 a 72). Padrão: 12."
          values={values}
          errors={errors}
          inputmode="numeric"
        />
      </div>
      <div class="form-foot">
        <button type="submit">Salvar</button>
        <a href={`/empresas/${tenantId}/testar`}>Testar o atendente</a>
      </div>
    </form>
  </Layout>
);
