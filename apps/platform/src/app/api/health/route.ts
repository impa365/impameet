import { db } from '@/server/db';
import { json } from '@/server/http';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    await db()`select 1`;
    return json({ status: 'ok' });
  } catch {
    return json({ status: 'database_unavailable' }, 503);
  }
}
