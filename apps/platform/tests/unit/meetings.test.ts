import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { buildIcs, fold, icsDate, icsEscape, inviteText, whenText } = await import('@/server/meetings/ics');
const { sendInvites } = await import('@/server/meetings/mailer');
const { inviteEvent, inviteMail, roomUrl } = await import('@/server/meetings/invite');

const START = new Date('2026-11-10T13:00:00Z');
const event = {
  uid: 'm1@impa-meet',
  title: 'Planejamento; Q1, metas',
  description: 'Pauta:\n1) números',
  start: START,
  durationMin: 90,
  url: 'https://acme.meet.test/r/vendas',
  organizer: { name: 'Ana', email: 'ana@acme.test' },
  attendees: ['bia@acme.test'],
  productName: 'Acme Meet',
};

describe('calendar invites', () => {
  it('formats dates and escapes text per RFC 5545', () => {
    expect(icsDate(START)).toBe('20261110T130000Z');
    expect(icsEscape('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
  });

  it('folds long lines at 75 octets without splitting characters', () => {
    const long = `DESCRIPTION:${'ç'.repeat(80)}`;
    const folded = fold(long);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(lines.map((l, i) => (i ? l.slice(1) : l)).join('')).toBe(long);
    expect(fold('SHORT')).toBe('SHORT');
  });

  it('builds a complete event with organizer, attendees, link and reminder', () => {
    const ics = buildIcs(event, new Date('2026-11-01T00:00:00Z'));
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('UID:m1@impa-meet');
    expect(ics).toContain('DTSTAMP:20261101T000000Z');
    expect(ics).toContain('DTSTART:20261110T130000Z');
    expect(ics).toContain('DTEND:20261110T143000Z');
    expect(ics).toContain('SUMMARY:Planejamento\\; Q1\\, metas');
    expect(ics).toContain('ORGANIZER;CN=Ana:mailto:ana@acme.test');
    expect(ics).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:bia@acme.test');
    expect(ics).toContain('URL:https://acme.meet.test/r/vendas');
    expect(ics).toContain('TRIGGER:-PT10M');
    const noOrganizerMail = buildIcs({ ...event, organizer: { name: 'Ana' } });
    expect(noOrganizerMail).not.toContain('ORGANIZER');
  });

  it('writes a readable invitation in Brasília time', () => {
    expect(whenText(START, 90)).toBe(
      'terça-feira, 10 de novembro de 2026, às 10:00 (horário de Brasília), 90 min',
    );
    const text = inviteText(event);
    expect(text).toContain('Ana convidou você para uma reunião.');
    expect(text).toContain('Pauta:\n1) números');
    expect(text).toContain('Entrar na reunião: https://acme.meet.test/r/vendas');
    expect(text).not.toMatch(/\n\n\n/);
    expect(inviteText({ ...event, description: '' })).not.toContain('Pauta');
  });
});

describe('invite delivery', () => {
  const meeting = {
    id: 'm1',
    roomSlug: 'vendas',
    roomName: 'Vendas',
    title: 'Reunião',
    description: '',
    startsAt: START,
    durationMin: 30,
    invitees: ['a@x.test', 'b@x.test'],
    createdBy: 'u1',
    createdByName: null,
    createdByEmail: null,
  };

  it('builds the room link from the request host', () => {
    const req = new Request('http://internal:3000/api/meetings', { headers: { host: 'Acme.Meet.Test:443' } });
    expect(roomUrl(req, 'vendas', true)).toBe('https://acme.meet.test/r/vendas');
    expect(roomUrl(new Request('http://x/'), 'a b', false)).toBe('http://localhost/r/a%20b');
  });

  it('mails each invitee and counts failures without throwing', async () => {
    const ev = inviteEvent(meeting, 'https://acme.meet.test/r/vendas', 'Acme Meet');
    expect(ev.organizer).toEqual({ name: 'Acme Meet', email: null });
    const sent: string[] = [];
    const result = await sendInvites(
      {
        from: 'convites@acme.test',
        async send(mail) {
          if (mail.to.startsWith('b')) throw new Error('smtp down');
          sent.push(mail.to);
        },
      },
      meeting.invitees,
      (to) => inviteMail(ev, to),
    );
    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(sent).toEqual(['a@x.test']);
    const mail = inviteMail(ev, 'a@x.test');
    expect(mail.subject).toMatch(/^Convite: Reunião — terça-feira/);
    expect(mail.ics).toContain('BEGIN:VCALENDAR');
  });
});
