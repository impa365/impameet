/**
 * Studio stage: scenes with Program/Preview (OBS desk), overlays and browser sources.
 * The producer edits Preview; Cut/Fade copies Preview into Program. Egress sees Program.
 */

export const STUDIO_LAYOUTS = ['solo', 'grid', 'leader', 'screen', 'pip'] as const;
export type StudioLayout = (typeof STUDIO_LAYOUTS)[number];

export const STUDIO_SOURCE_TYPES = ['browser', 'image', 'text', 'clock'] as const;
export type StudioSourceType = (typeof STUDIO_SOURCE_TYPES)[number];
export const STUDIO_CLOCK_FORMATS = ['time', 'seconds', 'date'] as const;
export type StudioClockFormat = (typeof STUDIO_CLOCK_FORMATS)[number];

export const MAX_ON_STAGE = 9;
export const MAX_BANNERS = 20;
export const MAX_BANNER_CHARS = 200;
export const MAX_SCENES = 12;
export const MAX_SOURCES = 16;
export const MAX_SOURCE_URL = 2000;
export const MAX_SOURCE_TEXT = 500;

export interface StudioBanner {
  id: string;
  text: string;
  /** "bar": fixed at the bottom; "ticker": scrolls across. */
  style: 'bar' | 'ticker';
}

export interface StudioBrand {
  color: string;
  background: string;
  logo: string | null;
}

/** Position as % of the 16:9 canvas (0–100). */
export interface StudioBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StudioSourceBase {
  id: string;
  name: string;
  visible: boolean;
  z: number;
  opacity: number;
  box: StudioBox;
}

export interface StudioBrowserSource extends StudioSourceBase {
  type: 'browser';
  /** https URL — Live Pix, alerts, any browser source. */
  url: string;
  /** Mute iframe audio when possible. */
  muted: boolean;
}

export interface StudioImageSource extends StudioSourceBase {
  type: 'image';
  url: string;
}

export interface StudioTextSource extends StudioSourceBase {
  type: 'text';
  text: string;
  color: string;
  background: string;
  align: 'left' | 'center' | 'right';
  size: number;
}

export interface StudioClockSource extends StudioSourceBase {
  type: 'clock';
  format: StudioClockFormat;
  color: string;
  background: string;
  align: 'left' | 'center' | 'right';
  size: number;
}

export type StudioSource = StudioBrowserSource | StudioImageSource | StudioTextSource | StudioClockSource;

/** Layout + people + overlays for one scene (what the canvas draws). */
export interface StudioSceneBody {
  layout: StudioLayout;
  stage: string[];
  screen: string | null;
  banners: StudioBanner[];
  banner: string | null;
  names: boolean;
  brand: StudioBrand;
  /** Layered sources (browser / image / text / clock), drawn above people. */
  sources: StudioSource[];
}

export interface StudioScene extends StudioSceneBody {
  id: string;
  name: string;
}

export interface StudioState {
  scenes: StudioScene[];
  programId: string;
  previewId: string;
  transition: 'cut' | 'fade';
}

const DEFAULT_BRAND: StudioBrand = { color: '#2563eb', background: '#0f172a', logo: null };
const DEFAULT_BOX: StudioBox = { x: 5, y: 5, w: 40, h: 30 };

const DEFAULT_BODY: StudioSceneBody = {
  layout: 'grid',
  stage: [],
  screen: null,
  banners: [],
  banner: null,
  names: true,
  brand: DEFAULT_BRAND,
  sources: [],
};

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function newSceneId(): string {
  return newId('sc');
}

export function makeScene(name: string, body: Partial<StudioSceneBody> = {}, id?: string): StudioScene {
  return {
    id: id ?? newSceneId(),
    name: name.trim().slice(0, 40) || 'Cena',
    ...DEFAULT_BODY,
    ...body,
    brand: { ...DEFAULT_BRAND, ...body.brand },
    sources: body.sources ? body.sources.map(cloneSource) : [],
  };
}

