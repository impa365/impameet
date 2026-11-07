'use client';

import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useLocale } from '@/i18n/client';
import type { Locale } from '@/i18n/config';
import type { SyncElement } from '@/lib/whiteboard-sync';

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

if (typeof window !== 'undefined') window.EXCALIDRAW_ASSET_PATH = '/excalidraw/';

const EXCALIDRAW_LANG: Record<Locale, string> = { 'pt-BR': 'pt-BR', en: 'en', es: 'es-ES' };

/** Loaded on demand (next/dynamic) so the drawing library never weighs on the meeting page. */
export default function WhiteboardCanvas(props: {
  initialElements: readonly SyncElement[];
  readOnly: boolean;
  onReady: (api: ExcalidrawImperativeAPI | null) => void;
  onChange: () => void;
}) {
  const locale = useLocale();
  return (
    <Excalidraw
      excalidrawAPI={props.onReady}
      initialData={{ elements: props.initialElements as never, scrollToContent: true }}
      onChange={props.onChange}
      langCode={EXCALIDRAW_LANG[locale]}
      viewModeEnabled={props.readOnly}
      theme="dark"
      UIOptions={{ tools: { image: false }, canvasActions: { loadScene: false, saveToActiveFile: false } }}
    />
  );
}
