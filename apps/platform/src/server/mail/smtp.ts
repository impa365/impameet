/**
 * Sending e-mail through an SMTP server an admin configured. The server name is resolved here
 * and the connection goes to that checked address (TLS still verifies the name), so a DNS
 * answer can never point our servers at an internal service.
 */
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { badRequest } from '../errors';
import { type Resolver, isPublicIp, systemResolver } from '../security/public-url';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpSettings {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Calendar invite attached when present (meeting invitations). */
  ics?: string;
  replyTo?: string;
}

export interface Mailer {
  /** The address mail comes from, for the admin to see. */
  readonly from: string;
  send(mail: MailMessage): Promise<void>;
}

/** Ports SMTP servers listen on; anything else is almost certainly not one. */
export const SMTP_PORTS = [25, 465, 587, 2525] as const;
const TIMEOUT_MS = 15_000;

export interface SmtpPolicy {
  resolve?: Resolver;
  /** The platform's own server may live on the private network (super admin only). */
  allowPrivate?: boolean;
}

/** The address to connect to: a public one, unless the policy allows private servers. */
export async function smtpAddress(host: string, policy: SmtpPolicy = {}): Promise<string> {
  const name = host.trim().toLowerCase();
  const addresses = isIP(name) ? [name] : await (policy.resolve ?? systemResolver)(name).catch(() => []);
  if (addresses.length === 0) throw badRequest('Servidor SMTP não encontrado');
  if (!policy.allowPrivate && !addresses.every(isPublicIp))
    throw badRequest('O servidor SMTP precisa estar na internet pública');
  return addresses[0];
}

/** "Name" <address>, with the name's quotes and line breaks removed. */
export function fromHeader(name: string, email: string): string {
  const clean = name.replace(/["\r\n<>]/g, '').trim();
  return clean ? `"${clean}" <${email}>` : email;
}

export function transportOptions(settings: SmtpSettings, address: string) {
  return {
    host: address,
    port: settings.port,
    secure: settings.security === 'tls',
    requireTLS: settings.security === 'starttls',
    ignoreTLS: settings.security === 'none',
    auth: settings.username ? { user: settings.username, pass: settings.password } : undefined,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS * 2,
    tls: { servername: isIP(settings.host) ? undefined : settings.host, minVersion: 'TLSv1.2' as const },
  };
}

export type Transport = (options: ReturnType<typeof transportOptions>) => {
  sendMail(mail: Record<string, unknown>): Promise<unknown>;
  close(): void;
};

const nodemailerTransport: Transport = (options) => nodemailer.createTransport(options);

export function smtpMailer(
  settings: SmtpSettings,
  from: { name: string; email: string; replyTo?: string | null },
  policy: SmtpPolicy = {},
  transport: Transport = nodemailerTransport,
): Mailer {
  const header = fromHeader(from.name, from.email);
  return {
    from: header,
    async send(mail) {
      const t = transport(transportOptions(settings, await smtpAddress(settings.host, policy)));
      try {
        await t.sendMail({
          from: header,
          to: mail.to,
          subject: mail.subject.replace(/[\r\n]+/g, ' '),
          text: mail.text,
          ...(mail.html ? { html: mail.html } : {}),
          ...((mail.replyTo ?? from.replyTo) ? { replyTo: mail.replyTo ?? from.replyTo } : {}),
          ...(mail.ics ? { icalEvent: { method: 'REQUEST', content: mail.ics } } : {}),
        });
      } finally {
        t.close();
      }
    },
  };
}

/** The old way (SMTP_URL + MAIL_FROM in the environment), still honoured as the platform's server. */
export function urlMailer(url: string, from: string, transport = nodemailer.createTransport): Mailer {
  const t = transport(url);
  return {
    from,
    async send(mail) {
      await t.sendMail({
        from,
        to: mail.to,
        subject: mail.subject.replace(/[\r\n]+/g, ' '),
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        ...(mail.ics ? { icalEvent: { method: 'REQUEST', content: mail.ics } } : {}),
      });
    },
  };
}

/** Why a send failed, in words an admin can act on (never the password). */
export function smtpError(err: unknown): string {
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (e.code === 'EAUTH' || e.responseCode === 535) return 'O servidor recusou o usuário ou a senha';
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || e.code === 'ESOCKET')
    return 'Não foi possível conectar ao servidor SMTP (confira servidor, porta e segurança)';
  if (e.code === 'ETLS' || /certificate|SSL|TLS/i.test(e.message ?? ''))
    return 'Falha no TLS: confira a segurança escolhida e o certificado do servidor';
  if (e.responseCode && e.responseCode >= 500) return `O servidor recusou a mensagem (${e.responseCode})`;
  if (err instanceof Error && 'status' in err) return err.message;
  return 'O servidor SMTP não aceitou a mensagem';
}
