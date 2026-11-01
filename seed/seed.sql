-- Dados fictícios para desenvolvimento, simulador e evals.
-- Duas empresas de ramos diferentes para provar isolamento e funcionamento
-- genérico. Pode rodar mais de uma vez (INSERT OR IGNORE).

-- ── Empresa A: barbearia (segmento geral) ───────────────────────────────
INSERT OR IGNORE INTO tenants (id, name, segment, timezone, address, created_at) VALUES
  ('01K6SEED00000000000000TA01', 'Barbearia do Zé', 'general', 'America/Sao_Paulo',
   'Rua das Palmeiras, 120 - Centro, Campinas/SP', '2026-10-01T00:00:00.000Z');

INSERT OR IGNORE INTO phone_numbers (id, tenant_id, meta_phone_number_id, display_phone, created_at) VALUES
  ('01K6SEED00000000000000PA01', '01K6SEED00000000000000TA01', '100000000000001', '+55 19 90000-0001',
   '2026-10-01T00:00:00.000Z');

INSERT OR IGNORE INTO agents (id, tenant_id, phone_number_id, name, tone, instructions, knowledge_base,
                              booking_term, professional_term) VALUES
  ('01K6SEED00000000000000AA01', '01K6SEED00000000000000TA01', '01K6SEED00000000000000PA01',
   'Zeca', 'Descontraído e simpático, sem gírias pesadas.',
   'Chame o cliente pelo primeiro nome quando souber. Se perguntarem por produtos de cabelo, diga que temos pomadas à venda no balcão.',
   'Formas de pagamento: Pix, dinheiro, cartão de débito e crédito.
Estacionamento: vagas na rua em frente.
Crianças: atendemos a partir de 5 anos.
Atraso: tolerância de 10 minutos; depois disso o horário pode ser remarcado.',
   'horário', 'barbeiro');

INSERT OR IGNORE INTO professionals (id, tenant_id, name, title) VALUES
  ('01K6SEED00000000000000RA01', '01K6SEED00000000000000TA01', 'Zé', 'Barbeiro'),
  ('01K6SEED00000000000000RA02', '01K6SEED00000000000000TA01', 'Rafael', 'Barbeiro');

INSERT OR IGNORE INTO services (id, tenant_id, name, description, duration_min, buffer_min, price_mode, price_cents) VALUES
  ('01K6SEED00000000000000SA01', '01K6SEED00000000000000TA01', 'Corte masculino', 'Tesoura e máquina, com lavagem.', 30, 0, 'fixed', 4500),
  ('01K6SEED00000000000000SA02', '01K6SEED00000000000000TA01', 'Barba', 'Barba com toalha quente.', 20, 0, 'fixed', 3000),
  ('01K6SEED00000000000000SA03', '01K6SEED00000000000000TA01', 'Corte + barba', '', 50, 0, 'fixed', 7000),
  ('01K6SEED00000000000000SA04', '01K6SEED00000000000000TA01', 'Pigmentação', 'Valor depende do tamanho da área.', 40, 0, 'from', 6000);

INSERT OR IGNORE INTO professional_services (tenant_id, professional_id, service_id) VALUES
  ('01K6SEED00000000000000TA01', '01K6SEED00000000000000RA01', '01K6SEED00000000000000SA01'),
  ('01K6SEED00000000000000TA01', '01K6SEED00000000000000RA01', '01K6SEED00000000000000SA02'),
  ('01K6SEED00000000000000TA01', '01K6SEED00000000000000RA01', '01K6SEED00000000000000SA03'),
  ('01K6SEED00000000000000TA01', '01K6SEED00000000000000RA01', '01K6SEED00000000000000SA04'),
  ('01K6SEED00000000000000TA01', '01K6SEED00000000000000RA02', '01K6SEED00000000000000SA01'),
  ('01K6SEED00000000000000TA01', '01K6SEED00000000000000RA02', '01K6SEED00000000000000SA02'),
  ('01K6SEED00000000000000TA01', '01K6SEED00000000000000RA02', '01K6SEED00000000000000SA03');

-- Terça a sexta 9h-19h, sábado 8h-17h (horário da casa).
INSERT OR IGNORE INTO business_hours (id, tenant_id, professional_id, weekday, opens_min, closes_min) VALUES
  ('01K6SEED00000000000000HA02', '01K6SEED00000000000000TA01', NULL, 2, 540, 1140),
  ('01K6SEED00000000000000HA03', '01K6SEED00000000000000TA01', NULL, 3, 540, 1140),
  ('01K6SEED00000000000000HA04', '01K6SEED00000000000000TA01', NULL, 4, 540, 1140),
  ('01K6SEED00000000000000HA05', '01K6SEED00000000000000TA01', NULL, 5, 540, 1140),
  ('01K6SEED00000000000000HA06', '01K6SEED00000000000000TA01', NULL, 6, 480, 1020);

