-- Fase 1: empresas, números, atendentes, catálogo, contatos, conversas,
-- mensagens, uso e registros de turno.
-- Convenções: IDs ULID (texto), datas UTC ISO 8601, dinheiro em centavos.
-- Toda tabela de negócio tem tenant_id.

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  segment TEXT NOT NULL DEFAULT 'general' CHECK (segment IN ('general', 'health')),
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  reminders_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reminders_enabled IN (0, 1)),
  message_retention_days INTEGER NOT NULL DEFAULT 7,
  contact_retention_days INTEGER NOT NULL DEFAULT 365,
  created_at TEXT NOT NULL
) STRICT;

-- Conta Meta do operador. No futuro (Embedded Signup) terá tenant_id.
CREATE TABLE meta_accounts (
  id TEXT PRIMARY KEY,
  waba_id TEXT NOT NULL UNIQUE,
  access_token_enc TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE phone_numbers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  meta_account_id TEXT REFERENCES meta_accounts(id),
  -- ID do número na Meta (vem no webhook). É a chave de entrada do bot.
  meta_phone_number_id TEXT NOT NULL UNIQUE,
  display_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_phone_numbers_tenant ON phone_numbers(tenant_id);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  phone_number_id TEXT NOT NULL UNIQUE REFERENCES phone_numbers(id),
  name TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  knowledge_base TEXT NOT NULL DEFAULT '' CHECK (length(knowledge_base) <= 4000),
  booking_term TEXT NOT NULL DEFAULT 'horário',
  professional_term TEXT NOT NULL DEFAULT 'profissional',
  history_messages INTEGER NOT NULL DEFAULT 12,
  max_context_tokens INTEGER NOT NULL DEFAULT 2500,
  handoff_resume_hours INTEGER NOT NULL DEFAULT 12,
  max_reply_chars INTEGER NOT NULL DEFAULT 500,
  prompt_version INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX idx_agents_tenant ON agents(tenant_id);

CREATE TABLE professionals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  title TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
) STRICT;
CREATE INDEX idx_professionals_tenant ON professionals(tenant_id);

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  buffer_min INTEGER NOT NULL DEFAULT 0 CHECK (buffer_min >= 0),
  price_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (price_mode IN ('fixed', 'from', 'on_request')),
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  CHECK (price_mode = 'on_request' OR price_cents IS NOT NULL)
) STRICT;
CREATE INDEX idx_services_tenant ON services(tenant_id);

CREATE TABLE professional_services (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  professional_id TEXT NOT NULL REFERENCES professionals(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  PRIMARY KEY (professional_id, service_id)
) STRICT;
CREATE INDEX idx_prof_services_tenant ON professional_services(tenant_id);

-- professional_id NULL = horário da casa. Minutos desde 00:00 no fuso da empresa.
CREATE TABLE business_hours (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  professional_id TEXT REFERENCES professionals(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_min INTEGER NOT NULL CHECK (opens_min BETWEEN 0 AND 1440),
  closes_min INTEGER NOT NULL CHECK (closes_min BETWEEN 0 AND 1440),
  CHECK (closes_min > opens_min)
) STRICT;
CREATE INDEX idx_business_hours_tenant ON business_hours(tenant_id);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  wa_id TEXT NOT NULL,
  profile_name TEXT,
  -- Nome que o cliente informou (o do perfil muitas vezes é apelido).
  display_name TEXT,
  summary TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, wa_id)
) STRICT;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  phone_number_id TEXT NOT NULL REFERENCES phone_numbers(id),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'bot' CHECK (status IN ('bot', 'human')),
  paused_until TEXT,
  last_customer_msg_at TEXT,
  last_human_msg_at TEXT,
  summary TEXT NOT NULL DEFAULT '',
  -- created_at da mensagem mais recente já incluída no resumo.
  summarized_until TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (phone_number_id, contact_id)
) STRICT;
CREATE INDEX idx_conversations_tenant ON conversations(tenant_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  author TEXT NOT NULL CHECK (author IN ('customer', 'bot', 'human')),
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT NOT NULL,
  wa_message_id TEXT UNIQUE,
  turn_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_retention ON messages(tenant_id, created_at);

CREATE TABLE usage_monthly (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  phone_number_id TEXT NOT NULL REFERENCES phone_numbers(id),
  month TEXT NOT NULL,
  msgs_in INTEGER NOT NULL DEFAULT 0,
  replies_out INTEGER NOT NULL DEFAULT 0,
  templates_utility INTEGER NOT NULL DEFAULT 0,
  templates_marketing INTEGER NOT NULL DEFAULT 0,
  templates_auth INTEGER NOT NULL DEFAULT 0,
  llm_requests INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  stt_seconds INTEGER NOT NULL DEFAULT 0,
  est_cost_usd_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (phone_number_id, month)
) STRICT;
CREATE INDEX idx_usage_monthly_tenant ON usage_monthly(tenant_id);

-- Sem texto e sem telefone. Guardados por 30 dias.
CREATE TABLE turn_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  conversation_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  steps_json TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  error_code TEXT
) STRICT;
CREATE INDEX idx_turn_logs_tenant ON turn_logs(tenant_id, started_at);

-- Tabela do operador (não de negócio): soma todas as empresas, porque a
-- cota grátis da IA é da conta.
CREATE TABLE llm_daily_usage (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  day TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  alert_sent_at TEXT,
  PRIMARY KEY (provider, model, day)
) STRICT;
