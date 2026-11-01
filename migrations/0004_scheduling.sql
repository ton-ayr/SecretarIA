-- Fase 4: agenda própria (D1 é a fonte da verdade), lembretes e sincronização
-- com a agenda Google da empresa.

CREATE TABLE scheduling_rules (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  slot_step_min INTEGER NOT NULL DEFAULT 15 CHECK (slot_step_min BETWEEN 5 AND 120),
  min_advance_min INTEGER NOT NULL DEFAULT 60 CHECK (min_advance_min >= 0),
  max_days_ahead INTEGER NOT NULL DEFAULT 30 CHECK (max_days_ahead BETWEEN 1 AND 365),
  max_options INTEGER NOT NULL DEFAULT 6 CHECK (max_options BETWEEN 1 AND 10)
) STRICT;

-- Folgas e bloqueios. professional_id NULL = a empresa toda.
CREATE TABLE time_off (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  professional_id TEXT REFERENCES professionals(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  reason TEXT,
  CHECK (ends_at > starts_at)
) STRICT;
CREATE INDEX idx_time_off_tenant ON time_off(tenant_id, starts_at);

CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  -- Código curto para o cliente remarcar ou cancelar (ex.: K7Q2XM).
  code TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  conversation_id TEXT REFERENCES conversations(id),
  professional_id TEXT NOT NULL REFERENCES professionals(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  -- Fim do serviço + intervalo (buffer): é o que ocupa a agenda.
  block_ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'confirmed', 'cancelled', 'done', 'no_show')),
  -- Preço no momento da marcação.
  price_mode TEXT NOT NULL,
  price_cents INTEGER,
  customer_name TEXT,
  reminder_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (reminder_opt_in IN (0, 1)),
  reminder_sent_at TEXT,
  -- Link "salvar na agenda" do cliente (/a/<token>).
  calendar_token TEXT NOT NULL UNIQUE,
  -- Sincronização com a agenda Google da empresa.
  calendar_sync TEXT NOT NULL DEFAULT 'none' CHECK (calendar_sync IN ('none', 'pending', 'synced', 'failed')),
  calendar_sync_attempts INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'bot' CHECK (created_by IN ('bot', 'admin')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_at > starts_at AND block_ends_at >= ends_at),
  UNIQUE (tenant_id, code)
) STRICT;
CREATE INDEX idx_appt_professional ON appointments(tenant_id, professional_id, starts_at);
CREATE INDEX idx_appt_contact ON appointments(tenant_id, contact_id, starts_at);
CREATE INDEX idx_appt_reminder ON appointments(reminder_opt_in, reminder_sent_at, starts_at);
CREATE INDEX idx_appt_sync ON appointments(calendar_sync);

-- Agenda Google: da empresa (padrão) e, se houver, de cada profissional.
ALTER TABLE tenants ADD COLUMN google_calendar_id TEXT;
ALTER TABLE professionals ADD COLUMN google_calendar_id TEXT;
