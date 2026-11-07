/** iCalendar (RFC 5545) invites that Google Calendar, Outlook and Apple Calendar all accept. */

import type { Locale } from '@/i18n/config';

export interface InviteEvent {
  uid: string;
  title: string;
  description: string;
  start: Date;
  durationMin: number;
  url: string;
  organizer: { name: string; email?: string | null };
  attendees: string[];
  productName: string;
  /** Language of the invite text (the scheduler's); Portuguese when absent. */
  locale?: Locale;
}

const TEXT: Record<
  Locale,
  {
    join: string;
    joinMeeting: string;
    invited: string;
    alarm: string;
    at: string;
    zone: string;
    subject: string;
  }
> = {
  'pt-BR': {
    join: 'Entrar',
    joinMeeting: 'Entrar na reunião',
    invited: '{name} convidou você para uma reunião.',
    alarm: 'A reunião começa em 10 minutos',
    at: 'às',
    zone: 'horário de Brasília',
    subject: 'Convite',
  },
  en: {
    join: 'Join',
    joinMeeting: 'Join the meeting',
    invited: '{name} invited you to a meeting.',
    alarm: 'The meeting starts in 10 minutes',
    at: 'at',
    zone: 'Brasília time',
    subject: 'Invitation',
  },
  es: {
    join: 'Unirse',
    joinMeeting: 'Unirse a la reunión',
    invited: '{name} te invitó a una reunión.',
    alarm: 'La reunión empieza en 10 minutos',
    at: 'a las',
    zone: 'hora de Brasilia',
    subject: 'Invitación',
  },
};

export function inviteWords(locale: Locale = 'pt-BR') {
  return TEXT[locale];
}

const TIME_ZONE = 'America/Sao_Paulo';

export function icsDate(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Lines longer than 75 octets continue on the next line after a space (never splitting a character). */
export function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  for (const char of line) {
    const limit = parts.length === 0 ? 75 : 74;
    if (encoder.encode(current + char).length > limit) {
      parts.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.join('\r\n ');
}

export function buildIcs(event: InviteEvent, now = new Date()): string {
  const end = new Date(event.start.getTime() + event.durationMin * 60_000);
  const words = inviteWords(event.locale);
  const description = [event.description, `${words.join}: ${event.url}`].filter(Boolean).join('\n\n');
  const organizer = event.organizer.email
    ? `ORGANIZER;CN=${icsEscape(event.organizer.name)}:mailto:${event.organizer.email}`
    : null;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${icsEscape(event.productName)}//Meet//PT`,
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(event.start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `LOCATION:${icsEscape(event.url)}`,
    `URL:${event.url}`,
    organizer,
    ...event.attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${a}`),
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape(words.alarm)}`,
    'TRIGGER:-PT10M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter((l): l is string => l !== null);
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function whenText(start: Date, durationMin: number, locale: Locale = 'pt-BR'): string {
  const words = inviteWords(locale);
  const date = start.toLocaleDateString(locale, {
    timeZone: TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const time = start.toLocaleTimeString(locale, { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' });
  return `${date}, ${words.at} ${time} (${words.zone}), ${durationMin} min`;
}

export function inviteText(
  event: Pick<
    InviteEvent,
    'title' | 'description' | 'start' | 'durationMin' | 'url' | 'organizer' | 'locale'
  >,
): string {
  const words = inviteWords(event.locale);
  return [
    words.invited.replace('{name}', event.organizer.name),
    '',
    event.title,
    whenText(event.start, event.durationMin, event.locale),
    event.description ? `\n${event.description}` : '',
    '',
    `${words.joinMeeting}: ${event.url}`,
  ]
    .filter((l, i, all) => !(l === '' && all[i - 1] === ''))
    .join('\n');
}