export const EMPTY_STUDIO: StudioState = (() => {
  const program = makeScene('Programa', {}, 'sc_program');
  const preview = makeScene('Montagem', {}, 'sc_preview');
  return {
    scenes: [program, preview],
    programId: program.id,
    previewId: preview.id,
    transition: 'cut',
  };
})();

/** Ready-made overlays the director can drop into Preview. */
export const SOURCE_PRESETS: {
  id: string;
  labelKey: string;
  build: () => StudioSource;
}[] = [
  {
    id: 'livepix',
    labelKey: 'studio.preset.livepix',
    build: () => ({
      id: newId('src'),
      type: 'browser',
      name: 'Live Pix',
      url: 'https://livepix.gg/',
      muted: true,
      visible: true,
      z: 10,
      opacity: 1,
      box: { x: 62, y: 8, w: 34, h: 50 },
    }),
  },
  {
    id: 'alert',
    labelKey: 'studio.preset.alert',
    build: () => ({
      id: newId('src'),
      type: 'browser',
      name: 'Alertas',
      url: 'https://',
      muted: true,
      visible: true,
      z: 20,
      opacity: 1,
      box: { x: 20, y: 20, w: 60, h: 40 },
    }),
  },
  {
    id: 'lower',
    labelKey: 'studio.preset.lower',
    build: () => ({
      id: newId('src'),
      type: 'text',
      name: 'Lower third',
      text: 'Nome · Cargo',
      color: '#ffffff',
      background: '#2563ebcc',
      align: 'left',
      size: 28,
      visible: true,
      z: 15,
      opacity: 1,
      box: { x: 4, y: 72, w: 45, h: 14 },
    }),
  },
  {
    id: 'qr',
    labelKey: 'studio.preset.qr',
    build: () => ({
      id: newId('src'),
      type: 'image',
      name: 'QR / imagem',
      url: 'https://',
      visible: true,
      z: 12,
      opacity: 1,
      box: { x: 72, y: 62, w: 22, h: 28 },
    }),
  },
  {
    id: 'clock',
    labelKey: 'studio.preset.clock',
    build: () => ({
      id: newId('src'),
      type: 'clock',
      name: 'Relógio',
      format: 'time' as const,
      color: '#ffffff',
      background: '#00000099',
      align: 'center' as const,
      size: 36,
      visible: true,
      z: 25,
      opacity: 1,
      box: { x: 78, y: 4, w: 18, h: 10 },
    }),
  },
];

const HEX = /^#[0-9a-f]{6}$/i;
const HEXA = /^#[0-9a-f]{6,8}$/i;
const isLayout = (v: unknown): v is StudioLayout => STUDIO_LAYOUTS.includes(v as StudioLayout);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function parseBox(raw: unknown): StudioBox {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    x: clamp(Number(b.x), 0, 100),
    y: clamp(Number(b.y), 0, 100),
    w: clamp(Number(b.w) || DEFAULT_BOX.w, 2, 100),
    h: clamp(Number(b.h) || DEFAULT_BOX.h, 2, 100),
  };
}

function safeHttps(url: string): string {
  const u = url.trim().slice(0, MAX_SOURCE_URL);
  return u.startsWith('https://') ? u : '';
}

function cloneSource(s: StudioSource): StudioSource {
  return { ...s, box: { ...s.box } };
}

