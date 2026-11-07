import { config } from '@/server/config';
import { db } from '@/server/db';
import { addDomain, listDomains, verificationRecord } from '@/server/domains/service';
import { readerUser, writerUser } from '@/server/guard';
import { clientIp, handle, json, readJson } from '@/server/http';
import { domainInput } from '@/server/validation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return handle(async () => {
    const domains = await listDomains(db(), await readerUser());
    return json({
      target: config().platformDomain,
      domains: domains.map((d) => ({ ...d, record: verificationRecord(d) })),
    });
  });
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const actor = await writerUser(req);
    const { hostname } = await readJson(req, domainInput);
    const domain = await addDomain(db(), actor, hostname, config().platformDomain, clientIp(req));
    return json({ domain: { ...domain, record: verificationRecord(domain) } }, 201);
  });
}
