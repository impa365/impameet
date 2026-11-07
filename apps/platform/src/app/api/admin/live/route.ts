import { liveRooms } from '@/server/admin/service';
import { db } from '@/server/db';
import { readerUser } from '@/server/guard';
import { handle, json } from '@/server/http';
import { lk } from '@/server/livekit-client';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => json({ rooms: await liveRooms(db(), lk(), await readerUser()) }));
}
