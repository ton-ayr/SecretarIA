// ULID: 48 bits de tempo + 80 bits aleatórios, em Base32 de Crockford.
// Monotônico dentro do processo: IDs gerados no mesmo milissegundo (ou com
// relógio menor) saem em ordem crescente. Isso mantém a ordem de mensagens
// que chegam juntas.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function freshRandom(): number[] {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b % 32);
}

/** Soma 1 na parte aleatória (base 32). */
function increment(random: number[]): number[] {
  const next = [...random];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i]! += 1;
      return next;
    }
    next[i] = 0;
  }
  return freshRandom();
}

export function ulid(nowMs: number = Date.now()): string {
  if (nowMs <= lastTime) {
    lastRandom = increment(lastRandom);
  } else {
    lastTime = nowMs;
    lastRandom = freshRandom();
  }
  return encodeTime(lastTime) + lastRandom.map((d) => ALPHABET[d]).join('');
}
