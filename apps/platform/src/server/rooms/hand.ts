import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config';
import { forbidden } from '../errors';
import type { LiveKitAdmin } from '../livekit-admin';
import { livekitRoomName } from '../livekit';
import type { Room } from './service';

/** A join token still proves who someone is this long after it expires, while they are in the call. */
const GRACE_S = 12 * 60 * 60;

export interface JoinClaims {
  identity: string;
  room: string;
}

function decode(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Who a join token was issued to, if this server signed it. Participants cannot change their own
 * attributes, so anything they ask the server to show about themselves goes through this proof.
 */
export function joinClaims(
  cfg: Pick<Config, 'livekitApiKey' | 'livekitApiSecret'>,
  token: string,
  now = Date.now(),
): JoinClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts;
  const header = decode(head);
  const payload = decode(body);
  if (header?.alg !== 'HS256' || !payload) return null;
  const expected = createHmac('sha256', cfg.livekitApiSecret).update(`${head}.${body}`).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (payload.iss !== cfg.livekitApiKey) return null;
  const seconds = now / 1000;
  if (typeof payload.exp !== 'number' || seconds > payload.exp + GRACE_S) return null;
  if (typeof payload.nbf === 'number' && seconds < payload.nbf - 60) return null;
  const video = payload.video as { room?: unknown; roomJoin?: unknown } | undefined;
  if (
    typeof payload.sub !== 'string' ||
    !payload.sub ||
    typeof video?.room !== 'string' ||
    video.roomJoin !== true
  )
    return null;
  return { identity: payload.sub, room: video.room };
}

/** Raises or lowers the hand of whoever holds the token, in the room (or breakout) they are in. */
export async function setHand(
  cfg: Pick<Config, 'livekitApiKey' | 'livekitApiSecret'>,
  lk: LiveKitAdmin,
  room: Room,
  token: string,
  raised: boolean,
): Promise<{ raised: boolean }> {
  const claims = joinClaims(cfg, token);
  const main = livekitRoomName(room.tenantId, room.slug);
  if (!claims || !(claims.room === main || claims.room.startsWith(`${main}~`)))
    throw forbidden('Entre na reunião antes de levantar a mão');
  const live = await lk.listParticipants(claims.room);
  if (!live.some((p) => p.identity === claims.identity && !p.isAgent))
    throw forbidden('Você não está nesta reunião');
  await lk.setAttributes(claims.room, claims.identity, { hand: raised ? String(Date.now()) : '' });
  return { raised };
}