-- ── Empresa B: consultório odontológico (segmento saúde) ────────────────
INSERT OR IGNORE INTO tenants (id, name, segment, timezone, address, created_at) VALUES
  ('01K6SEED00000000000000TB01', 'Sorriso Clínica Odontológica', 'health', 'America/Sao_Paulo',
   'Av. Brasil, 2500, sala 34 - Jardim Paulista, São Paulo/SP', '2026-10-01T00:00:00.000Z');

INSERT OR IGNORE INTO phone_numbers (id, tenant_id, meta_phone_number_id, display_phone, created_at) VALUES
  ('01K6SEED00000000000000PB01', '01K6SEED00000000000000TB01', '100000000000002', '+55 11 90000-0002',
   '2026-10-01T00:00:00.000Z');

INSERT OR IGNORE INTO agents (id, tenant_id, phone_number_id, name, tone, instructions, knowledge_base,
                              booking_term, professional_term) VALUES
  ('01K6SEED00000000000000AB01', '01K6SEED00000000000000TB01', '01K6SEED00000000000000PB01',
   'Clara', 'Acolhedor, educado e profissional.',
   'Para quem nunca veio à clínica, sugira primeiro a avaliação.',
   'Convênios aceitos: Amil Dental e OdontoPrev. A cobertura de cada procedimento é confirmada pela equipe.
Pagamento particular: Pix ou cartão em até 3 vezes sem juros.
Estacionamento conveniado no prédio (1 hora grátis).
Chegar 10 minutos antes da primeira consulta para o cadastro.',
   'consulta', 'dentista');

INSERT OR IGNORE INTO professionals (id, tenant_id, name, title) VALUES
  ('01K6SEED00000000000000RB01', '01K6SEED00000000000000TB01', 'Ana Souza', 'Dra.'),
  ('01K6SEED00000000000000RB02', '01K6SEED00000000000000TB01', 'Bruno Lima', 'Dr.');

INSERT OR IGNORE INTO services (id, tenant_id, name, description, duration_min, buffer_min, price_mode, price_cents) VALUES
  ('01K6SEED00000000000000SB01', '01K6SEED00000000000000TB01', 'Avaliação', 'Primeira consulta, com exame clínico.', 30, 10, 'fixed', 0),
  ('01K6SEED00000000000000SB02', '01K6SEED00000000000000TB01', 'Limpeza', 'Profilaxia e remoção de tártaro.', 45, 10, 'fixed', 18000),
  ('01K6SEED00000000000000SB03', '01K6SEED00000000000000TB01', 'Restauração', 'Valor depende do dente e do material.', 45, 10, 'from', 15000),
  ('01K6SEED00000000000000SB04', '01K6SEED00000000000000TB01', 'Clareamento', 'Definido após avaliação.', 60, 10, 'on_request', NULL);

INSERT OR IGNORE INTO professional_services (tenant_id, professional_id, service_id) VALUES
  ('01K6SEED00000000000000TB01', '01K6SEED00000000000000RB01', '01K6SEED00000000000000SB01'),
  ('01K6SEED00000000000000TB01', '01K6SEED00000000000000RB01', '01K6SEED00000000000000SB02'),
  ('01K6SEED00000000000000TB01', '01K6SEED00000000000000RB01', '01K6SEED00000000000000SB03'),
  ('01K6SEED00000000000000TB01', '01K6SEED00000000000000RB01', '01K6SEED00000000000000SB04'),
  ('01K6SEED00000000000000TB01', '01K6SEED00000000000000RB02', '01K6SEED00000000000000SB01'),
  ('01K6SEED00000000000000TB01', '01K6SEED00000000000000RB02', '01K6SEED00000000000000SB03');

-- Segunda a sexta 8h-18h, sábado 8h-12h.
INSERT OR IGNORE INTO business_hours (id, tenant_id, professional_id, weekday, opens_min, closes_min) VALUES
  ('01K6SEED00000000000000HB01', '01K6SEED00000000000000TB01', NULL, 1, 480, 1080),
  ('01K6SEED00000000000000HB02', '01K6SEED00000000000000TB01', NULL, 2, 480, 1080),
  ('01K6SEED00000000000000HB03', '01K6SEED00000000000000TB01', NULL, 3, 480, 1080),
  ('01K6SEED00000000000000HB04', '01K6SEED00000000000000TB01', NULL, 4, 480, 1080),
  ('01K6SEED00000000000000HB05', '01K6SEED00000000000000TB01', NULL, 5, 480, 1080),
  ('01K6SEED00000000000000HB06', '01K6SEED00000000000000TB01', NULL, 6, 480, 720);

-- ── Regras de agenda ────────────────────────────────────────────────────
INSERT OR IGNORE INTO scheduling_rules (tenant_id, slot_step_min, min_advance_min, max_days_ahead, max_options) VALUES
  ('01K6SEED00000000000000TA01', 15, 60, 30, 6),
  ('01K6SEED00000000000000TB01', 30, 120, 60, 6);
