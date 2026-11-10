import type { MailMessage, Mailer } from '../mail/smtp';

export type { Mailer };
export type InviteMail = MailMessage;

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
