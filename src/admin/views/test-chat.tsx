import type { FC } from 'hono/jsx';
import type { TranscriptMessage } from '../../ports/admin.ts';
import type { TestTurnResult } from '../../ports/bot-admin.ts';
import { stripReplyRef } from '../../core/interactive.ts';
import { fmtShort } from '../format.ts';
import { Layout, type PageProps } from './layout.tsx';

// Chat de teste: o operador faz o papel do cliente ("me", à direita).

/**
 * Mensagem do cliente para exibir: o toque numa opção é gravado como
 * "título (slot|…)" para a IA ver a referência; no painel, só o título.
 */
export function displayBody(author: TranscriptMessage['author'], body: string): string {
  return author === 'customer' ? stripReplyRef(body) : body;
}

/** Texto do WhatsApp com *negrito*, sem HTML cru (cada pedaço passa pelo escape do JSX). */
export const WaText: FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(/(\*[^*\n]+\*)/g).map((part) =>
      part.length > 2 && part.startsWith('*') && part.endsWith('*') ? <strong>{part.slice(1, -1)}</strong> : part,
    )}
  </>
);

const ChatForm: FC<{ tenantId: string; oob?: boolean }> = ({ tenantId, oob }) => (
  <form
    id="chat-form"
    method="post"
    action={`/empresas/${tenantId}/testar`}
    hx-post={`/empresas/${tenantId}/testar`}
    hx-target="#chat"
    hx-swap="beforeend scroll:bottom"
    hx-swap-oob={oob ? 'true' : undefined}
    class="chat-input"
  >
    <input type="text" name="text" placeholder="Escreva como se fosse o cliente…" aria-label="Mensagem" autocomplete="off" maxlength={1000} required />
    <button type="submit">Enviar</button>
  </form>
);

const Choices: FC<{ tenantId: string; result: TestTurnResult }> = ({ tenantId, result }) => {
  const choices = [...(result.reply?.options ?? []), ...(result.reply?.buttons ?? [])];
  if (!choices.length) return null;
  return (
    <div class="choices">
      {choices.map((ch) => (
        <form hx-post={`/empresas/${tenantId}/testar`} hx-target="#chat" hx-swap="beforeend scroll:bottom" method="post" action={`/empresas/${tenantId}/testar`}>
          <input type="hidden" name="replyId" value={ch.id} />
          <input type="hidden" name="title" value={ch.title} />
          <button type="submit" title={'description' in ch && typeof ch.description === 'string' ? ch.description : undefined}>
            {ch.title}
          </button>
        </form>
      ))}
    </div>
  );
};

function systemNote(result: TestTurnResult): string | null {
  if (result.outcome === 'paused') return 'A conversa está com a equipe (no teste ninguém foi avisado). Use “Limpar teste” para recomeçar.';
  if (result.handoff) return 'Aqui o bot chamaria a equipe pelo Telegram (no teste, ninguém foi avisado).';
  if (result.outcome === 'contingency') return `A IA não respondeu (${result.errorCode ?? 'erro'}). Veja a cota na página inicial.`;
  if (result.action === 'booked' || result.action === 'rescheduled') {
    return 'Horário marcado de verdade na agenda (sem Google e sem Telegram). “Limpar teste” libera.';
  }
  if (result.outcome === 'empty') return 'Escreva uma mensagem.';
  return null;
}

/** Resposta do htmx: a mensagem do cliente, a do bot, as opções e um formulário limpo. */
export const ChatTurn: FC<{ tenantId: string; sent: string; result: TestTurnResult }> = ({ tenantId, sent, result }) => {
  const note = systemNote(result);
  return (
    <>
      {result.outcome !== 'empty' ? <div class="bubble me">{sent}</div> : null}
      {result.reply ? (
        <div class="bubble them">
          <WaText text={result.reply.text} />
        </div>
      ) : null}
      <Choices tenantId={tenantId} result={result} />
      {note ? <p class="system">{note}</p> : null}
      <ChatForm tenantId={tenantId} oob />
    </>
  );
};

export const ChatError: FC<{ tenantId: string }> = ({ tenantId }) => (
  <>
    <p class="system">Não consegui falar com o bot agora. Tente de novo.</p>
    <ChatForm tenantId={tenantId} oob />
  </>
);

export const TestChatPage: FC<{
  page: PageProps;
  tenantId: string;
  timezone: string;
  messages: TranscriptMessage[];
  ready: { services: number; hours: number };
}> = ({ page, tenantId, timezone, messages, ready }) => (
  <Layout
    {...page}
    intro="Converse como se fosse um cliente. É o mesmo bot, com o cadastro de verdade; nada sai pelo WhatsApp e a equipe não é avisada."
  >
    {ready.services === 0 || ready.hours === 0 ? (
      <p class="note">Sem serviços ou sem horários cadastrados, o bot não consegue oferecer horários. Ele ainda responde perguntas.</p>
    ) : null}
    <div class="chat-card">
      <div class="card-head">
        <div>
          <strong>Cliente Teste</strong>
          <p class="muted small">Cada mensagem usa a cota grátis da IA.</p>
        </div>
        <form method="post" action={`/empresas/${tenantId}/testar/limpar`}>
          <button type="submit" class="secondary" title="Apaga esta conversa e os horários marcados nela">
            Limpar teste
          </button>
        </form>
      </div>
      <div id="chat" class="chat" aria-live="polite">
        {messages.length ? (
          messages.map((m) => (
            <div class={m.author === 'customer' ? 'bubble me' : 'bubble them'}>
              <WaText text={displayBody(m.author, m.body)} />
              <span class="meta">{fmtShort(m.createdAt, timezone)}</span>
            </div>
          ))
        ) : (
          <p class="system">Comece com um “oi” ou peça um horário.</p>
        )}
      </div>
      <ChatForm tenantId={tenantId} />
    </div>
  </Layout>
);
