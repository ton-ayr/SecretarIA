-- Fase 3: passagem para humano pelo Telegram.

-- Canais de aviso da empresa (um por pessoa da equipe que recebe avisos).
-- O chat do Telegram fica cifrado (target_enc) e é encontrado por um HMAC
-- (target_ref). O vínculo é feito por um link de uso único (link_code).
CREATE TABLE notification_channels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  kind TEXT NOT NULL DEFAULT 'telegram' CHECK (kind IN ('telegram')),
  label TEXT,
  target_enc TEXT,
  target_ref TEXT,
  link_code TEXT UNIQUE,
  link_expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  linked_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_channels_tenant ON notification_channels(tenant_id, active);
CREATE INDEX idx_channels_ref ON notification_channels(target_ref);

-- Cada mensagem enviada ao Telegram, ligada à conversa de origem. É assim que
-- a resposta do dono ("responder") encontra o cliente certo.
CREATE TABLE telegram_relays (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  chat_ref TEXT NOT NULL,
  tg_message_id INTEGER NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_ref, tg_message_id)
) STRICT;
CREATE INDEX idx_relays_retention ON telegram_relays(tenant_id, created_at);
CREATE INDEX idx_relays_conversation ON telegram_relays(conversation_id);

-- Histórico de passagens para humano (sem texto).
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  reason TEXT NOT NULL,
  channels_notified INTEGER NOT NULL DEFAULT 0,
  notified_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_handoffs_conversation ON handoffs(tenant_id, conversation_id);

-- Configurações do operador (não é tabela de negócio): chat do Telegram para
-- alertas, link de vínculo e controle de repetição de alertas.
CREATE TABLE ops_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
