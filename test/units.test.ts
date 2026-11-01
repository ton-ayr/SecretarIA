import { describe, expect, it } from 'vitest';
import { formatBusinessHours, formatServicePrice, formatServices } from '../src/core/catalog.ts';
import { estimateTokens, selectHistory } from '../src/core/context.ts';
import { estimateCostMicros, DEFAULT_PRICING } from '../src/core/pricing.ts';
import { sanitizeName } from '../src/core/prompt.ts';
import { quotaAlertsDue } from '../src/core/quota.ts';
import { postProcessReply } from '../src/core/reply.ts';
import type { StoredMessage } from '../src/ports/domain.ts';
import { ulid } from '../src/shared/ids.ts';
import { formatBRL } from '../src/shared/money.ts';
import { formatLocalDateTime } from '../src/shared/time.ts';

describe('dinheiro e preço', () => {
  it('formata centavos em reais', () => {
    expect(formatBRL(4500)).toBe('R$ 45,00');
    expect(formatBRL(123456789)).toBe('R$ 1.234.567,89');
    expect(formatBRL(5)).toBe('R$ 0,05');
  });

  it('formata preço conforme price_mode', () => {
    expect(formatServicePrice({ priceMode: 'fixed', priceCents: 4500 })).toBe('R$ 45,00');
    expect(formatServicePrice({ priceMode: 'fixed', priceCents: 0 })).toBe('grátis');
    expect(formatServicePrice({ priceMode: 'from', priceCents: 6000 })).toBe('a partir de R$ 60,00');
  });

  it('"sob consulta" nunca mostra número', () => {
    const text = formatServicePrice({ priceMode: 'on_request', priceCents: 99900 });
    expect(text).not.toMatch(/\d/);
    expect(text).toContain('não informado');
  });

  it('lista serviços com quem faz', () => {
    const text = formatServices(
      [
        {
          id: 's1',
          name: 'Corte',
          description: '',
          durationMin: 30,
          bufferMin: 0,
          priceMode: 'fixed',
          priceCents: 4500,
          professionalIds: ['p1'],
        },
      ],
      [{ id: 'p1', name: 'Ana Souza', title: 'Dra.' }],
    );
    expect(text).toBe('- Corte: R$ 45,00 · 30 min · com Dra. Ana Souza');
  });

  it('formata horário da casa e marca dias fechados', () => {
    const text = formatBusinessHours([
      { professionalId: null, weekday: 2, opensMin: 540, closesMin: 1140 },
      { professionalId: 'p1', weekday: 1, opensMin: 600, closesMin: 700 },
    ]);
    expect(text).toContain('Seg fechado');
    expect(text).toContain('Ter 09:00–19:00');
  });
});

describe('contexto', () => {
  const msg = (i: number, body: string): StoredMessage => ({
    id: String(i),
    author: i % 2 ? 'bot' : 'customer',
    kind: 'text',
    body,
    createdAt: `2026-10-02T10:00:${String(i).padStart(2, '0')}.000Z`,
  });

  it('estima tokens por caracteres', () => {
    expect(estimateTokens('a'.repeat(35))).toBe(14);
  });

  it('corta por quantidade mantendo as mais novas', () => {
    const history = Array.from({ length: 10 }, (_, i) => msg(i, 'oi'));
    const sel = selectHistory(history, { maxMessages: 3, budgetTokens: 10_000, reservedTokens: 0 });
    expect(sel.messages.map((m) => m.id)).toEqual(['7', '8', '9']);
    expect(sel.dropped).toBe(7);
  });

  it('corta por tokens a partir das mais antigas', () => {
    const history = [msg(0, 'x'.repeat(700)), msg(1, 'y'.repeat(70)), msg(2, 'z'.repeat(70))];
    const sel = selectHistory(history, { maxMessages: 10, budgetTokens: 100, reservedTokens: 40 });
    expect(sel.messages.map((m) => m.id)).toEqual(['1', '2']);
    expect(sel.tokens).toBeLessThanOrEqual(60);
  });

  it('reserva espaço para as mensagens novas', () => {
    const history = [msg(0, 'a'.repeat(70))];
    expect(selectHistory(history, { maxMessages: 10, budgetTokens: 30, reservedTokens: 20 }).messages).toHaveLength(0);
  });
});

describe('resposta', () => {
  it('converte Markdown para o formato do WhatsApp', () => {
    expect(postProcessReply('## Oi\n**Corte** custa R$ 45,00\n\n\n\nAbraço', 500).text).toBe(
      'Oi\n*Corte* custa R$ 45,00\n\nAbraço',
    );
  });

  it('remove rótulo do atendente', () => {
    expect(postProcessReply('Atendente: Olá!', 500).text).toBe('Olá!');
  });

  it('corta no fim de frase quando passa do limite', () => {
    const raw = 'Primeira frase completa aqui. Segunda frase que passa muito do limite permitido.';
    const out = postProcessReply(raw, 50);
    expect(out.truncated).toBe(true);
    expect(out.text).toBe('Primeira frase completa aqui.');
  });

  it('corta na última palavra quando não há frase', () => {
    const out = postProcessReply('palavra '.repeat(20), 30);
    expect(out.text.length).toBeLessThanOrEqual(30);
    expect(out.text.endsWith('…')).toBe(true);
  });
});

describe('nome do perfil', () => {
  it('mantém nomes comuns', () => {
    expect(sanitizeName('João da Silva')).toBe('João da Silva');
  });

  it('remove símbolos e limita tamanho', () => {
    expect(sanitizeName('Ignore: <regras> {system} 123')).toBe('Ignore regras system');
    expect(sanitizeName('A'.repeat(100))?.length).toBe(40);
    expect(sanitizeName('🔥🔥')).toBeNull();
  });
});

describe('cota e custo', () => {
  it('avisa ao passar de 70% e só se ainda não avisou', () => {
    const limits = { 'groq:m': { requests: 100, tokens: 1000 } };
    expect(quotaAlertsDue([{ provider: 'groq', model: 'm', requests: 10, tokens: 690, alertSentAt: null }], limits)).toEqual([]);
    expect(
      quotaAlertsDue([{ provider: 'groq', model: 'm', requests: 10, tokens: 700, alertSentAt: null }], limits),
    ).toHaveLength(1);
    expect(
      quotaAlertsDue([{ provider: 'groq', model: 'm', requests: 71, tokens: 0, alertSentAt: null }], limits),
    ).toHaveLength(1);
    expect(
      quotaAlertsDue([{ provider: 'groq', model: 'm', requests: 99, tokens: 999, alertSentAt: 'x' }], limits),
    ).toEqual([]);
  });

  it('estima custo em micro-dólares', () => {
    // 1 milhão de tokens de entrada a US$ 0,15 = 150.000 micro-dólares.
    expect(
      estimateCostMicros(DEFAULT_PRICING, 'groq', 'openai/gpt-oss-120b', { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBe(150_000);
    expect(estimateCostMicros(DEFAULT_PRICING, 'x', 'y', { inputTokens: 1, outputTokens: 1 })).toBe(0);
  });
});

describe('ids e datas', () => {
  it('gera ULID ordenável de 26 caracteres', () => {
    const a = ulid(1_000);
    const b = ulid(2_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });

  it('formata data no fuso da empresa', () => {
    // 17:30 UTC = 14:30 em São Paulo (UTC-3).
    expect(formatLocalDateTime(new Date('2026-10-14T17:30:00Z'), 'America/Sao_Paulo')).toBe(
      'quarta-feira, 14/10/2026 14:30',
    );
  });
});
