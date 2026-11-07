import { normaliseHost } from '../tenants/host';
import type { Locale } from '@/i18n/config';
import { type InviteEvent, buildIcs, inviteText, inviteWords, whenText } from './ics';
import type { InviteMail } from './mailer';
import type { Meeting } from './service';

/** Public link of a room on the host the request came in on (tenant subdomain or custom domain). */
export function roomUrl(req: Request, slug: string, secure: boolean): string {
  const host = normaliseHost(req.headers.get('host')) ?? 'localhost';
  return `${secure ? 'https' : 'http'}://${host}/r/${encodeURIComponent(slug)}`;
}

export function inviteEvent(
  meeting: Meeting,
  url: string,
  productName: string,
  locale: Locale = 'pt-BR',
): InviteEvent {
  return {
    uid: `${meeting.id}@impa-meet`,
    title: meeting.title,
    description: meeting.description,
    start: meeting.startsAt,
    durationMin: meeting.durationMin,
    url,
    organizer: { name: meeting.createdByName ?? productName, email: meeting.createdByEmail },
    attendees: meeting.invitees,
    productName,
    locale,
  };
}

export function inviteMail(event: InviteEvent, to: string): InviteMail {
  return {
    to,
    subject: `${inviteWords(event.locale).subject}: ${event.title} — ${whenText(event.start, event.durationMin, event.locale)}`,
    text: inviteText(event),
    ics: buildIcs(event),
  };
}
