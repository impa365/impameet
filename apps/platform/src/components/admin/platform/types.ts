export interface Limits {
  maxRooms: number | null;
  maxParticipants: number | null;
  agents: boolean;
  customDomains: boolean;
  recording: boolean;
}

export type Plan = 'free' | 'pro' | 'enterprise';
export const PLANS: Plan[] = ['free', 'pro', 'enterprise'];

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  plan: string;
  limits: Limits;
  customLimits: boolean;
  users: number;
  rooms: number;
  domains: number;
  createdAt: string;
}

export interface TenantsView {
  tenants: Tenant[];
  plans: Record<Plan, Limits>;
}

export const TENANTS_API = '/api/superadmin/tenants';
