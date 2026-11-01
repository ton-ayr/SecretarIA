/**
 * Validação do token do Cloudflare Access (cabeçalho Cf-Access-Jwt-Assertion),
 * como na documentação (ARQUITETURA §16): RS256 com as chaves públicas da
 * equipe (/cdn-cgi/access/certs), emissor = https://<equipe>.cloudflareaccess.com,
 * audiência = AUD da aplicação e prazo válido. Usado quando `ctx.access` não vem
 * preenchido pelo runtime.
 */

export interface AccessJwtConfig {
  /** Ex.: minha-equipe.cloudflareaccess.com */
  teamDomain: string;
  /** Tag AUD da aplicação do Access. */
  aud: string;
  now: () => number;
  fetchFn?: typeof fetch;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

const KEYS_TTL_MS = 60 * 60 * 1000;
let keyCache: { domain: string; exp: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart<T>(part: string): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as T;
  } catch {
    return null;
  }
}

/** Lê a audiência do token SEM validar (só para diagnóstico de configuração). */
export function unverifiedAudience(token: string): string[] {
  const payload = decodePart<{ aud?: string | string[] }>(token.split('.')[1] ?? '');
  if (!payload?.aud) return [];
  return Array.isArray(payload.aud) ? payload.aud : [payload.aud];
}

async function loadKeys(cfg: AccessJwtConfig, force: boolean): Promise<Map<string, CryptoKey>> {
  const now = cfg.now();
  if (!force && keyCache && keyCache.domain === cfg.teamDomain && keyCache.exp > now) return keyCache.keys;
  const fetchFn = cfg.fetchFn ?? ((input, init) => fetch(input, init));
  const res = await fetchFn(`https://${cfg.teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`certs HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys ?? []) {
    if (k.kty !== 'RSA' || !k.kid) continue;
    keys.set(
      k.kid,
      await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
    );
  }
  keyCache = { domain: cfg.teamDomain, exp: now + KEYS_TTL_MS, keys };
  return keys;
}

/** E-mail do token válido; null se qualquer conferência falhar. */
export async function verifyAccessJwt(token: string, cfg: AccessJwtConfig): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || !cfg.teamDomain || !cfg.aud) return null;
  const header = decodePart<{ alg?: string; kid?: string }>(parts[0]!);
  const payload = decodePart<{ aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string }>(parts[1]!);
  if (!header || !payload || header.alg !== 'RS256' || !header.kid) return null;

  let keys = await loadKeys(cfg, false);
  // Chave nova (a Cloudflare troca a cada 6 semanas): busca de novo uma vez.
  if (!keys.has(header.kid)) keys = await loadKeys(cfg, true);
  const key = keys.get(header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]!),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) return null;

  const nowSec = Math.floor(cfg.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!auds.includes(cfg.aud)) return null;
  if (payload.iss !== `https://${cfg.teamDomain}`) return null;
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) return null;
  return typeof payload.email === 'string' && payload.email ? payload.email : null;
}

/** Só para testes: limpa o cache de chaves. */
export function resetAccessKeyCache(): void {
  keyCache = null;
}
