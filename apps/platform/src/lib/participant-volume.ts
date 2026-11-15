/** Local playback volume for one remote participant (only this browser hears it). */
export const VOLUME_MIN = 0;
/** Above 1.0 needs LiveKit `webAudioMix` (GainNode); HTML media elements stop at 1. */
export const VOLUME_MAX = 2;
export const VOLUME_DEFAULT = 1;
export const VOLUME_STEP = 0.05;

/** Clamps a raw volume to the allowed range. */
export function clampVolume(raw: number): number {
  if (!Number.isFinite(raw)) return VOLUME_DEFAULT;
  return Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, raw));
}

/** Percent for the slider and announcements (0–200). */
export function volumePercent(volume: number): number {
  return Math.round(clampVolume(volume) * 100);
}

/** Slider percent → volume. */
export function volumeFromPercent(percent: number): number {
  return clampVolume(percent / 100);
}
