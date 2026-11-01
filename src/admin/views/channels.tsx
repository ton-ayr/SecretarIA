import type { FC } from 'hono/jsx';
import type { ChannelRow, MetaAccountRow, PhoneRow } from '../../ports/admin.ts';
import type { CalendarCheck, MetaNumber } from '../../ports/bot-admin.ts';
import type { FormValues } from '../forms.ts';
import { fmtDateTime } from '../format.ts';
import { Empty, FormErrors, Layout, SelectField, TextField, type PageProps } from './layout.tsx';

export const CalendarCheckResult: FC<{ check: CalendarCheck }> = ({ check }) =>
  check.problem ? (
    <span class="pending">✗ {check.problem}</span>
  ) : (
    <span class="ok">
      ✓ Leitura e escrita ok ({check.busy} {check.busy === 1 ? 'bloqueio' : 'bloqueios'} nos próximos 7 dias).
    </span>
  );

export const CalendarPage: FC<{
  page: PageProps;
  tenantId: string;
  rules: FormValues;
  calendar: FormValues;
  serviceAccount: string | null;
  errors?: Record<string, string> | undefined;
  calendarErrors?: Record<string, string> | undefined;
}> = ({ page, tenantId, rules, calendar, serviceAccount, errors, calendarErrors }) => (
  <Layout {...page} intro="Como os horários são oferecidos e, se quiser, a agenda Google da empresa.">
    <FormErrors errors={errors} />
    <form method="post" action={`/empresas/${tenantId}/agenda`} class="card stack">
      <div class="card-head">
        <div>
          <h2>Regras da agenda</h2>
          <p class="muted small">Valem para todos os serviços da empresa.</p>
        </div>
      </div>
      <div class="row">
        <TextField
          name="slotStepMin"
          label="Intervalo entre horários (min)"
          hint="15 = 09:00, 09:15… Para sessões longas, 30 ou 60."
          values={rules}
          errors={errors}
          inputmode="numeric"
        />
        <TextField
          name="minAdvanceMin"
          label="Antecedência mínima (min)"
          hint="Não oferece horário mais cedo que isso. 60 = 1 hora."
          values={rules}
          errors={errors}
          inputmode="numeric"
        />
        <TextField name="maxDaysAhead" label="Até quantos dias à frente" values={rules} errors={errors} inputmode="numeric" />
        <TextField name="maxOptions" label="Opções na lista" hint="De 1 a 10. Padrão: 6." values={rules} errors={errors} inputmode="numeric" />
      </div>
      <div class="form-foot">
        <button type="submit">Salvar regras</button>
      </div>
    </form>

    <FormErrors errors={calendarErrors} />
    <form method="post" action={`/empresas/${tenantId}/agenda/google`} class="card stack">
      <div class="card-head">
        <div>
          <h2>Agenda Google da empresa (opcional)</h2>
          <p class="muted small">
            Cada marcação vira evento nessa agenda, e o que o dono bloquear nela some dos horários livres. O “Salvar na agenda” do
            cliente funciona sem isso.
          </p>
        </div>
      </div>
    {serviceAccount ? (
      <ol class="small">
        <li>
          No Google Agenda (computador), abra a agenda da empresa › Configurações e compartilhamento › Compartilhar com pessoas
          específicas.
        </li>
        <li>
          Adicione <code>{serviceAccount}</code> com a permissão <strong>Fazer alterações nos eventos</strong>.
        </li>
        <li>Em “Integrar agenda”, copie o ID da agenda e cole abaixo.</li>
      </ol>
    ) : (
      <p class="note">A chave da conta de serviço do Google ainda não está no bot (npm run google -- chave).</p>
    )}
      <TextField name="calendarId" label="ID da agenda" hint="Vazio = desligar." values={calendar} errors={calendarErrors} />
      <div class="form-foot">
        <button type="submit">Salvar agenda</button>
        <button type="button" class="secondary" hx-post={`/empresas/${tenantId}/agenda/testar`} hx-include="[name='calendarId']" hx-target="#calendar-check">
          Testar
        </button>
        <span id="calendar-check" class="small"></span>
      </div>
    </form>
  </Layout>
);

