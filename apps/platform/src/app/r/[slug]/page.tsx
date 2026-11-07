import { notFound, redirect } from 'next/navigation';
import { MeetingRoom } from '@/components/MeetingRoom';
import { db } from '@/server/db';
import { currentTenant, currentUser } from '@/server/request';
import { findRoom } from '@/server/rooms/service';
import { roomSlug } from '@/server/validation';

export default async function RoomPage({ params }: { params: Promise<{ slug: string }> }) {
  const ctx = await currentTenant();
  if (!ctx) redirect('/');
  const slug = roomSlug.safeParse((await params).slug);
  if (!slug.success) notFound();
  const room = await findRoom(db(), ctx.tenant.id, slug.data);
  if (!room) notFound();
  const user = await currentUser();
  if (!user && !room.allowGuests) redirect('/login');

  return (
    <MeetingRoom
      slug={room.slug}
      roomName={room.name}
      productName={ctx.branding.productName}
      userName={user?.name ?? null}
    />
  );
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: (await params).slug };
}