function parseSource(raw: unknown): StudioSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const id = text(d.id, 40) || newId('src');
  const name = text(d.name, 60) || 'Fonte';
  const base = {
    id,
    name,
    visible: d.visible !== false,
    z: clamp(Number(d.z) || 0, 0, 100),
    opacity: clamp(Number(d.opacity) ?? 1, 0, 1),
    box: parseBox(d.box),
  };
  if (d.type === 'browser') {
    const url = safeHttps(typeof d.url === 'string' ? d.url : '');
    if (!url && typeof d.url === 'string' && d.url.trim() === 'https://') {
      return { ...base, type: 'browser', url: 'https://', muted: d.muted !== false };
    }
    if (!url) return null;
    return { ...base, type: 'browser', url, muted: d.muted !== false };
  }
  if (d.type === 'image') {
    const url = safeHttps(typeof d.url === 'string' ? d.url : '');
    if (!url && typeof d.url === 'string' && d.url.trim().startsWith('https://')) {
      return { ...base, type: 'image', url: d.url.trim().slice(0, MAX_SOURCE_URL) };
    }
    if (!url) return null;
    return { ...base, type: 'image', url };
  }
  if (d.type === 'text') {
    const content = text(d.text, MAX_SOURCE_TEXT);
    if (!content) return null;
    const color = typeof d.color === 'string' && HEXA.test(d.color) ? d.color : '#ffffff';
    const background =
      typeof d.background === 'string' && HEXA.test(d.background) ? d.background : '#00000099';
    const align = d.align === 'center' || d.align === 'right' ? d.align : 'left';
    return {
      ...base,
      type: 'text',
      text: content,
      color,
      background,
      align,
      size: clamp(Number(d.size) || 24, 12, 96),
    };
  }
  if (d.type === 'clock') {
    const format = d.format === 'seconds' || d.format === 'date' ? d.format : ('time' as const);
    const color = typeof d.color === 'string' && HEXA.test(d.color) ? d.color : '#ffffff';
    const background =
      typeof d.background === 'string' && HEXA.test(d.background) ? d.background : '#00000099';
    const align = d.align === 'left' || d.align === 'right' ? d.align : 'center';
    return {
      ...base,
      type: 'clock',
      format,
      color,
      background,
      align,
      size: clamp(Number(d.size) || 32, 12, 96),
    };
  }
  return null;
}

function parseBanners(raw: unknown): StudioBanner[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    .map((b) => ({
      id: text(b.id, 40),
      text: text(b.text, MAX_BANNER_CHARS),
      style: b.style === 'ticker' ? ('ticker' as const) : ('bar' as const),
    }))
    .filter((b) => b.id && b.text)
    .slice(0, MAX_BANNERS);
}

function parseBrand(raw: unknown): StudioBrand {
  const brand = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const logo = text(brand.logo, 500);
  return {
    color: typeof brand.color === 'string' && HEX.test(brand.color) ? brand.color : DEFAULT_BRAND.color,
    background:
      typeof brand.background === 'string' && HEX.test(brand.background)
        ? brand.background
        : DEFAULT_BRAND.background,
    logo: logo.startsWith('https://') ? logo : null,
  };
}

function parseStage(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(raw.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200)),
  ].slice(0, MAX_ON_STAGE);
}

function parseSceneBody(d: Record<string, unknown>): StudioSceneBody {
  const banners = parseBanners(d.banners);
  const sources = Array.isArray(d.sources)
    ? d.sources
        .map(parseSource)
        .filter((s): s is StudioSource => !!s)
        .slice(0, MAX_SOURCES)
    : [];
  return {
    layout: isLayout(d.layout) ? d.layout : DEFAULT_BODY.layout,
    stage: parseStage(d.stage),
    screen: typeof d.screen === 'string' && d.screen ? d.screen.slice(0, 200) : null,
    banners,
    banner: typeof d.banner === 'string' && banners.some((b) => b.id === d.banner) ? d.banner : null,
    names: d.names !== false,
    brand: parseBrand(d.brand),
    sources,
  };
}

function parseScene(raw: unknown, fallbackName: string): StudioScene | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  const id = text(d.id, 40) || newSceneId();
  const name = text(d.name, 40) || fallbackName;
  return { id, name, ...parseSceneBody(d) };
}

function cloneSceneBody(scene: StudioSceneBody): StudioSceneBody {
  return {
    layout: scene.layout,
    stage: [...scene.stage],
    screen: scene.screen,
    banners: scene.banners.map((b) => ({ ...b })),
    banner: scene.banner,
    names: scene.names,
    brand: { ...scene.brand },
    sources: scene.sources.map(cloneSource),
  };
}

