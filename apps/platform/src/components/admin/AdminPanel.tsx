'use client';

import type { Branding } from '@/server/tenants/repo';
import { AgentsTab } from './AgentsTab';
import { AuditTab } from './AuditTab';
import { BrandingTab } from './BrandingTab';
import { DomainsTab } from './DomainsTab';
import { IntegrationsTab } from './IntegrationsTab';
import { KnowledgeTab } from './KnowledgeTab';
import { LiveTab } from './LiveTab';
import type { AdminTab } from './tabs';
import { UsersTab } from './UsersTab';

/** One administration section; the shell's side navigation picks which. */
export function AdminPanel(props: {
  tab: AdminTab;
  role: 'admin' | 'manager';
  selfId: string;
  branding: Branding;
}) {
  const { tab } = props;
  return (
    <>
      {tab === 'agents' && <AgentsTab />}
      {tab === 'knowledge' && <KnowledgeTab />}
      {tab === 'integrations' && <IntegrationsTab />}
      {tab === 'users' && <UsersTab role={props.role} selfId={props.selfId} />}
      {tab === 'live' && <LiveTab />}
      {tab === 'branding' && <BrandingTab initial={props.branding} />}
      {tab === 'domains' && <DomainsTab />}
      {tab === 'audit' && <AuditTab />}
    </>
  );
}
