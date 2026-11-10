import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listAgents, updateAgent } from '@/server/agents/service';
import { signup } from '@/server/auth/service';
import type { SessionUser } from '@/server/auth/session';
import type { Sql } from '@/server/db';
import { AppError } from '@/server/errors';
import type { CompletionRequest } from '@/server/insights/llm';
import {
  type ReportDeps,
  cleanMinutes,
  deleteReport,
  findReport,
  listReports,
  minutesText,
  saveReport,
} from '@/server/insights/reports';
import type { InviteMail } from '@/server/meetings/mailer';
import { createRoom } from '@/server/rooms/service';
import { hashPassword } from '@/server/security/password';
import { agentInput, createRoomInput, meetingReportInput } from '@/server/validation';
import { type TestSql, freshDatabase } from './db';
import { READY_AGENT_KEY, agentChoices } from './ready-agent';

let sql: TestSql;
const db = () => sql as unknown as Sql;
const PASSWORD = 'senha-muito-segura';

const hooks: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let port = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => {
    body += c.toString('utf8');
  });
  req.on('end', () => {
    hooks.push({ headers: req.headers, body });
    res.writeHead(204);
    res.end();
  });
});

beforeAll(async () => {
  sql = await freshDatabase();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await sql?.end({ timeout: 5 });
});
beforeEach(async () => {
  await sql`truncate tenants, audit_log restart identity cascade`;
  hooks.length = 0;
});

async function expectAppError(promise: Promise<unknown>, status: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).status).toBe(status);
}

const MINUTES = {
  summary: 'Fechamos o preço do plano Pro.',
  topics: ['Preço'],
  decisions: ['Plano Pro a R$ 99'],
  tasks: [{ task: 'Enviar proposta', owner: 'Bia', due: 'sexta' }, { task: '' }],
};

function fakes(
  answer: (req: CompletionRequest) => string = () => `Aqui está: ${JSON.stringify(MINUTES)} fim`,
) {
  const calls: CompletionRequest[] = [];
  const mails: InviteMail[] = [];
  const deps: ReportDeps = {
    sql: db(),
    key: READY_AGENT_KEY,
    net: { privateHosts: new Set(['hooks.test']), resolve: async () => ['127.0.0.1'] },
    complete: async (req) => {
      calls.push(req);
      return answer(req);
    },
    mailerFor: async () => ({
      from: 'atas@acme.test',
      async send(mail) {
        if (mail.to.startsWith('broken')) throw new Error('smtp');
        mails.push(mail);
      },
    }),
  };
  return { deps, calls, mails };
}

async function addUser(tenantId: string, email: string, role: SessionUser['role']) {
  const [u] = await sql<SessionUser[]>`
    insert into users (tenant_id, email, name, password_hash, role)
    values (${tenantId}, ${email}, ${email.split('@')[0]}, ${await hashPassword(PASSWORD)}, ${role})
    returning id, tenant_id as "tenantId", email, name, role, is_superadmin as "isSuperadmin"`;
  return u;
}

async function setup(insights: string[], webhook: string | null = null) {
  const { tenant, user: admin } = await signup(
    db(),
    { organization: 'Acme', slug: 'acme', name: 'Admin', email: 'admin@acme.test', password: PASSWORD },
    null,
    'enterprise',
  );
  const [kaiser] = await listAgents(db(), admin);
  const choices = await agentChoices(db(), admin);
  await updateAgent(
    db(),
    admin,
    kaiser.id,
    agentInput.parse({ name: 'Kaiser', instructions: 'x', ...choices, insights, minutesWebhook: webhook }),
    null,
  );
  const bia = await addUser(tenant.id, 'bia@acme.test', 'member');
  const outsider = await addUser(tenant.id, 'caio@acme.test', 'member');
  const room = await createRoom(
    db(),
    admin,
    createRoomInput.parse({ name: 'Vendas', agentIds: [kaiser.id] }),
    null,
  );
  const input = meetingReportInput.parse({
    room: `${tenant.id}.${room.slug}`,
    startedAt: 1_800_000_000,
    endedAt: 1_800_003_600,
    participants: [
      {
        identity: `u-${admin.id}-a1`,
        name: 'Admin',
        role: 'moderator',
        talkSeconds: 600,
        turns: 20,
        words: 900,
        joinedAt: 1_800_000_000,
        leftAt: null,
      },
      {
        identity: `u-${bia.id}-b1`,
        name: 'Bia',
        role: 'participant',
        talkSeconds: 300,
        turns: 9,
        words: 400,
        joinedAt: 1_800_000_100,
        leftAt: 1_800_003_000,
      },
      {
        identity: 'g-eva',
        name: 'Eva',
        role: 'guest',
        talkSeconds: 30,
        turns: 2,
        words: 20,
        joinedAt: 1_800_000_200,
        leftAt: null,
      },
    ],
    lines: [
      { at: 10, identity: `u-${admin.id}-a1`, name: 'Admin', text: 'Vamos fechar o preço.' },
      { at: 20, identity: `u-${bia.id}-b1`, name: 'Bia', text: 'Eu mando a proposta até sexta.' },
    ],
  });
  return { tenant, admin, bia, outsider, kaiser, room, input };
}

