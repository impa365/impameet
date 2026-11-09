import 'server-only';
import nodemailer from 'nodemailer';
import { config } from '../config';

export interface InviteMail {
  to: string;
  subject: string;
  text: string;
  /** Calendar invite attached when present (meeting invitations). */
  ics?: string;
}

export interface Mailer {
  send(mail: InviteMail): Promise<void>;
}

let mailer: Mailer | null | undefined;

/** Null when SMTP is not configured: invites are then shared by copy/paste and .ics download. */
export function getMailer(): Mailer | null {
  if (mailer !== undefined) return mailer;
  const { smtpUrl, mailFrom } = config();
  if (!smtpUrl || !mailFrom) {
    mailer = null;
    return mailer;
  }
  const transport = nodemailer.createTransport(smtpUrl);
  mailer = {
    async send(mail) {
      await transport.sendMail({
        from: mailFrom,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.ics ? { icalEvent: { method: 'REQUEST', content: mail.ics } } : {}),
      });
    },
  };
  return mailer;
}

/** Sends one mail per invitee; failures are counted, never thrown (the meeting is already saved). */
export async function sendInvites(
  sender: Mailer,
  invitees: string[],
  build: (to: string) => InviteMail,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const to of invitees) {
    try {
      await sender.send(build(to));
      sent++;
    } catch {
      failed++;
    }
  }
  return { sent, failed };
}
