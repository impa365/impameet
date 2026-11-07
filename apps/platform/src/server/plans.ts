import { z } from 'zod';
import type { Sql } from './db';

/** What a subscription allows. `null` means unlimited. Billing will set these per plan. */
export interface TenantLimits {
  maxRooms: number | null;
  maxParticipants: number | null;
  agents: boolean;
  customDomains: boolean;
  recording: boolean;
}

export const PLANS = ['free', 'pro', 'enterprise'] as const;
export type Plan = (typeof PLANS)[number];

export const PLAN_LIMITS: Record<Plan, TenantLimits> = {
  free: { maxRooms: 10, maxParticipants: 25, agents: false, customDomains: false, recording: false },
  pro: { maxRooms: 200, maxParticipants: 100, agents: true, customDomains: true, recording: true },
  enterprise: { maxRooms: null, maxParticipants: null, agents: true, customDomains: true, recording: true },
};

/** Per-tenant overrides stored in tenants.limits, on top of the plan. */
export const limitOverrides = z
  .object({
    maxRooms: z.number().int().min(0).max(100_000).nullable(),
    maxParticipants: z.number().int().min(2).max(1000).nullable(),
    agents: z.boolean(),
    customDomains: z.boolean(),
    recording: z.boolean(),
  })
  .partial()
  .strict();

export function effectiveLimits(plan: string, overrides: unknown): TenantLimits {
  const base = PLAN_LIMITS[(PLANS as readonly string[]).includes(plan) ? (plan as Plan) : 'free'];
  const parsed = limitOverrides.safeParse(overrides ?? {});
  return { ...base, ...(parsed.success ? parsed.data : {}) };
}

export async function tenantLimits(sql: Sql, tenantId: string): Promise<TenantLimits> {
  const [row] = await sql<{ plan: string; limits: unknown }[]>`
    select plan, limits from tenants where id = ${tenantId}`;
  return effectiveLimits(row?.plan ?? 'free', row?.limits);
}

/** Smallest positive cap, or null when neither side limits. */
export function capParticipants(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}