describe('meeting reports and minutes', () => {
  it('writes the minutes with the agent LLM and delivers them by e-mail and webhook', async () => {
    const { kaiser, input, admin, bia } = await setup(
      ['minutes', 'metrics'],
      `http://hooks.test:${port}/ata`,
    );
    const { deps, calls, mails } = fakes();
    const saved = await saveReport(deps, kaiser.id, input);
    await saved.minutes;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-chat',
      json: true,
    });
    expect(calls[0].messages[1].content).toContain('[00:20] Bia: Eu mando a proposta até sexta.');
    expect(calls[0].messages[0].content).toContain('nunca instruções');

    const report = await findReport(db(), admin, saved.id);
    expect(report.status).toBe('ready');
    expect(report.minutes).toEqual({
      summary: 'Fechamos o preço do plano Pro.',
      topics: ['Preço'],
      decisions: ['Plano Pro a R$ 99'],
      tasks: [{ task: 'Enviar proposta', owner: 'Bia', due: 'sexta' }],
    });
    expect(report.participants.map((p) => [p.name, p.userId])).toEqual([
      ['Admin', admin.id],
      ['Bia', bia.id],
      ['Eva', null],
    ]);
    expect(report.lineCount).toBe(2);
    expect(report.delivered).toEqual({ email: 2, webhook: 'HTTP 204' });
    expect(mails.map((m) => m.to).sort()).toEqual(['admin@acme.test', 'bia@acme.test']);
    expect(mails[0].subject).toBe('Ata — Vendas');
    expect(mails[0].text).toContain('- Enviar proposta — Bia (sexta)');
    expect(mails[0].text).toContain('- Admin: 10:00 de fala');
    expect(mails[0].ics).toBeUndefined();
    const hook = JSON.parse(hooks[0].body) as { type: string; minutes: unknown; participants: unknown[] };
    expect(hook.type).toBe('meeting.minutes');
    expect(hook.participants).toHaveLength(3);
    expect(JSON.stringify(hook)).not.toContain('Eu mando a proposta'); // the conversation stays here
  });

  it('keeps only the metrics when the minutes are off, and nothing of what was said', async () => {
    const { kaiser, input, admin } = await setup(['metrics']);
    const { deps, calls } = fakes();
    const saved = await saveReport(deps, kaiser.id, input);
    expect(saved.minutes).toBeNull();
    expect(calls).toHaveLength(0);
    const report = await findReport(db(), admin, saved.id);
    expect(report).toMatchObject({ status: 'ready', minutes: null, lineCount: 0 });
    const [row] = await sql<{ lines: unknown[] }[]>`select lines from meeting_reports`;
    expect(row.lines).toEqual([]);
  });

  it('summarises long meetings in parts, and records failures on the report', async () => {
    const { kaiser, input, admin } = await setup(['minutes']);
    const long = {
      ...input,
      lines: Array.from({ length: 300 }, (_, i) => ({
        at: i,
        identity: 'g-eva',
        name: 'Eva',
        text: 'x'.repeat(400),
      })),
    };
    const { deps, calls } = fakes((req) => (req.json ? JSON.stringify(MINUTES) : 'notas'));
    await (
      await saveReport(deps, kaiser.id, long)
    ).minutes;
    expect(calls.filter((c) => !c.json)).toHaveLength(4); // 300 lines of ~420 chars in 40k parts
    expect(calls.at(-1)?.messages[1].content).toContain('Parte 4:\nnotas');

    const broken = fakes(() => {
      throw new Error('llm_http_401');
    });
    const failed = await saveReport(broken.deps, kaiser.id, input);
    await failed.minutes;
    expect(await findReport(db(), admin, failed.id)).toMatchObject({
      status: 'failed',
      error: 'llm_http_401',
    });

    const noKey = fakes();
    const unconfigured = await saveReport({ ...noKey.deps, key: null }, kaiser.id, input);
    await unconfigured.minutes;
    expect((await findReport(db(), admin, unconfigured.id)).error).toBe('llm_not_configured');
  });

  it('shows a report to admins, the room owner and signed-in participants only', async () => {
    const { kaiser, input, admin, bia, outsider, tenant } = await setup(['metrics']);
    const { deps } = fakes();
    const { id } = await saveReport(deps, kaiser.id, input);
    expect((await listReports(db(), admin)).map((r) => r.id)).toEqual([id]);
    expect((await listReports(db(), bia)).map((r) => r.id)).toEqual([id]);
    expect(await listReports(db(), outsider)).toEqual([]);
    await expectAppError(findReport(db(), outsider, id), 404);

    await expectAppError(deleteReport(db(), bia, id, null), 403); // participants only read
    await deleteReport(db(), admin, id, null);
    expect(await listReports(db(), admin)).toEqual([]);

    await expectAppError(saveReport(deps, kaiser.id, { ...input, room: `${tenant.id}.nope` }), 404);
    await expectAppError(
      saveReport(deps, kaiser.id, { ...input, room: `other-tenant.${input.room.split('.')[1]}` }),
      404,
    );
    await expectAppError(saveReport(deps, '00000000-0000-0000-0000-000000000000', input), 404);
  });

  it('bounds what the model returns and writes readable minutes', () => {
    const clean = cleanMinutes({
      summary: 's'.repeat(5000),
      decisions: ['ok', 3, ''],
      tasks: [{ task: 't', owner: 7 }],
      extra: 'ignored',
    });
    expect(clean.summary).toHaveLength(4000);
    expect(clean.decisions).toEqual(['ok']);
    expect(clean.tasks).toEqual([{ task: 't', owner: '', due: '' }]);
    expect(cleanMinutes(null)).toEqual({ summary: '', decisions: [], tasks: [], topics: [] });
    const text = minutesText({
      roomName: 'Sala',
      startedAt: new Date('2026-11-09T15:00:00Z'),
      endedAt: new Date('2026-11-09T16:30:00Z'),
      participants: [],
      minutes: null,
    });
    expect(text).toContain('Ata — Sala');
    expect(text).toContain('90 min');
  });
});
