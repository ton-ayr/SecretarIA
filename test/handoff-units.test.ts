import { describe, expect, it } from 'vitest';
import { oggDurationSec } from '../src/core/audio.ts';
import { reasonFromToolArgs, summaryFromToolArgs, wantsHuman } from '../src/core/handoff.ts';
import { DEFAULT_STT_PRICING, estimateSttCostMicros } from '../src/core/pricing.ts';
import { escapeHtml, formatHandoffAlert, formatRelay } from '../src/core/team-messages.ts';
import { fixedMediaReply } from '../src/core/texts.ts';
import { generateKey, keyedRef, randomToken } from '../src/shared/crypto.ts';
import { formatWaId } from '../src/shared/phone.ts';

describe('rede de segurança: pedido de pessoa', () => {
  it.each([
    'quero falar com uma pessoa',
    'Posso falar com um atendente?',
    'QUERO FALAR COM ALGUÉM',
    'me passa pra um humano por favor',
    'chama o dono aí',
    'quero conversar com o gerente',
    'atendimento humano',
    'tem uma pessoa de verdade aí?',
    'não quero falar com robô',
    'cadê o atendente?',
  ])('dispara em "%s"', (text) => {
    expect(wantsHuman([text])).toBe(true);
  });

  it.each([
    'quanto custa o corte?',
    'obrigado pelo atendimento!',
    'a pessoa que me atendeu foi ótima',
    'quero falar sobre o preço',
    'vocês atendem sábado?',
    'quero marcar com o Rafael',
    'falar com vocês é sempre bom',
  ])('não dispara em "%s"', (text) => {
    expect(wantsHuman([text])).toBe(false);
  });

  it('lê motivo e resumo da ferramenta com segurança', () => {
    expect(reasonFromToolArgs({ motivo: 'assunto_sensivel' })).toBe('sensitive');
    expect(reasonFromToolArgs({ motivo: 'agendamento' })).toBe('scheduling');
    expect(reasonFromToolArgs({ motivo: 'inventado' })).toBe('customer_request');
    expect(summaryFromToolArgs({ resumo: '  cobrança   em dobro ' })).toBe('cobrança em dobro');
    expect(summaryFromToolArgs({ resumo: 'x'.repeat(500) })?.length).toBe(300);
    expect(summaryFromToolArgs({})).toBeNull();
  });
});

