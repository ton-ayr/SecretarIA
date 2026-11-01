// Textos fixos enviados ao cliente sem passar pela IA.
// (Passagem para humano e contingência ficam em handoff.ts.)

export const RATE_LIMIT_REPLY =
  'Recebi muitas mensagens em pouco tempo. Vou dar uma pausa nas respostas e já já continuamos, tudo bem?';

export type MediaNote = 'too_long' | 'failed';

/** Resposta para quando o cliente manda só mídia (sem texto nem transcrição). */
export function fixedMediaReply(items: Array<{ kind: string; mediaNote?: MediaNote }>): string {
  const allAudio = items.every((i) => i.kind === 'audio');
  if (allAudio && items.some((i) => i.mediaNote === 'too_long')) {
    return 'Seu áudio passou de 2 minutos e eu só consigo ouvir áudios mais curtos. Pode me mandar um resumo por escrito?';
  }
  if (allAudio && items.some((i) => i.mediaNote === 'failed')) {
    return 'Não consegui entender seu áudio agora. Pode me escrever o que você precisa?';
  }
  if (allAudio) return 'Ainda não consigo ouvir áudios por aqui. Pode me escrever o que você precisa?';
  return 'Ainda não consigo ver imagens, vídeos ou arquivos por aqui. Pode me escrever o que você precisa?';
}
