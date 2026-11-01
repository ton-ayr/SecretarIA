// Interface única para qualquer provedor de IA (Groq, Workers AI, falso).

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema dos argumentos. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON em texto, como veio do provedor. */
  arguments: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Uma tentativa feita pela cadeia de reserva (sem texto, só metadados). */
export interface LLMAttempt {
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  errorKind?: LLMErrorKind;
  status?: number;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: LLMUsage;
  provider: string;
  model: string;
  attempts: LLMAttempt[];
}

export interface LLMProvider {
  readonly provider: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export type LLMErrorKind = 'timeout' | 'rate_limit' | 'server' | 'client' | 'network' | 'invalid_response';

export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterSec?: number,
    readonly attempts: LLMAttempt[] = [],
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
