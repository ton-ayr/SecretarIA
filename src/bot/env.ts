import type { ConversationDO } from './conversation-do.ts';
import type { TestChatDO } from './test-chat-do.ts';

/** Bindings, variáveis (wrangler.jsonc) e segredos (wrangler secret) do Worker bot. */
export interface Env {
  DB: D1Database;
  CONVERSATION: DurableObjectNamespace<ConversationDO>;
  TEST_CHAT: DurableObjectNamespace<TestChatDO>;

  // vars
  LLM_CHAIN: string;
  GROQ_BASE_URL: string;
  WORKERSAI_BASE_URL: string;
  WORKERSAI_ACCOUNT_ID: string;
  LLM_DAILY_LIMITS: string;
  GRAPH_API_VERSION: string;
  GROUPING_DEBOUNCE_MS?: string;
  GROUPING_MAX_WAIT_MS?: string;
  RATE_LIMIT_PER_HOUR?: string;
  /** Cadeia de transcrição: provedor:modelo, separados por vírgula. */
  STT_CHAIN?: string;
  /** "1" = não chama a Meta; mostra as respostas no terminal (wrangler dev). */
  WHATSAPP_DRY_RUN?: string;
  /** Endereço público do Worker (links "salvar na agenda"). Sem ele, o bot não marca. */
  PUBLIC_BASE_URL?: string;
  /** Template aprovado de lembrete fora da janela (cobrado). Vazio = desligado. */
  REMINDER_TEMPLATE?: string;
  /** Alerta ao operador quando um número passa disso em mensagens de serviço cobradas no mês. */
  META_BILLED_ALERT?: string;

  // secrets
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
  ENCRYPTION_KEY?: string;
  GROQ_API_KEY?: string;
  WORKERSAI_API_KEY?: string;
  LOG_HASH_KEY?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Chave JSON da conta de serviço do Google (em base64). */
  GOOGLE_SERVICE_ACCOUNT?: string;
}