/** Reads a stage from anywhere (room metadata, the database): unknown parts fall back, never throw. */
export function parseStudio(raw: unknown): StudioState {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return structuredClone(EMPTY_STUDIO);
    }
  }
  if (!data || typeof data !== 'object') return structuredClone(EMPTY_STUDIO);
  const d = data as Record<string, unknown>;

  if (Array.isArray(d.scenes) && d.scenes.length > 0) {
    const scenes = d.scenes
      .map((s, i) => parseScene(s, `Cena ${i + 1}`))
      .filter((s): s is StudioScene => !!s)
      .slice(0, MAX_SCENES);
    if (scenes.length === 0) return structuredClone(EMPTY_STUDIO);
    const ids = new Set(scenes.map((s) => s.id));
    const programId = typeof d.programId === 'string' && ids.has(d.programId) ? d.programId : scenes[0].id;
    const previewId = typeof d.previewId === 'string' && ids.has(d.previewId) ? d.previewId : programId;
    return {
      scenes,
      programId,
      previewId,
      transition: d.transition === 'fade' ? 'fade' : 'cut',
    };
  }

  const body = parseSceneBody(d);
  const program = makeScene('Programa', body, 'sc_program');
  const preview = makeScene('Montagem', cloneSceneBody(body), 'sc_preview');
  return {
    scenes: [program, preview],
    programId: program.id,
    previewId: preview.id,
    transition: 'cut',
  };
}

export function ensureDirectorPair(state: StudioState): StudioState {
  if (state.programId !== state.previewId) return state;
  if (state.scenes.length >= MAX_SCENES) return state;
  const program = programScene(state);
  const draft = makeScene('Montagem', cloneSceneBody(program));
  return parseStudio({
    ...state,
    scenes: [...state.scenes, draft],
    previewId: draft.id,
  });
}

export function programScene(state: StudioState): StudioScene {
  return state.scenes.find((s) => s.id === state.programId) ?? state.scenes[0] ?? EMPTY_STUDIO.scenes[0];
}

export function previewScene(state: StudioState): StudioScene {
  return state.scenes.find((s) => s.id === state.previewId) ?? programScene(state);
}

export function updatePreview(
  state: StudioState,
  edit: (scene: StudioScene) => StudioSceneBody & { name?: string },
): StudioState {
  const current = previewScene(state);
  const nextBody = edit(current);
  const next: StudioScene = {
    ...current,
    ...nextBody,
    id: current.id,
    name: (nextBody.name ?? current.name).trim().slice(0, 40) || current.name,
    brand: { ...DEFAULT_BRAND, ...nextBody.brand },
    sources: (nextBody.sources ?? current.sources).map(cloneSource).slice(0, MAX_SOURCES),
  };
  return parseStudio({
    ...state,
    scenes: state.scenes.map((s) => (s.id === current.id ? next : s)),
  });
}

/** Copy Preview → Program (OBS Transition). */
export function cutPreviewToProgram(state: StudioState): StudioState {
  const preview = previewScene(state);
  const program = programScene(state);
  if (preview.id === program.id) return state;
  const copied: StudioScene = {
    ...program,
    ...cloneSceneBody(preview),
    id: program.id,
    name: program.name,
  };
  return parseStudio({
    ...state,
    scenes: state.scenes.map((s) => (s.id === program.id ? copied : s)),
  });
}

export function setPreviewScene(state: StudioState, sceneId: string): StudioState {
  if (!state.scenes.some((s) => s.id === sceneId)) return state;
  return { ...state, previewId: sceneId };
}

export function setTransition(state: StudioState, transition: 'cut' | 'fade'): StudioState {
  return { ...state, transition };
}

export function addScene(state: StudioState, name?: string): StudioState {
  if (state.scenes.length >= MAX_SCENES) return state;
  const scene = makeScene(name ?? `Cena ${state.scenes.length + 1}`, {
    ...cloneSceneBody(previewScene(state)),
    stage: [],
    screen: null,
  });
  return parseStudio({
    ...state,
    scenes: [...state.scenes, scene],
    previewId: scene.id,
  });
}

