import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAccessKeyCache, unverifiedAudience, verifyAccessJwt } from '../src/admin/access-jwt.ts';

const TEAM = 'equipe-teste.cloudflareaccess.com';
const AUD = 'aud-do-painel';
const NOW = Date.parse('2026-10-07T00:00:00.000Z');
const nowSec = NOW / 1000;

let pair: CryptoKeyPair;
let other: CryptoKeyPair;
let certFetches = 0;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function sign(payload: Record<string, unknown>, opts: { key?: CryptoKey; kid?: string; alg?: string } = {}) {
  const head = enc({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' });
  const body = enc(payload);
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? pair.privateKey, new TextEncoder().encode(`${head}.${body}`)),
  );
  return `${head}.${body}.${b64url(sig)}`;
}

const good = () => ({ aud: [AUD], iss: `https://${TEAM}`, exp: nowSec + 3600, iat: nowSec, email: 'operador@exemplo.com' });

const fetchFn = (async (url: RequestInfo | URL) => {
  expect(String(url)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  certFetches++;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return Response.json({ keys: [{ kid: 'k1', kty: 'RSA', n: jwk.n, e: jwk.e }] });
}) as typeof fetch;

const cfg = { teamDomain: TEAM, aud: AUD, now: () => NOW, fetchFn };

beforeAll(async () => {
  const params = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  pair = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
  other = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
});
beforeEach(() => {
  resetAccessKeyCache();
  certFetches = 0;
});

describe('token do Cloudflare Access', () => {
  it('token válido devolve o e-mail; chaves ficam em cache', async () => {
    expect(await verifyAccessJwt(await sign(good()), cfg)).toBe('operador@exemplo.com');
    expect(await verifyAccessJwt(await sign(good()), cfg)).toBe('operador@exemplo.com');
    expect(certFetches).toBe(1);
  });

  it('recusa assinatura de outra chave, outra audiência, outro emissor, vencido e alg trocado', async () => {
    expect(await verifyAccessJwt(await sign(good(), { key: other.privateKey }), cfg)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good(), aud: ['outra-app'] }), cfg)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good(), iss: 'https://outra.cloudflareaccess.com' }), cfg)).toBeNull();
    expect(await verifyAccessJwt(await sign({ ...good(), exp: nowSec - 1 }), cfg)).toBeNull();
    expect(await verifyAccessJwt(await sign(good(), { alg: 'HS256' }), cfg)).toBeNull();
    expect(await verifyAccessJwt('nao.e.jwt', cfg)).toBeNull();
    expect(await verifyAccessJwt(await sign(good()), { ...cfg, aud: '' })).toBeNull();
  });

  it('chave desconhecida: busca as chaves de novo uma vez e recusa', async () => {
    expect(await verifyAccessJwt(await sign(good(), { kid: 'nova' }), cfg)).toBeNull();
    expect(certFetches).toBe(2);
  });

  it('audiência sem validar, só para diagnóstico', async () => {
    expect(unverifiedAudience(await sign(good()))).toEqual([AUD]);
    expect(unverifiedAudience('lixo')).toEqual([]);
  });
});
