// contact_ref: HMAC-SHA256 do wa_id. Permite seguir a mesma pessoa nos logs
// sem saber quem ela é. HMAC é barato (bem abaixo de 1 ms de CPU).

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    keyCache.set(secret, key);
  }
  return key;
}

export async function contactRef(secret: string, tenantId: string, waId: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${tenantId}:${waId}`));
  return [...new Uint8Array(sig).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
