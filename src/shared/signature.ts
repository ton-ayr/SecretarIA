// Assinatura do webhook da Meta: header X-Hub-Signature-256 = "sha256=" +
// HMAC-SHA256 em hex do corpo BRUTO, com o App Secret como chave.

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

export async function signBody(secret: string, body: ArrayBuffer | Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), body);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparação em tempo constante (não para no primeiro caractere diferente). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyMetaSignature(
  secret: string,
  body: ArrayBuffer | Uint8Array,
  header: string | null | undefined,
): Promise<boolean> {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = await signBody(secret, body);
  return constantTimeEqual(expected, header.slice('sha256='.length).toLowerCase());
}
