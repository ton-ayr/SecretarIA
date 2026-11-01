import type { ToolDef } from '../ports/llm.ts';
import type { HandoffReason } from '../ports/notifier.ts';

/**
 * Passagem para humano (ARQUITETURA §4.4 e §9). Dois gatilhos:
 *  - a IA chama a ferramenta transfer_to_human;
 *  - rede de segurança: frases explícitas disparam a passagem sem chamar a IA.
 * A resposta ao cliente é SEMPRE um texto fixo do servidor, que só diz que a
 * equipe foi avisada se o aviso realmente saiu.
 */

export const HANDOFF_TOOL_NAME = 'transfer_to_human';

const REASONS_FROM_TOOL: Record<string, HandoffReason> = {
  pedido_do_cliente: 'customer_request',
  nao_sei_responder: 'unknown_answer',
  assunto_sensivel: 'sensitive',
  agendamento: 'scheduling',
};

export const HANDOFF_TOOL: ToolDef = {
  name: HANDOFF_TOOL_NAME,
  description:
    'Chama a equipe da empresa para continuar este atendimento pelo WhatsApp. Depois disso você para de responder esta conversa até a equipe devolver. ' +
    'Use quando o cliente pedir para falar com uma pessoa, quando aceitar que a equipe entre em contato, quando você não souber responder algo importante para ele, ou em assunto delicado.',
  parameters: {
    type: 'object',
    properties: {
      motivo: {
        type: 'string',
        enum: Object.keys(REASONS_FROM_TOOL),
        description: 'Por que a equipe está sendo chamada.',
      },
      resumo: {
        type: 'string',
        description: 'Resumo curto (até 200 caracteres) do que o cliente precisa, para a equipe ler antes de responder.',
      },
    },
    required: ['motivo', 'resumo'],
  },
};

/** Com a agenda ligada, marcar é com o bot: a equipe não é chamada para isso. */
export function handoffTool(schedulingAvailable: boolean): ToolDef {
  if (!schedulingAvailable) return HANDOFF_TOOL;
  const props = HANDOFF_TOOL.parameters.properties as Record<string, { enum?: string[] }>;
  return {
    ...HANDOFF_TOOL,
    parameters: {
      ...HANDOFF_TOOL.parameters,
      properties: {
        ...props,
        motivo: { ...props.motivo, enum: props.motivo!.enum!.filter((m) => m !== 'agendamento') },
      },
    },
  };
}

export function reasonFromToolArgs(args: Record<string, unknown>): HandoffReason {
  return REASONS_FROM_TOOL[String(args.motivo ?? '')] ?? 'customer_request';
}

export function summaryFromToolArgs(args: Record<string, unknown>): string | null {
  const text = typeof args.resumo === 'string' ? args.resumo.replace(/\s+/g, ' ').trim() : '';
  return text ? text.slice(0, 300) : null;
}

export const REASON_LABELS: Record<HandoffReason, string> = {
  customer_request: 'cliente pediu para falar com a equipe',
  unknown_answer: 'o bot não soube responder',
  sensitive: 'assunto delicado',
  scheduling: 'cliente quer marcar horário',
  technical_failure: 'falha técnica do bot',
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
}

const TARGET = '(atendente|humano|humana|pessoa|alguem|gerente|dono|dona|responsavel|funcionari[oa]|recepcao|recepcionista|equipe)';
const HUMAN_PATTERNS = [
  // "quero falar com uma pessoa", "posso conversar com o gerente?"
  new RegExp(`\\b(falar|conversar)\\s+com\\s+(um|uma|o|a|algum|alguma|alguem|a sua|sua)?\\s*${TARGET}\\b`),
  // "me passa pra um atendente", "chama o dono"
  new RegExp(`\\b(passa|passar|transfere|transferir|chama|chamar|chame)\\b.{0,20}\\b${TARGET}\\b`),
  /\b(pessoa de verdade|ser humano|atendimento humano|atendente humano|nao quero (falar com )?(robo|bot|maquina))\b/,
  /\b(quero|preciso de|cade)\s+(um|uma|o)?\s*(humano|atendente)\b/,
];

/** Rede de segurança: o cliente pediu explicitamente para falar com uma pessoa? */
export function wantsHuman(texts: string[]): boolean {
  return texts.some((t) => {
    const n = normalize(t);
    return HUMAN_PATTERNS.some((re) => re.test(n));
  });
}

export const HANDOFF_REPLY = 'Certo! Já avisei a equipe, que vai continuar o atendimento por aqui em breve.';

export const HANDOFF_SCHEDULING_REPLY =
  'Certo! Passei seu pedido para a equipe, que vai combinar o horário com você por aqui em breve.';

export const HANDOFF_UNAVAILABLE_REPLY =
  'No momento não consigo chamar a equipe por aqui. Posso te ajudar com informações sobre os serviços?';

export const CONTINGENCY_NOTIFIED_REPLY =
  'Desculpe, tive um problema técnico agora. Já avisei a equipe, que vai te responder por aqui em breve.';

export const CONTINGENCY_PLAIN_REPLY =
  'Desculpe, tive um problema técnico agora. Pode tentar de novo em alguns minutos?';
