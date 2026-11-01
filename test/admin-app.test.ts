import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryDb, SEED, type LocalPlatform } from '../scripts/lib/memory-db.ts';
import { adminApp } from './helpers/admin.ts';

let mem: LocalPlatform;
beforeAll(async () => {
  mem = await createMemoryDb({ seed: true });
});
afterAll(() => mem.dispose());

describe('painel: acesso e proteções', () => {
  it('sem passar pelo Access: 403, mesmo indo direto ao Worker', async () => {
    const { get, logger } = adminApp(mem.db, { email: null });
    const res = await get('/');
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Acesso negado: o pedido não chegou pelo Cloudflare Access (sem identidade).');
    expect(logger.lines.at(-1)).toMatchObject({ event: 'admin_forbidden', reason: 'no_access' });
  });

  it('e-mail fora da lista: 403, e o e-mail não vai para o log', async () => {
    const { get, logger } = adminApp(mem.db, { email: 'intruso@exemplo.com' });
    const res = await get('/');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('intruso@exemplo.com não está na lista');
    expect(JSON.stringify(logger.lines)).not.toContain('intruso');
  });

  it('operador entra; e-mail com maiúsculas também vale', async () => {
    const res = await adminApp(mem.db, { email: 'Operador@Exemplo.dev' }).get('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Barbearia do Zé');
    expect(html).toContain('Sorriso Clínica Odontológica');
  });

  it('cabeçalhos de segurança em toda resposta', async () => {
    const res = await adminApp(mem.db).get('/');
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('POST sem Origin ou de outro site: 403 (CSRF)', async () => {
    const { post } = adminApp(mem.db);
    const form = { name: 'X', segment: 'general', timezone: 'America/Sao_Paulo', agentName: 'Y' };
    expect((await post('/empresas', form, null)).status).toBe(403);
    expect((await post('/empresas', form, 'https://malicioso.example')).status).toBe(403);
    const n = await mem.db.prepare("SELECT COUNT(*) AS n FROM tenants WHERE name = 'X'").first();
    expect(n).toEqual({ n: 0 });
  });

  it('empresa inexistente ou id estranho: 404', async () => {
    const { get } = adminApp(mem.db);
    expect((await get('/empresas/01K6NAOEXISTE0000000000000')).status).toBe(404);
    expect((await get('/empresas/..%2F..%2Fetc')).status).toBe(404);
  });
});

describe('lista de e-mails do painel (ADMIN_EMAILS)', () => {
  it('normaliza e descarta o que não é e-mail; vazio = ninguém entra', async () => {
    const { parseEmails } = await import('../src/admin/index.ts');
    expect(parseEmails(' Ana@Exemplo.dev, ,bob@x.com, não-é-email ')).toEqual(['ana@exemplo.dev', 'bob@x.com']);
    expect(parseEmails(undefined)).toEqual([]);
    expect(parseEmails('')).toEqual([]);
  });
});

describe('painel: cadastro da empresa', () => {
  it('cria empresa nova e cai na lista de configuração', async () => {
    const { post, get } = adminApp(mem.db);
    const res = await post('/empresas', {
      name: 'Cartas da Luna',
      segment: 'general',
      timezone: 'America/Sao_Paulo',
      address: 'Atendimento online',
      agentName: 'Luna',
    });
    expect(res.status).toBe(303);
    const location = res.headers.get('location')!;
    expect(location).toMatch(/^\/empresas\/[0-9A-Z]{26}\?ok=created$/);
    const page = await (await get(location)).text();
    expect(page).toContain('Empresa criada');
    expect(page).toContain('0 de 7 passos feitos');
    expect(page).toContain('Número do WhatsApp');
  });

  it('erro de validação devolve o formulário com os campos marcados', async () => {
    const res = await adminApp(mem.db).post('/empresas', { name: '', segment: 'pet', timezone: 'America/Sao_Paulo', agentName: 'Luna' });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('Informe o nome da empresa.');
    expect(html).toContain('Escolha o segmento.');
    expect(html).toContain('value="Luna"');
  });

  it('nome com HTML é mostrado como texto (sem script)', async () => {
    const { post, get } = adminApp(mem.db);
    const res = await post('/empresas', { name: '<script>alert(1)</script>', segment: 'general', timezone: 'America/Sao_Paulo', agentName: 'x' });
    const html = await (await get(res.headers.get('location')!)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('edita dados e atendente da empresa', async () => {
    const { post, get } = adminApp(mem.db);
    const id = SEED.dental.tenantId;
    const saved = await post(`/empresas/${id}/dados`, {
      name: 'Sorriso Clínica Odontológica',
      segment: 'health',
      timezone: 'America/Sao_Paulo',
      address: 'Av. Brasil, 2500',
      status: 'active',
      remindersEnabled: '1',
      messageRetentionDays: '7',
      contactRetentionDays: '365',
    });
    expect(saved.headers.get('location')).toBe(`/empresas/${id}/dados?ok=saved`);
    const page = await (await get(`/empresas/${id}/dados?ok=saved`)).text();
    expect(page).toContain('Salvo.');
    expect(page).toMatch(/name="remindersEnabled" value="1" checked/);

    const agent = await post(`/empresas/${id}/atendente`, {
      name: 'Bia',
      tone: 'Acolhedor.',
      instructions: 'Nunca fale de preços de clareamento.',
      knowledgeBase: 'Aceitamos convênio X.',
      bookingTerm: 'consulta',
      professionalTerm: 'dentista',
      maxReplyChars: '500',
      handoffResumeHours: '12',
    });
    expect(agent.status).toBe(303);
    const row = await mem.db.prepare('SELECT name, knowledge_base FROM agents WHERE tenant_id = ?').bind(id).first();
    expect(row).toEqual({ name: 'Bia', knowledge_base: 'Aceitamos convênio X.' });
  });

  it('conta Meta: token vai para o bot e nunca volta para a tela', async () => {
    const { post, get, bot } = adminApp(mem.db);
    const token = `EAAG${'x'.repeat(60)}`;
    const res = await post('/meta', { wabaId: '100000000000010', token });
    expect(res.status).toBe(303);
    expect(bot.calls).toEqual([['saveMetaAccount', '100000000000010', token.length]]);
    const html = await (await get('/meta?ok=token-saved')).text();
    expect(html).toContain('Token gravado');
    expect(html).not.toContain(token);
  });

  it('home mostra uso do mês e a cota da IA', async () => {
    await mem.db
      .prepare("INSERT INTO llm_daily_usage (provider, model, day, requests, tokens) VALUES ('groq', 'openai/gpt-oss-120b', '2026-10-13', 12, 3400)")
      .run();
    const html = await (await adminApp(mem.db).get('/')).text();
    expect(html).toContain('groq:openai/gpt-oss-120b');
    expect(html).toContain('3.400');
    expect(html).toContain('Uso por número em 10/2026');
  });
});
