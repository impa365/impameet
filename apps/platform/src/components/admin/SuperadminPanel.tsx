'use client';

import { PlatformGoogle } from './PlatformGoogle';
import { PlatformMail } from './PlatformMail';
import { OrganizationDetail, OrganizationsList } from './platform/Organizations';
import { PlatformOverview } from './platform/PlatformOverview';
import type { PlatformTab } from './tabs';

/** One page of the platform area (super admins); the side navigation picks which. */
export function SuperadminPanel(props: { tab: PlatformTab; org: string | null; selfTenantId: string }) {
  switch (props.tab) {
    case 'organizations':
      return props.org ? (
        <OrganizationDetail id={props.org} selfTenantId={props.selfTenantId} />
      ) : (
        <OrganizationsList selfTenantId={props.selfTenantId} />
      );
    case 'email':
      return (
        <div className="platform-page">
          <PlatformMail />
        </div>
      );
    case 'google':
      return (
        <div className="platform-page">
          <PlatformGoogle />
        </div>
      );
    default:
      return <PlatformOverview selfTenantId={props.selfTenantId} />;
  }
}
