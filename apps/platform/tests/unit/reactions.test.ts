import { describe, expect, it } from 'vitest';
import { REACTIONS, parseReaction } from '@/lib/reactions';

describe('parseReaction', () => {
  it.each(REACTIONS)('accepts %s', (emoji) => {
    expect(parseReaction(emoji)).toBe(emoji);
  });

  it.each(['', 'oi', '💩', '👍👍', '<script>'])('rejects %j', (text) => {
    expect(parseReaction(text)).toBeNull();
  });
});
