import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { liveDeps } from '@/server/live/client';
import { addRtmp, listDestinations } from '@/server/live/service';
import { rtmpDestinationInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

/** Where the organization goes live (keys and tokens are never returned). */
export async function GET(): Promise<Response> {
  return handle(async () => json(await listDestinations(liveDeps(), await readerUser())));
}

/** A custom RTMP server (Facebook, Twitch, Instagram, LinkedIn, Kick, a YouTube key…). */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const input = await readJson(req, rtmpDestinationInput);
    return json(await addRtmp(liveDeps(), actor, input, clientIp(req)), 201);
  });
}
