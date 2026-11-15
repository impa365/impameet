import { describe, expect, it } from 'vitest';
import {
  VOLUME_DEFAULT,
  VOLUME_MAX,
  clampVolume,
  volumeFromPercent,
  volumePercent,
} from '@/lib/participant-volume';

describe('participant volume', () => {
  it('clamps to 0–200% and round-trips percents', () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(3)).toBe(VOLUME_MAX);
    expect(clampVolume(Number.NaN)).toBe(VOLUME_DEFAULT);
    expect(volumePercent(1.5)).toBe(150);
    expect(volumeFromPercent(200)).toBe(2);
    expect(volumeFromPercent(50)).toBe(0.5);
  });
});
