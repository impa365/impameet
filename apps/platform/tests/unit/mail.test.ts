import { describe, expect, it } from 'vitest';
import { AppError } from '@/server/errors';
import {
  type Transport,
  fromHeader,
  smtpAddress,
  smtpError,
  smtpMailer,
  transportOptions,
  urlMailer,
} from '@/server/mail/smtp';
import { platformSmtpInput, tenantSmtpInput } from '@/server/validation';

const settings = {
  host: 'smtp.acme.com',
  port: 587,
  security: 'starttls' as const,
  username: 'user',
  password: 'segredo',
  fromEmail: 'reunioes@acme.com',
  fromName: 'Acme',
  replyTo: null,
};

describe('SMTP', () => {
  it('connects to the checked address, keeps TLS on the real name and refuses internal servers', async () => {
    const opts = transportOptions(settings, '93.184.215.14');
    expect(opts).toMatchObject({
      host: '93.184.215.14',
      port: 587,
      secure: false,
      requireTLS: true,
      ignoreTLS: false,
      auth: { user: 'user', pass: 'segredo' },
      tls: { servername: 'smtp.acme.com', minVersion: 'TLSv1.2' },
    });
    expect(transportOptions({ ...settings, security: 'tls', username: '' }, '1.1.1.1')).toMatchObject({
      secure: true,
      auth: undefined,
    });
    expect(transportOptions({ ...settings, host: '1.1.1.1' }, '1.1.1.1').tls.servername).toBeUndefined();

    const resolve = async (host: string) => (host === 'interno.acme.com' ? ['10.0.0.5'] : ['93.184.215.14']);
    expect(await smtpAddress('SMTP.acme.com', { resolve })).toBe('93.184.215.14');
    await expect(smtpAddress('interno.acme.com', { resolve })).rejects.toThrow(/internet pública/);
    expect(await smtpAddress('interno.acme.com', { resolve, allowPrivate: true })).toBe('10.0.0.5');
    await expect(smtpAddress('127.0.0.1')).rejects.toThrow(/internet pública/);
    await expect(smtpAddress('nada.invalid', { resolve: async () => [] })).rejects.toThrow(/não encontrado/);
  });

  it('builds a clean sender and message, and always closes the connection', async () => {
    expect(fromHeader('Acme "Meet"\r\nBcc: x', 'a@acme.com')).toBe('"Acme MeetBcc: x" <a@acme.com>');
    expect(fromHeader('  ', 'a@acme.com')).toBe('a@acme.com');
    const sent: Record<string, unknown>[] = [];
    let closed = 0;
    const transport: Transport = (options) => ({
      async sendMail(mail) {
        if (options.host !== '93.184.215.14') throw new Error('wrong host');
        if (mail.to === 'falha@x.com') throw Object.assign(new Error('auth'), { code: 'EAUTH' });
        sent.push(mail);
      },
      close: () => void (closed += 1),
    });
    const mailer = smtpMailer(
      settings,
      { name: 'Acme', email: 'reunioes@acme.com', replyTo: 'contato@acme.com' },
      { resolve: async () => ['93.184.215.14'] },
      transport,
    );
    expect(mailer.from).toBe('"Acme" <reunioes@acme.com>');
    await mailer.send({ to: 'ana@x.com', subject: 'Olá\r\nBcc: y', text: 'oi', ics: 'BEGIN:VCALENDAR' });
    expect(sent[0]).toMatchObject({
      from: '"Acme" <reunioes@acme.com>',
      to: 'ana@x.com',
      subject: 'Olá Bcc: y',
      replyTo: 'contato@acme.com',
      icalEvent: { method: 'REQUEST', content: 'BEGIN:VCALENDAR' },
    });
    await expect(mailer.send({ to: 'falha@x.com', subject: 's', text: 't' })).rejects.toThrow('auth');
    expect(closed).toBe(2);
  });

  it("still sends through the environment's SMTP_URL", async () => {
    const sent: Record<string, unknown>[] = [];
    const factory = ((url: string) => {
      expect(url).toBe('smtp://relay.local:25');
      return { sendMail: async (m: Record<string, unknown>) => void sent.push(m) };
    }) as unknown as Parameters<typeof urlMailer>[2];
    const mailer = urlMailer('smtp://relay.local:25', 'meet@impa.local', factory);
    expect(mailer.from).toBe('meet@impa.local');
    await mailer.send({
      to: 'a@b.com',
      subject: 'Oi\nx',
      text: 't',
      html: '<p>t</p>',
      replyTo: 'r@b.com',
      ics: 'ICS',
    });
    expect(sent[0]).toEqual({
      from: 'meet@impa.local',
      to: 'a@b.com',
      subject: 'Oi x',
      text: 't',
      html: '<p>t</p>',
      replyTo: 'r@b.com',
      icalEvent: { method: 'REQUEST', content: 'ICS' },
    });
  });

  it('explains failures without leaking anything', () => {
    expect(smtpError(Object.assign(new Error('x'), { code: 'EAUTH' }))).toMatch(/usuário ou a senha/);
    expect(smtpError(Object.assign(new Error('x'), { responseCode: 535 }))).toMatch(/usuário ou a senha/);
    expect(smtpError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toMatch(/conectar/);
    expect(smtpError(new Error('self signed certificate'))).toMatch(/TLS/);
    expect(smtpError(Object.assign(new Error('x'), { responseCode: 550 }))).toBe(
      'O servidor recusou a mensagem (550)',
    );
    expect(smtpError(new AppError(400, 'bad_request', 'Servidor SMTP não encontrado'))).toBe(
      'Servidor SMTP não encontrado',
    );
    expect(smtpError('???')).toBe('O servidor SMTP não aceitou a mensagem');
  });

  it('validates what admins type', () => {
    expect(tenantSmtpInput.parse({ mode: 'platform' })).toEqual({ mode: 'platform' });
    const custom = tenantSmtpInput.parse({
      mode: 'custom',
      host: 'SMTP.Acme.com',
      port: 587,
      security: 'starttls',
      fromEmail: 'Reunioes@Acme.com',
    });
    expect(custom).toMatchObject({
      host: 'smtp.acme.com',
      fromEmail: 'reunioes@acme.com',
      username: '',
      replyTo: null,
    });
    for (const host of ['smtp acme', 'smtp.acme.com:25', 'http://x', '-x.com'])
      expect(tenantSmtpInput.safeParse({ ...custom, host }).success).toBe(false);
    expect(tenantSmtpInput.safeParse({ ...custom, security: 'ssl' }).success).toBe(false);
    expect(tenantSmtpInput.safeParse({ mode: 'custom' }).success).toBe(false);
    expect(platformSmtpInput.parse({ ...custom, mode: undefined }).offerToTenants).toBe(true);
  });
});