export function renameScene(state: StudioState, sceneId: string, name: string): StudioState {
  const next = name.trim().slice(0, 40);
  if (!next) return state;
  return parseStudio({
    ...state,
    scenes: state.scenes.map((s) => (s.id === sceneId ? { ...s, name: next } : s)),
  });
}

export function deleteScene(state: StudioState, sceneId: string): StudioState {
  if (state.scenes.length <= 2) return state;
  if (sceneId === state.programId) return state;
  const scenes = state.scenes.filter((s) => s.id !== sceneId);
  if (scenes.length === state.scenes.length) return state;
  // Prefer another draft as Preview — never silently edit Program after a delete.
  const previewId =
    state.previewId === sceneId
      ? (scenes.find((s) => s.id !== state.programId)?.id ?? state.programId)
      : state.previewId;
  return ensureDirectorPair(parseStudio({ ...state, scenes, previewId }));
}

/** Duplicate any scene into a new Preview draft. */
export function duplicateScene(state: StudioState, sceneId: string): StudioState {
  if (state.scenes.length >= MAX_SCENES) return state;
  const source = state.scenes.find((s) => s.id === sceneId);
  if (!source) return state;
  const copy = makeScene(`${source.name} · cópia`.slice(0, 40), cloneSceneBody(source));
  return parseStudio({
    ...state,
    scenes: [...state.scenes, copy],
    previewId: copy.id,
  });
}

/** Pull what is on air into the Preview desk (OBS “studio mode” reverse). */
export function copyProgramToPreview(state: StudioState): StudioState {
  const program = programScene(state);
  const preview = previewScene(state);
  if (preview.id === program.id) return state;
  const copied: StudioScene = {
    ...preview,
    ...cloneSceneBody(program),
    id: preview.id,
    name: preview.name,
  };
  return parseStudio({
    ...state,
    scenes: state.scenes.map((s) => (s.id === preview.id ? copied : s)),
  });
}

/** Format a clock source for the canvas (locale-aware). */
export function formatClock(format: StudioClockFormat, at = new Date(), locale = 'pt-BR'): string {
  if (format === 'date') {
    return at.toLocaleDateString(locale, { weekday: 'short', day: '2-digit', month: 'short' });
  }
  return at.toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    second: format === 'seconds' ? '2-digit' : undefined,
    hour12: false,
  });
}

export function addSourceToPreview(state: StudioState, source: StudioSource): StudioState {
  return updatePreview(state, (s) => {
    if (s.sources.length >= MAX_SOURCES) return s;
    return { ...s, sources: [...s.sources, source] };
  });
}

export function updateSourceInPreview(
  state: StudioState,
  sourceId: string,
  patch: Partial<StudioSource>,
): StudioState {
  return updatePreview(state, (s) => ({
    ...s,
    sources: s.sources.map((src) => {
      if (src.id !== sourceId) return src;
      const merged = { ...src, ...patch, id: src.id, type: src.type } as StudioSource;
      return parseSource(merged) ?? src;
    }),
  }));
}

export function removeSourceFromPreview(state: StudioState, sourceId: string): StudioState {
  return updatePreview(state, (s) => ({
    ...s,
    sources: s.sources.filter((src) => src.id !== sourceId),
  }));
}

export function layoutShape(layout: StudioLayout): { max: number; screenFirst: boolean } {
  switch (layout) {
    case 'solo':
      return { max: 1, screenFirst: false };
    case 'leader':
      return { max: MAX_ON_STAGE, screenFirst: false };
    case 'screen':
    case 'pip':
      return { max: MAX_ON_STAGE, screenFirst: true };
    default:
      return { max: MAX_ON_STAGE, screenFirst: false };
  }
}

/** Sorted visible sources for painting (low z first). */
export function sortedSources(scene: StudioSceneBody): StudioSource[] {
  return [...scene.sources]
    .filter((s) => s.visible)
    .sort((a, b) => a.z - b.z || a.name.localeCompare(b.name));
}
