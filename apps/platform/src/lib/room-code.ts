/** A room slug from what someone typed: the bare code, or any link ending in /r/<code>. */
export function roomFromInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const match = text.match(/\/r\/([^/?#\s]+)/);
  const slug = match ? match[1] : text;
  return /^[a-z0-9][a-z0-9-]{0,79}$/i.test(slug) ? slug.toLowerCase() : null;
}
