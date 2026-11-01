-- Fase 5: painel administrativo.

-- Número "simulador" de cada empresa: é por ele que o chat de teste do painel
-- conversa com o atendente. Nunca recebe nem envia pelo WhatsApp (o webhook
-- só traz IDs numéricos da Meta, e o cron de lembretes ignora esse tipo).
ALTER TABLE phone_numbers ADD COLUMN kind TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (kind IN ('whatsapp', 'test'));

-- Pedidos de exclusão dos dados de um contato (LGPD) feitos pelo terminal
-- (npm run lgpd:apagar). O bot executa no cron e apaga o pedido. O botão do
-- painel executa na hora, sem passar por aqui.
CREATE TABLE erasure_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  wa_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  UNIQUE (tenant_id, wa_id)
) STRICT;
