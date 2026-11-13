'use client';

/** The part of the Web Speech API the app uses (not in the TypeScript DOM types yet). */
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

export function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

/**
 * Says `text` in `lang` (cutting off anything still being said). `done` runs when it finishes,
 * or at once when nothing can be said, so a conversation can listen right after its question.
 */
export function say(text: string, lang: string, done?: () => void): void {
  if (!canSpeak()) {
    done?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  if (done) {
    let called = false;
    const once = () => {
      if (called) return;
      called = true;
      done();
    };
    utterance.onend = once;
    utterance.onerror = once;
  }
  window.speechSynthesis.speak(utterance);
}

export function hush(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}