describe('mensagens para a equipe no Telegram', () => {
  const base = {
    tenantId: 'T',
    tenantName: 'Barbearia <do Zé> & Cia',
    conversationId: 'C',
    waId: '5511999990099',
    contactName: 'Caio <script>',
  };

  it('escapa HTML do Telegram', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('monta o aviso de passagem com motivo, contato, resumo e últimas mensagens', () => {
    const text = formatHandoffAlert({
      ...base,
      reason: 'sensitive',
      summary: 'Cobrança em dobro',
      recentCustomerMessages: ['oi', 'cobraram <duas> vezes'],
    });
    expect(text).toContain('<b>Barbearia &lt;do Zé&gt; &amp; Cia</b> · assunto delicado');
    expect(text).toContain('👤 Caio &lt;script&gt; · +55 11 99999-0099');
    expect(text).toContain('📝 Cobrança em dobro');
    expect(text).toContain('» cobraram &lt;duas&gt; vezes');
    expect(text).toContain('Use <b>Responder</b>');
    expect(text).not.toContain('<script>');
  });

  it('toque em opção chega à equipe só com o título (sem a referência interna)', () => {
    const text = formatRelay({ ...base, messages: ['qua 14/10 · 10:00 (slot|S|P|2026-10-14T13:00:00.000Z)'] });
    expect(text).toContain('qua 14/10 · 10:00');
    expect(text).not.toContain('slot|');
  });

  it('nunca passa de 4.096 caracteres', () => {
    const text = formatRelay({ ...base, messages: Array.from({ length: 40 }, () => 'x'.repeat(800)) });
    expect(text.length).toBeLessThanOrEqual(4096);
  });

  it('formata telefone a partir do wa_id', () => {
    expect(formatWaId('5511999990099')).toBe('+55 11 99999-0099');
    expect(formatWaId('551133334444')).toBe('+55 11 3333-4444');
    expect(formatWaId('15556361310')).toBe('+15556361310');
  });
});

/** Monta uma página OGG mínima (cabeçalho de 27 bytes + tabela de segmentos + dados). */
function oggPage(granule: bigint, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(27 + 1);
  header.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  new DataView(header.buffer).setBigUint64(6, granule, true);
  header[26] = 1; // um segmento
  header[27] = payload.length;
  const page = new Uint8Array(header.length + payload.length);
  page.set(header, 0);
  page.set(payload, header.length);
  return page;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function opusHead(preSkip: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'), 0);
  head[8] = 1;
  head[9] = 1;
  new DataView(head.buffer).setUint16(10, preSkip, true);
  return head;
}

describe('duração de áudio OGG', () => {
  it('calcula a duração de Opus pelo granule da última página', () => {
    const file = concat(
      oggPage(0n, opusHead(312)),
      oggPage(48_000n * 30n, new Uint8Array(50)),
      oggPage(48_000n * 95n + 312n, new Uint8Array(50)),
    );
    expect(oggDurationSec(file)).toBeCloseTo(95, 5);
  });

  it('calcula a duração de Vorbis pela taxa do cabeçalho', () => {
    const id = new Uint8Array(30);
    id[0] = 1;
    id.set(new TextEncoder().encode('vorbis'), 1);
    new DataView(id.buffer).setUint32(12, 44_100, true);
    const file = concat(oggPage(0n, id), oggPage(44_100n * 150n, new Uint8Array(10)));
    expect(oggDurationSec(file)).toBeCloseTo(150, 5);
  });

  it('devolve null para outros formatos ou arquivo estranho', () => {
    expect(oggDurationSec(new TextEncoder().encode('ID3 mp3 qualquer coisa aqui...'))).toBeNull();
    expect(oggDurationSec(new Uint8Array(5))).toBeNull();
    expect(oggDurationSec(oggPage(0n, new TextEncoder().encode('desconhecido')))).toBeNull();
  });
});

describe('respostas fixas de mídia', () => {
  it('diferencia áudio longo, falha e mídia sem texto', () => {
    expect(fixedMediaReply([{ kind: 'audio', mediaNote: 'too_long' }])).toContain('2 minutos');
    expect(fixedMediaReply([{ kind: 'audio', mediaNote: 'failed' }])).toContain('Não consegui entender');
    expect(fixedMediaReply([{ kind: 'audio' }])).toContain('ouvir áudios');
    expect(fixedMediaReply([{ kind: 'image' }])).toContain('imagens');
  });
});

describe('referência cifrada e tokens', () => {
  it('é estável, depende da chave e da finalidade', async () => {
    const key = generateKey();
    const a = await keyedRef(key, 'telegram-chat', '12345');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await keyedRef(key, 'telegram-chat', '12345')).toBe(a);
    expect(await keyedRef(key, 'outra-coisa', '12345')).not.toBe(a);
    expect(await keyedRef(generateKey(), 'telegram-chat', '12345')).not.toBe(a);
  });

  it('gera tokens só com letras e números', () => {
    const t = randomToken(40);
    expect(t).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(randomToken()).not.toBe(randomToken());
  });
});

describe('custo da transcrição', () => {
  it('Groq cobra no mínimo 10 s; Workers AI por minuto', () => {
    // 5 s na Groq = cobrados 10 s = US$ 0,04/h × 10/3600 = 111 micro-dólares
    expect(estimateSttCostMicros(DEFAULT_STT_PRICING, 'groq', 'whisper-large-v3-turbo', 5)).toBe(111);
    expect(estimateSttCostMicros(DEFAULT_STT_PRICING, 'workersai', '@cf/openai/whisper-large-v3-turbo', 60)).toBe(513);
    expect(estimateSttCostMicros(DEFAULT_STT_PRICING, 'x', 'y', 60)).toBe(0);
  });
});
