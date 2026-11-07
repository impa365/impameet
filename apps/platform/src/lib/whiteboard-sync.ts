/**
 * Whiteboard collaboration over LiveKit text streams. Excalidraw elements carry a `version`
 * that grows on every edit and a random `versionNonce`; merging keeps, per element id, the
 * highest version and breaks ties with the lower nonce (Excalidraw's own reconciliation rule),
 * so every participant converges on the same drawing regardless of message order.
 */

export const WHITEBOARD_TOPIC = 'impa-whiteboard';
export const MAX_MESSAGE_CHARS = 2_000_000;

export interface SyncElement {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export type WhiteboardMessage = { type: 'scene'; elements: SyncElement[] } | { type: 'request' };

function wins(incoming: SyncElement, current: SyncElement | undefined): boolean {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.versionNonce < current.versionNonce;
}

/** Merges remote elements into the local list, keeping local order and appending new ones. */
export function mergeElements(local: readonly SyncElement[], remote: readonly SyncElement[]): SyncElement[] {
  const byId = new Map(local.map((e) => [e.id, e]));
  const order = local.map((e) => e.id);
  for (const element of remote) {
    const current = byId.get(element.id);
    if (!current) order.push(element.id);
    if (wins(element, current)) byId.set(element.id, element);
  }
  return order.map((id) => byId.get(id)!);
}

/** Elements whose version is newer than what was last sent (or received) for them. */
export function changedSince(elements: readonly SyncElement[], known: Map<string, number>): SyncElement[] {
  return elements.filter((e) => (known.get(e.id) ?? -1) < e.version);
}

export function rememberVersions(elements: readonly SyncElement[], known: Map<string, number>): void {
  for (const e of elements) known.set(e.id, Math.max(known.get(e.id) ?? -1, e.version));
}

function isElement(value: unknown): value is SyncElement {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    e.id.length <= 100 &&
    Number.isInteger(e.version) &&
    Number.isInteger(e.versionNonce)
  );
}

export function encodeMessage(message: WhiteboardMessage): string {
  return JSON.stringify(message);
}

/** Parses an incoming message; anything malformed or oversized is ignored (null). */
export function decodeMessage(text: string): WhiteboardMessage | null {
  if (text.length > MAX_MESSAGE_CHARS) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type === 'request') return { type: 'request' };
  if (message.type === 'scene' && Array.isArray(message.elements) && message.elements.every(isElement)) {
    return { type: 'scene', elements: message.elements };
  }
  return null;
}
