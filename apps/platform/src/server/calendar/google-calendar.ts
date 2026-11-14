/**
 * The Google Calendar calls a scheduled meeting needs, over plain fetch: one event in the
 * organizer's calendar, with the room link, whose guests Google invites (and tells when it is
 * cancelled). Only the `calendar.events` scope: events, never calendar settings or sharing.
 */
import type { Fetch } from '../storage/google';
import { GoogleError } from '../storage/google';

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const TIMEOUT_MS = 20_000;
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
export const CALENDAR_SCOPES = ['openid', 'email', CALENDAR_SCOPE];

export interface CalendarEvent {
  title: string;
  description: string;
  start: Date;
  durationMin: number;
  url: string;
  attendees: string[];
  productName: string;
}

async function call(
  fetchImpl: Fetch,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new GoogleError('Não foi possível falar com o Google Agenda agora');
  }
}

async function failure(res: Response, what: string): Promise<GoogleError> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return new GoogleError(
    `${what}: ${String(body?.error?.message ?? `HTTP ${res.status}`).slice(0, 200)}`,
    res.status,
  );
}

/** The event as Google stores it: the link in the description, the location and the source. */
export function eventBody(event: CalendarEvent) {
  const end = new Date(event.start.getTime() + event.durationMin * 60_000);
  return {
    summary: event.title,
    description: [event.description.trim(), `${event.productName}: ${event.url}`]
      .filter(Boolean)
      .join('\n\n'),
    location: event.url,
    start: { dateTime: event.start.toISOString() },
    end: { dateTime: end.toISOString() },
    attendees: event.attendees.map((email) => ({ email })),
    source: { title: event.productName, url: event.url },
    guestsCanModify: false,
    reminders: { useDefault: true },
  };
}

/** Creates the event; Google e-mails the guests their invitation. Returns the event id. */
export async function insertEvent(fetchImpl: Fetch, token: string, event: CalendarEvent): Promise<string> {
  const res = await call(fetchImpl, token, '?sendUpdates=all', {
    method: 'POST',
    body: JSON.stringify(eventBody(event)),
  });
  if (!res.ok) throw await failure(res, 'O Google Agenda recusou o evento');
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new GoogleError('O Google Agenda não devolveu o evento');
  return body.id;
}

/** Cancels it; Google tells the guests. An event already gone counts as done. */
export async function deleteEvent(fetchImpl: Fetch, token: string, eventId: string): Promise<void> {
  const res = await call(fetchImpl, token, `/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404 && res.status !== 410)
    throw await failure(res, 'O Google Agenda recusou cancelar o evento');
}
