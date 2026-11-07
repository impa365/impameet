/** Known OpenAI-compatible LLM providers (presets for the Integrações form). */
export interface LlmPreset {
  id: string;
  /** Brand name; empty for the generic preset, whose label is translated where it is shown. */
  name: string;
  icon: string;
  baseUrl: string;
  /** Example model id; empty for the generic preset (translated where it is shown). */
  example: string;
}

export const LLM_PRESETS: readonly LlmPreset[] = [
  { id: 'openai', name: 'OpenAI', icon: '🟢', baseUrl: 'https://api.openai.com/v1', example: 'gpt-4.1-mini' },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    icon: '🌐',
    baseUrl: 'https://openrouter.ai/api/v1',
    example: 'deepseek/deepseek-chat',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: '🔷',
    baseUrl: 'https://api.deepseek.com/v1',
    example: 'deepseek-chat',
  },
  {
    id: 'groq',
    name: 'Groq',
    icon: '⚡',
    baseUrl: 'https://api.groq.com/openai/v1',
    example: 'llama-3.3-70b-versatile',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    icon: '🔵',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    example: 'gemini-2.5-flash',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    icon: '🌪️',
    baseUrl: 'https://api.mistral.ai/v1',
    example: 'mistral-small-latest',
  },
  { id: 'xai', name: 'xAI (Grok)', icon: '🤖', baseUrl: 'https://api.x.ai/v1', example: 'grok-3-mini' },
  {
    id: 'together',
    name: 'Together AI',
    icon: '🤝',
    baseUrl: 'https://api.together.xyz/v1',
    example: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  { id: 'custom', name: '', icon: '🔌', baseUrl: '', example: '' },
];

export function presetFor(baseUrl: string | null): LlmPreset {
  const url = (baseUrl ?? '').replace(/\/+$/, '');
  return LLM_PRESETS.find((p) => p.baseUrl && p.baseUrl === url) ?? LLM_PRESETS[LLM_PRESETS.length - 1];
}

export const FISH_TTS_MODELS = ['s2.1-pro', 's2.1-pro-free', 'drama-3', 's2-pro'] as const;

/** Languages an agent can answer in, each with its own voice. */
export const VOICE_LANGUAGES = ['pt', 'en', 'es'] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

/**
 * Speech providers. An agent picks one for speaking (TTS) and one for listening (STT),
 * in any combination; every model listed here streams over a WebSocket.
 */
export const SPEECH_PROVIDERS = ['fish', 'deepgram', 'elevenlabs'] as const;
export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number];

export interface SpeechProviderInfo {
  name: string;
  icon: string;
  /** TTS models (Deepgram: the voice family; its voices are full model names). */
  ttsModels: readonly string[];
  sttModels: readonly string[];
  /** Example voice per language (providers whose voices are named), shown as a placeholder. */
  voiceExample?: Record<VoiceLanguage, string>;
}

export const SPEECH_CATALOG: Record<SpeechProvider, SpeechProviderInfo> = {
  fish: {
    name: 'Fish Audio',
    icon: '🐟',
    ttsModels: FISH_TTS_MODELS,
    sttModels: ['transcribe-stream-1'],
  },
  deepgram: {
    name: 'Deepgram',
    icon: '🎙️',
    // Flux TTS on /v2/speak (streaming-first), Aura-2 on /v1/speak.
    ttsModels: ['flux', 'aura-2'],
    // Flux: conversational STT on /v2/listen that decides the end of each turn itself.
    sttModels: ['flux-general-multi', 'flux-general-en'],
    voiceExample: { pt: 'flux-bianca-pt', en: 'flux-alexis-en', es: 'flux-valentina-es' },
  },
  elevenlabs: {
    name: 'ElevenLabs',
    icon: '🔊',
    ttsModels: ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'],
    sttModels: ['scribe_v2_realtime'],
  },
};

export const isSpeechProvider = (kind: string): kind is SpeechProvider =>
  (SPEECH_PROVIDERS as readonly string[]).includes(kind);
