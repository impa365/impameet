import { resolveTxt } from 'node:dns/promises';
import { db } from '@/server/db';
import { removeDomain, verifyDomain } from '@/server/domains/service';
import { writerUser } from '@/server/guard';
import { clientIp, handle, json } from '@/server/http';
import { domainInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

async function host(params: Promise<{ hostname: string }>) {
  return domainInput.parse({ hostname: decodeURIComponent((await params).hostname) }).hostname;
}

/** Checks the TXT record now and marks the domain verified when it matches. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ hostname: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    return json({ domain: await verifyDomain(db(), actor, await host(params), resolveTxt, clientIp(req)) });
  });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ hostname: string }> },
): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    await removeDomain(db(), actor, await host(params), clientIp(req));
    return json({ ok: true });
  });
}
