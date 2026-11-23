import 'server-only';
import { currentTenant } from '../request';
import { DEFAULT_BRANDING } from '../tenants/repo';

export async function docsBrand(): Promise<string> {
  const ctx = await currentTenant();
  return ctx?.branding.productName ?? DEFAULT_BRANDING.productName;
}
