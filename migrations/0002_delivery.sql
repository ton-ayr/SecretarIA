-- Fase 2: status de entrega vindos da Meta, medidor de entregas e índices
-- para a limpeza diária (LGPD).

ALTER TABLE messages ADD COLUMN delivered_at TEXT;
ALTER TABLE messages ADD COLUMN failed_code INTEGER;
-- Categoria cobrada pela Meta (utility, marketing, authentication), quando houver.
ALTER TABLE messages ADD COLUMN billed_category TEXT;

ALTER TABLE usage_monthly ADD COLUMN msgs_delivered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_monthly ADD COLUMN msgs_failed INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_contacts_last_seen ON contacts(tenant_id, last_seen_at);
CREATE INDEX idx_turn_logs_started ON turn_logs(started_at);
