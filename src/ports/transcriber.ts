// Transcrição de áudio (Groq Whisper, com Workers AI de reserva).

export interface Transcription {
  text: string;
  /** Duração do áudio em segundos, quando o provedor informa. */
  durationSec: number | null;
  provider: string;
  model: string;
}

export interface Transcriber {
  transcribe(audio: Uint8Array, mime: string, opts: { language: string; timeoutMs: number }): Promise<Transcription>;
}

/** Download de mídia recebida (áudio do cliente). */
export interface MediaFetcher {
  /** `from` é o phone_number_id da Meta que recebeu a mídia. */
  download(from: string, mediaId: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string }>;
}
