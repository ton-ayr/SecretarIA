// Garante uma única mensagem curta, no formato do WhatsApp.

export interface ProcessedReply {
  text: string;
  truncated: boolean;
}

export function postProcessReply(raw: string, maxChars: number): ProcessedReply {
  let text = raw
    .replace(/\r\n/g, '\n')
    // Negrito do Markdown (**x**) vira negrito do WhatsApp (*x*).
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    // Títulos de Markdown não existem no WhatsApp.
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Alguns modelos devolvem o próprio rótulo ("Atendente: ...").
  text = text.replace(/^(assistente|atendente)\s*:\s*/i, '');

  if (text.length <= maxChars) return { text, truncated: false };

  const slice = text.slice(0, maxChars);
  const lastSentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastSentenceEnd >= maxChars * 0.5) {
    return { text: slice.slice(0, lastSentenceEnd + 1).trim(), truncated: true };
  }
  const lastSpace = slice.lastIndexOf(' ');
  return { text: `${slice.slice(0, lastSpace > 0 ? lastSpace : maxChars - 1).trim()}…`, truncated: true };
}
