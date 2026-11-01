// Criptografia simétrica (AES-256-GCM, WebCrypto) para segredos guardados no
// D1, como o token da Meta. Formato: "<iv base64>.<cifrado base64>".
// A chave (ENCRYPTION_KEY) tem 32 bytes em base64 e vive só em secrets.

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(keyB64: string): Promise<CryptoKey> {
  let key = keyCache.get(keyB64);
  if (!key) {
    const raw = fromBase64(keyB64);
    if (raw.length !== 32) throw new Error('ENCRYPTION_KEY precisa ter 32 bytes em base64');
    key = crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    keyCache.set(keyB64, key);
  }
  return key;
}

export async function encryptSecret(keyB64: string, plain: string): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(data))}`;
}

export async function decryptSecret(keyB64: string, sealed: string): Promise<string> {
  const [ivB64, dataB64] = sealed.split('.');
  if (!ivB64 || !dataB64) throw new Error('segredo cifrado em formato inválido');
  const key = await importKey(keyB64);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ivB64) }, key, fromBase64(dataB64));
  return new TextDecoder().decode(plain);
}

/** Gera uma chave nova (32 bytes em base64). */
export function generateKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

const refKeyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Referência estável e não reversível de um valor (ex.: chat do Telegram),
 * para buscar sem guardar o valor em claro. HMAC-SHA256 com uma chave
 * derivada (HKDF) da ENCRYPTION_KEY para cada finalidade (`label`).
 */
export async function keyedRef(keyB64: string, label: string, value: string): Promise<string> {
  const cacheKey = `${label}\u0000${keyB64}`;
  let key = refKeyCache.get(cacheKey);
  if (!key) {
    key = crypto.subtle
      .importKey('raw', fromBase64(keyB64), 'HKDF', false, ['deriveKey'])
      .then((base) =>
        crypto.subtle.deriveKey(
          { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(label) },
          base,
          { name: 'HMAC', hash: 'SHA-256', length: 256 },
          false,
          ['sign'],
        ),
      );
    refKeyCache.set(cacheKey, key);
  }
  const sig = await crypto.subtle.sign('HMAC', await key, new TextEncoder().encode(value));
  return [...new Uint8Array(sig).slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Texto aleatório só com A-Z, a-z e 0-9 (serve em links e no painel da Meta). */
export function randomToken(length = 32): string {
  let out = '';
  while (out.length < length) out += generateKey().replace(/[+/=]/g, '');
  return out.slice(0, length);
}