export const WhatsAppPage: FC<{
  page: PageProps;
  tenantId: string;
  phones: PhoneRow[];
  accounts: MetaAccountRow[];
  selectedAccount: MetaAccountRow | null;
  numbers: MetaNumber[] | null;
  lookupError: string | null;
  values: FormValues;
  errors?: Record<string, string> | undefined;
}> = ({ page, tenantId, phones, accounts, selectedAccount, numbers, lookupError, values, errors }) => {
  const wabaOf = new Map(accounts.map((a) => [a.id, a.wabaId]));
  const real = phones.filter((p) => p.kind === 'whatsapp');
  const used = new Set(phones.map((p) => p.metaPhoneNumberId));
  const withToken = accounts.filter((a) => a.hasToken);
  return (
    <Layout {...page} intro="Números da sua conta Meta que atendem por esta empresa.">
      {real.length ? (
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Número</th>
                <th>Phone Number ID</th>
                <th>Conta Meta</th>
                <th>Situação</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {real.map((p) => (
                <tr>
                  <td>{p.displayPhone}</td>
                  <td>
                    <code>{p.metaPhoneNumberId}</code>
                  </td>
                  <td>{p.metaAccountId ? <code>{wabaOf.get(p.metaAccountId) ?? '?'}</code> : <span class="muted">—</span>}</td>
                  <td>{p.status === 'active' ? <span class="badge">ativo</span> : <span class="badge off">desligado</span>}</td>
                  <td>
                    <form method="post" action={`/empresas/${tenantId}/whatsapp/${p.id}/status`} class="inline">
                      <input type="hidden" name="status" value={p.status === 'active' ? 'disabled' : 'active'} />
                      <button type="submit" class={p.status === 'active' ? 'link danger-text' : 'link'}>
                        {p.status === 'active' ? 'Desligar' : 'Religar'}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>Nenhum número ligado. Enquanto isso, converse com o bot em “Testar atendente”.</Empty>
      )}

      <h2>Ligar um número</h2>
      <p class="small muted">
        O número precisa estar registrado na Cloud API (WhatsApp Manager) dentro da sua conta Meta. O webhook já recebe todos os números da
        conta.
      </p>
      {withToken.length === 0 ? (
        <p class="note">
          Nenhuma conta Meta com token. Cadastre em <a href="/meta">Contas Meta</a>.
        </p>
      ) : (
        <form method="get" action={`/empresas/${tenantId}/whatsapp`} class="card">
          <div class="row">
            <SelectField
              name="conta"
              label="Conta Meta (WABA)"
              values={{ conta: selectedAccount?.id ?? '' }}
              options={withToken.map((a): [string, string] => [a.id, a.wabaId])}
            />
          </div>
          <div class="actions">
            <button type="submit" class="secondary">
              Buscar números da conta
            </button>
          </div>
        </form>
      )}

      <FormErrors errors={errors} />
      {selectedAccount && numbers ? (
        <form method="post" action={`/empresas/${tenantId}/whatsapp`} class="card stack">
          <input type="hidden" name="metaAccountId" value={selectedAccount.id} />
          {numbers.filter((n) => !used.has(n.id)).length ? (
            <SelectField
              name="metaPhoneNumberId"
              label="Número"
              values={values}
              errors={errors}
              options={numbers
                .filter((n) => !used.has(n.id))
                .map((n): [string, string] => [
                  n.id,
                  `${n.displayPhoneNumber} — ${n.verifiedName || 'sem nome'}${n.qualityRating ? ` (qualidade ${n.qualityRating})` : ''}`,
                ])}
            />
          ) : (
            <Empty>Todos os números desta conta já estão ligados.</Empty>
          )}
          <div class="form-foot">
            <button type="submit">Ligar à empresa</button>
          </div>
        </form>
      ) : null}
      {lookupError || (selectedAccount && !numbers) ? (
        <>
          <p class="note">{lookupError ?? 'Não consegui buscar os números.'} Você pode informar o número à mão:</p>
          <form method="post" action={`/empresas/${tenantId}/whatsapp`} class="card stack">
            <input type="hidden" name="manual" value="1" />
            <input type="hidden" name="metaAccountId" value={selectedAccount?.id ?? ''} />
            <div class="row">
              <TextField name="metaPhoneNumberId" label="Phone Number ID" values={values} errors={errors} inputmode="numeric" />
              <TextField name="displayPhone" label="Número como aparece" placeholder="+55 11 91234-5678" values={values} errors={errors} />
            </div>
            <div class="form-foot">
              <button type="submit">Ligar à empresa</button>
            </div>
          </form>
        </>
      ) : null}
    </Layout>
  );
};

export const TeamPage: FC<{
  page: PageProps;
  tenantId: string;
  timezone: string;
  now: string;
  channels: ChannelRow[];
  newLink: string | null;
  botMissing: boolean;
  values: FormValues;
  errors?: Record<string, string> | undefined;
}> = ({ page, tenantId, timezone, now, channels, newLink, botMissing, values, errors }) => (
  <Layout
    {...page}
    intro="Quem recebe no Telegram os pedidos de atendimento humano e os avisos de marcação, e responde ao cliente por lá. Cada pessoa abre o próprio link."
  >
    {newLink ? (
      <div class="card">
        <strong>Link de uso único (vale 24 horas):</strong>
        <p>
          <code>{newLink}</code>
        </p>
        <p class="small muted">Mande para a pessoa abrir no Telegram e tocar em “Iniciar”. Ele não aparece de novo.</p>
      </div>
    ) : null}
    {channels.length ? (
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Quem</th>
              <th>Situação</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {channels.map((ch) => (
              <tr>
                <td>{ch.label ?? 'Sem nome'}</td>
                <td>
                  {ch.active ? (
                    <span class="badge">ativo desde {fmtDateTime(ch.linkedAt, timezone)}</span>
                  ) : ch.linkExpiresAt && ch.linkExpiresAt > now ? (
                    <span class="badge warn">aguardando: link vale até {fmtDateTime(ch.linkExpiresAt, timezone)}</span>
                  ) : (
                    <span class="badge off">link vencido</span>
                  )}
                </td>
                <td>
                  <form method="post" action={`/empresas/${tenantId}/equipe/${ch.id}/remover`} class="inline">
                    <button type="submit" class="link danger-text">
                      Remover
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <p class="note">Ninguém recebe avisos ainda: sem isso o bot não consegue chamar a equipe.</p>
    )}
    <h2>Gerar link para uma pessoa</h2>
    {botMissing ? <p class="note">O bot do Telegram não está configurado (TELEGRAM_BOT_TOKEN).</p> : null}
    <FormErrors errors={errors} />
    <form method="post" action={`/empresas/${tenantId}/equipe`} class="card stack">
      <TextField name="label" label="Nome de quem vai receber" hint="Ex.: Dono, Recepção." values={values} errors={errors} />
      <div class="form-foot">
        <button type="submit" disabled={botMissing}>
          Gerar link
        </button>
      </div>
    </form>
  </Layout>
);
