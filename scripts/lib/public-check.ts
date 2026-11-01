// Confere o que vai para o repositório público. Nunca devolve o valor achado:
// só o arquivo, a linha e o motivo.

export interface Finding {
  file: string;
  line: number;
  reason: string;
}

export interface PrivateTerm {
  label: string;
  value: string;
}

const TOKENS: ReadonlyArray<readonly [reason: string, pattern: RegExp]> = [
  ['chave da Groq', /\bgsk_[A-Za-z0-9]{20,}/g],
  ['token da Meta', /\bEAA[A-Za-z0-9]{30,}/g],
  ['token do Telegram', /\b\d{8,12}:AA[A-Za-z0-9_-]{30,}/g],
  ['token do GitHub', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['token da Cloudflare', /\bcf(?:ut|at|k)_[A-Za-z0-9_-]{30,}/g],
  ['chave privada', /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+/]{40,}/g],
];

/** Identificam a conta: ficam no .dev.vars e vão junto no deploy. */
const CONFIG_KEYS = ['database_id', 'account_id', 'WORKERSAI_ACCOUNT_ID', 'PUBLIC_BASE_URL', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'];
const CONFIG_FILE = /^wrangler(\.[a-z]+)?\.jsonc$/;
const SECRET_FILE = /(^|\/)\.dev\.vars$|\.(pem|key)$|service[-_]?account[^/]*\.json$/i;

// Valores curtos (como WHATSAPP_DRY_RUN=1) apareceriam em qualquer arquivo.
const MIN_VALUE_LENGTH = 8;

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Tudo o que está no .dev.vars, mais a lista PRIVATE_TERMS (separada por vírgula). */
export function privateTerms(vars: ReadonlyMap<string, string>): PrivateTerm[] {
  const terms: PrivateTerm[] = [];
  for (const [key, raw] of vars) {
    const value = raw.trim();
    if (key === 'PRIVATE_TERMS') {
      value.split(',').forEach((item, i) => {
        if (item.trim()) terms.push({ label: `item ${i + 1} de PRIVATE_TERMS`, value: item.trim() });
      });
    } else if (value.length >= MIN_VALUE_LENGTH && !value.startsWith('troque-')) {
      terms.push({ label: `valor de ${key} do .dev.vars`, value });
    }
  }
  return terms;
}

export function checkFile(file: string, text: string, terms: readonly PrivateTerm[]): Finding[] {
  const findings: Finding[] = [];
  const add = (index: number, reason: string) => findings.push({ file, line: lineAt(text, index), reason });

  if (SECRET_FILE.test(file)) add(0, 'arquivo de segredo não pode ir para o git');
  for (const [reason, pattern] of TOKENS) {
    for (const match of text.matchAll(pattern)) add(match.index, reason);
  }
  if (CONFIG_FILE.test(file)) {
    for (const key of CONFIG_KEYS) {
      const at = text.indexOf(`"${key}"`);
      if (at >= 0) add(at, `${key} fica no .dev.vars, não na configuração`);
    }
  }
  const lower = text.toLowerCase();
  for (const { label, value } of terms) {
    const at = lower.indexOf(value.toLowerCase());
    if (at >= 0) add(at, label);
  }
  return findings;
}
