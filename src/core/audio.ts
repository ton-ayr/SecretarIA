// Duração de áudio OGG (Opus ou Vorbis) lida do próprio arquivo, sem
// decodificar: o "granule position" da última página dividido pela taxa.
// Mensagens de voz do WhatsApp são OGG/Opus. Outros formatos: null.

export const MAX_AUDIO_SECONDS = 120;
/** Teto de download (o limite da Meta para áudio é 16 MB). */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const OGGS = [0x4f, 0x67, 0x67, 0x53]; // "OggS"

function isOggsAt(b: Uint8Array, i: number): boolean {
  return b[i] === OGGS[0] && b[i + 1] === OGGS[1] && b[i + 2] === OGGS[2] && b[i + 3] === OGGS[3];
}

function asciiAt(b: Uint8Array, i: number, text: string): boolean {
  for (let k = 0; k < text.length; k++) if (b[i + k] !== text.charCodeAt(k)) return false;
  return true;
}

const u16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

export function oggDurationSec(b: Uint8Array): number | null {
  if (b.length < 28 || !isOggsAt(b, 0)) return null;
  // Primeiro pacote, logo depois do cabeçalho da página 0.
  const dataStart = 27 + b[26]!;
  let rate: number;
  let preSkip = 0;
  if (asciiAt(b, dataStart, 'OpusHead')) {
    rate = 48_000; // Opus sempre conta o granule a 48 kHz
    preSkip = u16(b, dataStart + 10);
  } else if (b[dataStart] === 1 && asciiAt(b, dataStart + 1, 'vorbis')) {
    rate = u32(b, dataStart + 12);
  } else {
    return null;
  }
  if (!rate) return null;

  // Última página: procura "OggS" de trás para frente.
  for (let i = b.length - 27; i >= 0; i--) {
    if (!isOggsAt(b, i)) continue;
    const lo = u32(b, i + 6);
    const hi = u32(b, i + 10);
    if (hi === 0xffffffff && lo === 0xffffffff) continue; // página sem granule
    const granule = hi * 2 ** 32 + lo;
    return Math.max(0, (granule - preSkip) / rate);
  }
  return null;
}
