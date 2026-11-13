/**
 * The studio (our StreamYard): what is on the stage that goes live and into the recording.
 * The producer edits it; the server keeps it on the room and in the LiveKit room metadata, so
 * every browser and the recorder's render page see the same stage at once.
 */

export const STUDIO_LAYOUTS = ['solo', 'grid', 'leader', 'screen', 'pip'] as const;
export type StudioLayout = (typeof STUDIO_LAYOUTS)[number];

export const MAX_ON_STAGE = 9;
export const MAX_BANNERS = 20;
export const MAX_BANNER_CHARS = 200;

export interface StudioBanner {
  id: string;
  text: string;
  /** "bar": fixed at the bottom; "ticker": scrolls across. */
  style: 'bar' | 'ticker';
}

export interface StudioBrand {
  /** Accent: name tags and banners. */
  color: string;
  background: string;
  /** An https image shown in the top corner. */
  logo: string | null;
}

export interface StudioState {
  layout: StudioLayout;
  /** People on stage, in order (identities). Everyone else in the room is backstage. */
  stage: string[];
  /** Whose screen share is on stage (layouts "screen" and "pip" give it the most room). */
  screen: string | null;
  banners: StudioBanner[];
  /** The banner on screen now. */
  banner: string | null;
  /** Name tags under each person on stage. */
  names: boolean;
  brand: StudioBrand;
}

export const EMPTY_STUDIO: StudioState = {
  layout: 'grid',
  stage: [],
  screen: null,
  banners: [],
  banner: null,
  names: true,
  brand: { color: '#2563eb', background: '#0f172a', logo: null },
};

const HEX = /^#[0-9a-f]{6}$/i;
const isLayout = (v: unknown): v is StudioLayout => STUDIO_LAYOUTS.includes(v as StudioLayout);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Reads a stage from anywhere (room metadata, the database): unknown parts fall back, never throw. */
export function parseStudio(raw: unknown): StudioState {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return EMPTY_STUDIO;
    }
  }
  if (!data || typeof data !== 'object') return EMPTY_STUDIO;
  const d = data as Record<string, unknown>;
  const brand = (d.brand && typeof d.brand === 'object' ? d.brand : {}) as Record<string, unknown>;
  const banners = Array.isArray(d.banners)
    ? d.banners
        .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
        .map((b) => ({
          id: text(b.id, 40),
          text: text(b.text, MAX_BANNER_CHARS),
          style: b.style === 'ticker' ? ('ticker' as const) : ('bar' as const),
        }))
        .filter((b) => b.id && b.text)
        .slice(0, MAX_BANNERS)
    : [];
  const stage = Array.isArray(d.stage)
    ? [
        ...new Set(
          d.stage.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200),
        ),
      ].slice(0, MAX_ON_STAGE)
    : [];
  const logo = text(brand.logo, 500);
  return {
    layout: isLayout(d.layout) ? d.layout : EMPTY_STUDIO.layout,
    stage,
    screen: typeof d.screen === 'string' && d.screen ? d.screen.slice(0, 200) : null,
    banners,
    banner: typeof d.banner === 'string' && banners.some((b) => b.id === d.banner) ? d.banner : null,
    names: d.names !== false,
    brand: {
      color:
        typeof brand.color === 'string' && HEX.test(brand.color) ? brand.color : EMPTY_STUDIO.brand.color,
      background:
        typeof brand.background === 'string' && HEX.test(brand.background)
          ? brand.background
          : EMPTY_STUDIO.brand.background,
      logo: logo.startsWith('https://') ? logo : null,
    },
  };
}

/** How many tiles a layout shows at most, and whether the screen share takes the main place. */
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
