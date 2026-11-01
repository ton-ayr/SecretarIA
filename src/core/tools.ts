import type { ToolDef } from '../ports/llm.ts';
import type { Reply } from './engine.ts';
import type { PostJob, SchedulingAction } from './scheduling.ts';

/**
 * Ferramentas que a IA pode chamar. tenant_id, contact_id e conversation_id
 * vêm SEMPRE deste contexto do servidor, nunca dos argumentos da IA.
 */
export interface ToolContext {
  tenantId: string;
  contactId: string;
  conversationId: string;
  turnId: string;
  now: Date;
}

export interface ToolResult {
  ok: boolean;
  /** Conteúdo devolvido à IA (JSON curto ou texto). */
  content: string;
  /** Resposta do servidor ao cliente: encerra o turno sem nova chamada à IA. */
  final?: Reply;
  action?: SchedulingAction;
  /** Trabalhos para depois do envio (agenda Google, aviso à equipe). */
  effects?: PostJob[];
}

export interface Tool {
  def: ToolDef;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Máximo de rodadas de ferramentas por turno (ARQUITETURA §3). */
export const MAX_TOOL_ROUNDS = 3;

export function parseToolArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
