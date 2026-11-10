import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { MeetingsPanel } from '@/components/MeetingsPanel';
import { RecordingsPanel } from '@/components/RecordingsPanel';
import { RoomsPanel } from '@/components/RoomsPanel';
import { ReportsPanel } from '@/components/ReportsPanel';
import { TranscriptsPanel } from '@/components/TranscriptsPanel';
import { DASHBOARD_VIEWS, pickDashboardView } from '@/components/admin/tabs';
import { getT } from '@/i18n/server';
import { listAgentNames } from '@/server/agents/service';
import { db } from '@/server/db';
import { currentTenant, currentUser } from '@/server/request';
import { listRooms } from '@/server/rooms/service';

type Props = { searchParams: Promise<{ view?: string; new?: string; room?: string }> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const t = await getT();
  const view = pickDashboardView((await searchParams).view);
  return { title: view === 'rooms' ? t('shell.titles.myRooms') : t(DASHBOARD_VIEWS[view].label) };
}

export default async function Dashboard({ searchParams }: Props) {
  const ctx = await currentTenant();
  if (!ctx) redirect('/');
  const user = await currentUser();
  if (!user) redirect('/login');
  const t = await getT();
  const params = await searchParams;
  const view = pickDashboardView(params.view);
  const [rooms, agents] = await Promise.all([listRooms(db(), user), listAgentNames(db(), user.tenantId)]);
  const title =
    view === 'rooms'
      ? user.role === 'member'
        ? t('shell.titles.myRooms')
        : t('shell.titles.orgRooms', { org: ctx.tenant.name })
      : t(DASHBOARD_VIEWS[view].label);

  return (
    <AppShell branding={ctx.branding} user={user} active={`dashboard:${view}`} title={title}>
      {view === 'rooms' && (
        <RoomsPanel
          initialRooms={rooms.map((r) => ({
            slug: r.slug,
            name: r.name,
            hasPassword: r.hasPassword,
            allowGuests: r.allowGuests,
            access: r.access,
            agentIds: r.agentIds,
          }))}
          agents={agents}
          startCreating={params.new === '1'}
          startRoom={params.room}
        />
      )}
      {view === 'meetings' && <MeetingsPanel rooms={rooms.map((r) => ({ slug: r.slug, name: r.name }))} />}
      {view === 'recordings' && <RecordingsPanel />}
      {view === 'transcripts' && <TranscriptsPanel />}
      {view === 'reports' && <ReportsPanel />}
    </AppShell>
  );
}
