-- Desde 01/10/2026 a Meta cobra também as mensagens de serviço (respostas
-- livres dentro da janela de 24 h). O medidor passa a contá-las quando o
-- status da Meta vier com pricing.billable = true e categoria "service".
-- (ARQUITETURA §16, verificação de 2026-10-03.)

ALTER TABLE usage_monthly ADD COLUMN service_billed INTEGER NOT NULL DEFAULT 0;
