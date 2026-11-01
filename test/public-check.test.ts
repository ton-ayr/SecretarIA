import { describe, expect, it } from 'vitest';
import { checkFile, privateTerms } from '../scripts/lib/public-check.ts';

// Tokens montados aqui para este arquivo não parecer um vazamento.
const BEGIN_KEY = '-----BEGIN PRIVATE ' + 'KEY-----';
const END_KEY = '-----END PRIVATE ' + 'KEY-----';
const FAKE = {
  groq: 'gsk_' + 'a'.repeat(30),
  meta: 'EAA' + 'b'.repeat(40),
  telegram: '123456789:AA' + 'c'.repeat(33),
  github: 'ghp_' + 'd'.repeat(36),
  cloudflare: 'cfut_' + 'e'.repeat(40),
  pem: `${BEGIN_KEY}\n${'f'.repeat(64)}`,
};

describe('checkFile', () => {
  it.each(Object.entries(FAKE))('acha %s sem mostrar o valor', (_, token) => {
    const [finding, ...rest] = checkFile('src/a.ts', `// linha 1\nconst x = "${token}";\n`, []);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ file: 'src/a.ts', line: 2 });
    expect(finding!.reason).not.toContain(token);
  });

  it('acha a chave privada de um JSON, com \\n escrito no texto', () => {
    const json = `{"private_key": "${BEGIN_KEY}\\n${'g'.repeat(64)}"}`;
    expect(checkFile('x.json', json, [])).toHaveLength(1);
  });

  it('aceita o PEM montado em tempo de execução pelos testes', () => {
    const line = `\`${BEGIN_KEY}\\n\${btoa(bin)}\\n${END_KEY}\\n\``;
    expect(checkFile('test/x.test.ts', line, [])).toEqual([]);
  });

  it('barra arquivos de segredo pelo nome', () => {
    for (const file of ['.dev.vars', 'a/chave.pem', 'server.key', 'google-service-account-1.json']) {
      expect(checkFile(file, '', [])).toHaveLength(1);
    }
    expect(checkFile('.dev.vars.example', '', [])).toEqual([]);
  });

  it('barra IDs da conta na configuração, mas não em comentários', () => {
    const config = '// PUBLIC_BASE_URL vem do .dev.vars\n{\n  "database_id": "x",\n  "ACCESS_AUD": "y"\n}\n';
    expect(checkFile('wrangler.admin.jsonc', config, []).map((f) => f.line)).toEqual([3, 4]);
    expect(checkFile('docs/guia.md', config, [])).toEqual([]);
  });

  it('acha termo privado sem diferenciar maiúsculas', () => {
    const [finding] = checkFile('docs/a.md', 'um\nConta-Real aqui', [{ label: 'item 1 de PRIVATE_TERMS', value: 'conta-real' }]);
    expect(finding).toEqual({ file: 'docs/a.md', line: 2, reason: 'item 1 de PRIVATE_TERMS' });
  });
});

describe('privateTerms', () => {
  it('junta os valores do .dev.vars e a lista PRIVATE_TERMS', () => {
    const vars = new Map([
      ['GROQ_API_KEY', 'valor-longo'],
      ['WHATSAPP_DRY_RUN', '1'],
      ['ENCRYPTION_KEY', 'troque-esta-chave'],
      ['PRIVATE_TERMS', ' 5519, conta ,'],
      ['VAZIO', ''],
    ]);
    expect(privateTerms(vars)).toEqual([
      { label: 'valor de GROQ_API_KEY do .dev.vars', value: 'valor-longo' },
      { label: 'item 1 de PRIVATE_TERMS', value: '5519' },
      { label: 'item 2 de PRIVATE_TERMS', value: 'conta' },
    ]);
  });
});
