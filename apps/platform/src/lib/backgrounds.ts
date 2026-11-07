import type { MessageKey } from '@/i18n/keys';

/** Camera background effects (blur / virtual background), all assets served by this server. */

export const BACKGROUND_ASSETS = {
  tasksVisionFileSet: '/mediapipe/wasm',
  modelAssetPath: '/mediapipe/selfie_segmenter.tflite',
} as const;

export const BACKGROUND_STORAGE_KEY = 'impa-meet-background';

export interface BackgroundChoice {
  id: string;
  labelKey: MessageKey;
  mode: 'disabled' | 'background-blur' | 'virtual-background';
  blurRadius?: number;
  imagePath?: string;
}

export const BACKGROUNDS: readonly BackgroundChoice[] = [
  { id: 'none', labelKey: 'room.backgrounds.none', mode: 'disabled' },
  { id: 'blur-light', labelKey: 'room.backgrounds.blurLight', mode: 'background-blur', blurRadius: 6 },
  { id: 'blur', labelKey: 'room.backgrounds.blur', mode: 'background-blur', blurRadius: 16 },
  {
    id: 'azul',
    labelKey: 'room.backgrounds.blue',
    mode: 'virtual-background',
    imagePath: '/backgrounds/azul.jpg',
  },
  {
    id: 'verde',
    labelKey: 'room.backgrounds.green',
    mode: 'virtual-background',
    imagePath: '/backgrounds/verde.jpg',
  },
  {
    id: 'grafite',
    labelKey: 'room.backgrounds.graphite',
    mode: 'virtual-background',
    imagePath: '/backgrounds/grafite.jpg',
  },
];

export function findBackground(id: string | null | undefined): BackgroundChoice {
  return BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS[0];
}

export type SwitchOptions =
  | { mode: 'disabled' }
  | { mode: 'background-blur'; blurRadius: number }
  | { mode: 'virtual-background'; imagePath: string };

export function switchOptions(choice: BackgroundChoice): SwitchOptions {
  if (choice.mode === 'background-blur') return { mode: choice.mode, blurRadius: choice.blurRadius ?? 10 };
  if (choice.mode === 'virtual-background' && choice.imagePath) {
    return { mode: choice.mode, imagePath: choice.imagePath };
  }
  return { mode: 'disabled' };
}
