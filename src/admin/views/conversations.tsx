import type { FC } from 'hono/jsx';
import type { ConversationSummary, TranscriptMessage, UsageRow } from '../../ports/admin.ts';
import { fmtInt, fmtMetaCost, fmtMonth, fmtPhone, fmtShort, fmtUsdMicros } from '../format.ts';
import { Empty, Layout, type PageProps } from './layout.tsx';
import { displayBody, WaText } from './test-chat.tsx';

const AUTHOR: Record<TranscriptMessage['author'], string> = { customer: 'Cliente', bot: 'Bot', human: 'Equipe' };

function statusText(c: ConversationSummary, timezone: string): string {
  return c.status === 'human' ? `com a equipe${c.pausedUntil ? ` até ${fmtShort(c.pausedUntil, timezone)}` : ''}` : 'com o bot';
}

export const ConversationsPage: FC<{ page: PageProps; tenantId: string; timezone: string; items: ConversationSummary[] }> = ({
  page,
  tenantId,
  timezone,
  items,
}) => (
  <Layout {...page} intro="Conversas dos últimos 7 dias. As mensagens são apagadas depois do prazo da empresa (LGPD).">
    {items.length ? (
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Contato</th>
              <th>Número</th>
              <th>Situação</th>
              <th>Última do cliente</th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr>
                <td>
                  <a href={`/empresas/${tenantId}/conversas/${c.id}`}>{c.contactName ?? 'Sem nome'}</a>
                  <span class="sub">{fmtPhone(c.waId)}</span>
                </td>
                <td>{c.phoneKind === 'test' ? <span class="badge off">teste</span> : c.displayPhone}</td>
                <td>
                  {c.status === 'human' ? <span class="badge warn">{statusText(c, timezone)}</span> : <span class="badge">com o bot</span>}
                </td>
                <td>{fmtShort(c.lastCustomerMsgAt, timezone)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty>Nenhuma conversa nos últimos 7 dias.</Empty>
    )}
  </Layout>
);

export const ConversationPage: FC<{
  page: PageProps;
  tenantId: string;
  timezone: string;
  summary: ConversationSummary;
  messages: TranscriptMessage[];
}> = ({ page, tenantId, timezone, summary, messages }) => (
  <Layout {...page}>
    <p class="small">
      <a href={`/empresas/${tenantId}/conversas`}>← Voltar para conversas</a>
    </p>
    <div class="chat-card">
      <div class="card-head">
        <div>
          <strong>{summary.contactName ?? 'Sem nome'}</strong>
          <p class="muted small">
            {fmtPhone(summary.waId)} · {statusText(summary, timezone)}
          </p>
        </div>
        {summary.status === 'human' ? (
          <form method="post" action={`/empresas/${tenantId}/conversas/${summary.id}/reativar`}>
            <button type="submit" title="O bot volta a responder este cliente">
              Reativar o bot
            </button>
          </form>
        ) : null}
      </div>
      <div class="chat" aria-label="Mensagens">
        {messages.length ? (
          messages.map((m) => (
            <div class={m.author === 'customer' ? 'bubble them' : 'bubble me'}>
              <WaText text={displayBody(m.author, m.body)} />
              <span class="meta">
                {AUTHOR[m.author]} · {fmtShort(m.createdAt, timezone)}
              </span>
            </div>
          ))
        ) : (
          <p class="system">Sem mensagens guardadas (já passaram do prazo).</p>
        )}
      </div>
    </div>

    {summary.phoneKind === 'test' ? (
      <p class="note">
        Esta é a conversa do chat de teste. Para apagá-la, use <a href={`/empresas/${tenantId}/testar`}>Limpar teste</a>.
      </p>
    ) : (
      <>
    <h2>Apagar os dados deste contato (LGPD)</h2>
    <form method="post" action={`/empresas/${tenantId}/conversas/${summary.id}/apagar`} class="card stack">
      <p class="small">
        Apaga o contato, as conversas, as mensagens e os agendamentos dele nesta empresa, os eventos na agenda Google e o estado da
        conversa no bot. Não dá para desfazer. Os números do medidor continuam (não identificam ninguém).
      </p>
      <label class="check">
        <input type="checkbox" name="confirm" value="1" required />
        <span>Confirmo que quero apagar todos os dados de {fmtPhone(summary.waId)}.</span>
      </label>
      <div class="form-foot">
        <button type="submit" class="danger">
          Apagar dados do contato
        </button>
      </div>
    </form>
      </>
    )}
  </Layout>
);

export const UsagePage: FC<{ page: PageProps; rows: UsageRow[]; metaPriceBrlMilli: number }> = ({ page, rows, metaPriceBrlMilli }) => (
  <Layout
    {...page}
    intro="Por número e por mês. “Cobradas” vem do status de cada mensagem na Meta; o custo da IA é o que seria pago fora do plano grátis."
  >
    {rows.length ? (
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Número</th>
              <th class="num">Recebidas</th>
              <th class="num">Respostas</th>
              <th class="num">Entregues</th>
              <th class="num">Cobradas Meta</th>
              <th class="num">IA</th>
              <th class="num">Custo IA*</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const templates = r.templatesUtility + r.templatesMarketing + r.templatesAuth;
              return (
                <tr>
                  <td>
                    {r.kind === 'test' ? 'Simulador (teste)' : r.displayPhone}
                    <span class="sub">{fmtMonth(r.month)}</span>
                  </td>
                  <td class="num">{fmtInt(r.msgsIn)}</td>
                  <td class="num">{fmtInt(r.repliesOut)}</td>
                  <td class="num">
                    {fmtInt(r.msgsDelivered)}
                    <span class="sub">{r.msgsFailed ? `${fmtInt(r.msgsFailed)} falhas` : 'sem falhas'}</span>
                  </td>
                  <td class="num">
                    {fmtInt(r.serviceBilled + templates)}
                    <span class="sub">≈ {fmtMetaCost(r.serviceBilled + templates, metaPriceBrlMilli)}</span>
                  </td>
                  <td class="num">
                    {fmtInt(r.llmRequests)} req.
                    <span class="sub">
                      {fmtInt(r.tokensIn + r.tokensOut)} tokens{r.sttSeconds ? ` · ${fmtInt(r.sttSeconds)} s de áudio` : ''}
                    </span>
                  </td>
                  <td class="num">{fmtUsdMicros(r.estCostUsdMicros)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty>Sem uso registrado nos últimos meses.</Empty>
    )}
    <p class="small muted">
      “Cobradas Meta” inclui respostas e templates (≈ R$ 0,035 cada, tabela de utilidade do Brasil; terceiros citam 1.000 grátis por
      número por mês, sem confirmação oficial). * Quanto a IA custaria fora do plano grátis.
    </p>
  </Layout>
);
