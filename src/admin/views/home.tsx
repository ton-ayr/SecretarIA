import type { FC } from 'hono/jsx';
import type { LlmUsageRow, MetaAccountRow, OpsUsageRow, TenantSummary } from '../../ports/admin.ts';
import { TIMEZONE_LABELS, TIMEZONES, type FormValues } from '../forms.ts';
import { fmtInt, fmtMetaCost, fmtMonth, fmtUsdMicros, SEGMENT_LABEL } from '../format.ts';
import { Empty, FormErrors, Layout, PageHead, SelectField, TextArea, TextField, type PageProps } from './layout.tsx';

/** Os mesmos 7 passos obrigatórios da visão geral da empresa (views/tenant.tsx). */
export function setupProgress(t: Omit<TenantSummary, 'id' | 'name' | 'segment' | 'status' | 'createdAt'>) {
  const checks = [t.agentReady, t.services > 0, t.professionals > 0, t.hours > 0, t.testMessages > 0, t.numbers > 0, t.channels > 0];
  return { done: checks.filter(Boolean).length, total: checks.length };
}

const TIMEZONE_OPTIONS = TIMEZONES.map((tz): [string, string] => [tz, TIMEZONE_LABELS[tz]]);

export const HomePage: FC<{
  page: PageProps;
  tenants: TenantSummary[];
  usage: OpsUsageRow[];
  llm: LlmUsageRow[];
  month: string;
  metaPriceBrlMilli: number;
}> = ({ page, tenants, usage, llm, month, metaPriceBrlMilli }) => {
  const sum = (f: (u: OpsUsageRow) => number) => usage.reduce((s, u) => s + f(u), 0);
  const billed = sum((u) => u.serviceBilled + u.templatesUtility + u.templatesMarketing + u.templatesAuth);
  const llmToday = llm.reduce((s, l) => s + l.requests, 0);
  const active = tenants.filter((t) => t.status === 'active').length;
  return (
    <Layout {...page}>
      <PageHead title="Empresas" intro="Cadastre e acompanhe cada negócio atendido pelo bot.">
        <a class="button" href="/empresas/nova">
          + Nova empresa
        </a>
      </PageHead>

      <div class="stats">
        <div class="stat">
          <div class="label">Empresas ativas</div>
          <div class="value">{active}</div>
          <div class="sub">de {tenants.length} cadastradas</div>
        </div>
        <div class="stat">
          <div class="label">Mensagens recebidas</div>
          <div class="value">{fmtInt(sum((u) => u.msgsIn))}</div>
          <div class="sub">em {fmtMonth(month)}</div>
        </div>
        <div class="stat">
          <div class="label">Respostas enviadas</div>
          <div class="value">{fmtInt(sum((u) => u.repliesOut))}</div>
          <div class="sub">em {fmtMonth(month)}</div>
        </div>
        <div class="stat">
          <div class="label">Cobradas pela Meta</div>
          <div class="value">{fmtInt(billed)}</div>
          <div class="sub">≈ {fmtMetaCost(billed, metaPriceBrlMilli)} no mês</div>
        </div>
        <div class="stat">
          <div class="label">IA hoje</div>
          <div class="value">{fmtInt(llmToday)}</div>
          <div class="sub">requisições (cota grátis)</div>
        </div>
      </div>

      <h2>Empresas</h2>
      {tenants.length === 0 ? (
        <Empty>
          Nenhuma empresa ainda. <a href="/empresas/nova">Cadastre a primeira</a>.
        </Empty>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Empresa</th>
                <th>Segmento</th>
                <th>Configuração</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => {
                const p = setupProgress(t);
                return (
                  <tr>
                    <td>
                      <a href={`/empresas/${t.id}`}>{t.name}</a>
                    </td>
                    <td>{SEGMENT_LABEL[t.segment]}</td>
                    <td>
                      <span class={p.done === p.total ? 'badge' : 'badge warn'}>
                        {p.done} de {p.total} passos
                      </span>
                    </td>
                    <td>{t.status === 'active' ? <span class="badge">ativa</span> : <span class="badge off">suspensa</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Uso por número em {fmtMonth(month)}</h2>
      {usage.length === 0 ? (
        <Empty>Sem uso neste mês.</Empty>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Empresa / número</th>
                <th class="num">Recebidas</th>
                <th class="num">Respostas</th>
                <th class="num">Cobradas Meta</th>
                <th class="num">IA (req.)</th>
                <th class="num">Custo IA*</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr>
                  <td>
                    {u.tenantName}
                    <span class="sub">{u.kind === 'test' ? 'Simulador (chat de teste)' : u.displayPhone}</span>
                  </td>
                  <td class="num">{fmtInt(u.msgsIn)}</td>
                  <td class="num">{fmtInt(u.repliesOut)}</td>
                  <td class="num">{fmtInt(u.serviceBilled + u.templatesUtility + u.templatesMarketing + u.templatesAuth)}</td>
                  <td class="num">{fmtInt(u.llmRequests)}</td>
                  <td class="num">{fmtUsdMicros(u.estCostUsdMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="small muted">
        * Quanto custaria fora do plano grátis. Desde 01/10/2026 a Meta cobra também as respostas dentro da janela de 24 h (~R$ 0,035
        cada); terceiros citam 1.000 grátis por número por mês, sem confirmação oficial.
      </p>

      <h2>IA hoje, por modelo</h2>
      {llm.length === 0 ? (
        <Empty>Nenhuma chamada à IA hoje.</Empty>
      ) : (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Modelo</th>
                <th class="num">Requisições</th>
                <th class="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {llm.map((l) => (
                <tr>
                  <td>
                    {l.provider}:{l.model}
                  </td>
                  <td class="num">{fmtInt(l.requests)}</td>
                  <td class="num">{fmtInt(l.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="small muted">Groq grátis: 1.000 requisições e 200 mil tokens por dia, por modelo (dia em UTC). Acima de 70% você recebe aviso no Telegram.</p>
    </Layout>
  );
};

export const NewTenantPage: FC<{ page: PageProps; values: FormValues; errors?: Record<string, string> }> = ({ page, values, errors }) => (
  <Layout {...page}>
    <div class="crumbs">
      <a href="/">Empresas</a> / Nova
    </div>
    <PageHead
      title="Nova empresa"
      intro="Depois de criar, a página da empresa mostra os passos que faltam: atendente, serviços, profissionais, horários, teste, WhatsApp e equipe."
    />
    <FormErrors errors={errors} />
    <form method="post" action="/empresas" class="card stack">
      <TextField name="name" label="Nome da empresa" values={values} errors={errors} required />
      <div class="row">
        <SelectField
          name="segment"
          label="Segmento"
          hint="Saúde liga regras fixas: sem orientação clínica e sem dado de saúde no resumo."
          values={values}
          errors={errors}
          options={[
            ['general', 'Geral (beleza, pet, serviços…)'],
            ['health', 'Saúde (clínicas, consultórios)'],
          ]}
        />
        <SelectField name="timezone" label="Fuso horário" values={values} errors={errors} options={TIMEZONE_OPTIONS} />
      </div>
      <TextArea name="address" label="Endereço" hint="Aparece na confirmação do agendamento. Pode ser “Atendimento online”." rows={2} values={values} errors={errors} />
      <TextField
        name="agentName"
        label="Nome do atendente virtual"
        hint="Como o bot se apresenta (ex.: Luna). Dá para mudar depois."
        values={values}
        errors={errors}
        required
      />
      <div class="form-foot">
        <button type="submit">Criar empresa</button>
        <a class="button secondary" href="/">
          Cancelar
        </a>
      </div>
    </form>
  </Layout>
);

export const MetaAccountsPage: FC<{ page: PageProps; accounts: MetaAccountRow[]; values: FormValues; errors?: Record<string, string> }> = ({
  page,
  accounts,
  values,
  errors,
}) => (
  <Layout {...page} nav="meta">
    <PageHead
      title="Contas Meta"
      intro="Os números de WhatsApp das empresas ficam na sua conta Meta (WABA). O token é gravado cifrado e nunca volta a aparecer."
    />
    {accounts.length ? (
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Conta (WABA)</th>
              <th>Token</th>
              <th class="num">Números ligados</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr>
                <td>
                  <code>{a.wabaId}</code>
                </td>
                <td>{a.hasToken ? <span class="badge">gravado</span> : <span class="badge warn">sem token</span>}</td>
                <td class="num">{a.numbers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty>Nenhuma conta Meta ainda.</Empty>
    )}
    <h2>Adicionar conta ou trocar o token</h2>
    <FormErrors errors={errors} />
    <form method="post" action="/meta" class="card stack" autocomplete="off">
      <TextField name="wabaId" label="ID da conta do WhatsApp Business (WABA)" values={values} errors={errors} inputmode="numeric" />
      <TextField
        name="token"
        type="password"
        label="Token permanente"
        hint="Meta Business › Usuários do sistema › Gerar token (permissões whatsapp_business_messaging e whatsapp_business_management)."
        values={{}}
        errors={errors}
      />
      <div class="form-foot">
        <button type="submit">Gravar</button>
      </div>
    </form>
  </Layout>
);
