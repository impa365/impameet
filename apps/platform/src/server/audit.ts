import type { Sql } from './db';

export interface AuditEntry {
  tenantId: string | null;
  actorId: string | null;
  action: string;
  target?: string;
  meta?: Record<string, string | number | boolean | null>;
  ip?: string | null;
}

/** Append-only record of who did what. Never put secrets or passwords in `meta`. */
export async function audit(sql: Sql, entry: AuditEntry): Promise<void> {
  await sql`
    insert into audit_log (tenant_id, actor_id, action, target, meta, ip)
    values (${entry.tenantId}, ${entry.actorId}, ${entry.action}, ${entry.target ?? null},
            ${sql.json(entry.meta ?? {})}, ${entry.ip ?? null})`;
}
