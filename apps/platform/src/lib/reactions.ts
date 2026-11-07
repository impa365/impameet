export const REACTION_TOPIC = 'impa-reaction';
export const REACTIONS = ['👍', '👏', '😂', '😮', '❤️', '🎉'] as const;
export type Reaction = (typeof REACTIONS)[number];

/** Only the fixed set is accepted, so a client cannot push arbitrary text onto everyone's screen. */
export function parseReaction(text: string): Reaction | null {
  return (REACTIONS as readonly string[]).includes(text) ? (text as Reaction) : null;
}
