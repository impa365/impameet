import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { audit } from '../audit';
import type { SessionUser } from '../auth/session';
import type { Sql } from '../db';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { type Resolver, assertPublicHttpsUrl, systemResolver } from '../security/public-url';
import { openSecret, sealSecret, secretHint } from '../security/secrets';
import type { integrationInput } from '../validation';
import { type Fetch, type ProbeResult, probeFish, probeLlm } from './probe';

export type IntegrationKind = 'llm' | 'fish';
export type IntegrationInput = z.infer<typeof integrationInput>;

export interface Integration {
  id: string;
  kind: IntegrationKind;
  name: string;
  baseUrl: string | null;
  defaultModel: string | null;
  models: string[];
  secretHint: string;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  usedBy: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Everything that touches secrets or the network, injectable in tests. */
export interface IntegrationDeps {
  sql: Sql;
  key: Buffer;
  resolve?: Resolver;
  fetch?: Fetch;
}

const COLUMNS = (sql: Sql) => sql`
  i.id, i.kind, i.name, i.base_url as "baseUrl", i.default_model as "defaultModel", i.models,
  i.secret_hint as "secretHint", i.last_tested_at as "lastTestedAt", i.last_test_ok as "lastTestOk",
  i.last_test_error as "lastTestError", i.created_at as "createdAt", i.updated_at as "updatedAt",
  (select count(*)::int from agents a
    where a.llm_integration_id = i.id or a.fish_integration_id = i.id) as "usedBy"`;

/** Ties each ciphertext to its organization and record. */
const aad = (tenantId: string, id: string) => `integration:${tenantId}:${id}`;

function assertAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw forbidden('Só administradores gerenciam integrações');
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === '23505';

export async function listIntegrations(sql: Sql, user: SessionUser): Promise<Integration[]> {
  assertAdmin(user);
  return sql<Integration[]>`
    select ${COLUMNS(sql)} from integrations i
    where i.tenant_id = ${user.tenantId} order by i.kind, i.name`;
}

async function findIntegration(sql: Sql, tenantId: string, id: string): Promise<Integration> {
  const [row] = await sql<Integration[]>`
    select ${COLUMNS(sql)} from integrations i where i.id = ${id} and i.tenant_id = ${tenantId}`;
  if (!row) throw notFound('Integração não encontrada');
  return row;
}

async function fields(deps: IntegrationDeps, input: IntegrationInput) {
  if (input.kind === 'fish')
    return { baseUrl: null, defaultModel: input.defaultModel, models: [] as string[] };
  const baseUrl = await assertPublicHttpsUrl(input.baseUrl, deps.resolve ?? systemResolver);
  const models = [...new Set([input.defaultModel, ...input.models])];
  return { baseUrl, defaultModel: input.defaultModel, models };
}

export async function createIntegration(
  deps: IntegrationDeps,
  actor: SessionUser,
  input: IntegrationInput,
  ip: string | null,
): Promise<Integration> {
  assertAdmin(actor);
  if (!input.apiKey) throw badRequest('Informe a chave de API');
  const { sql } = deps;
  const id = randomUUID();
  const f = await fields(deps, input);
  const sealed = sealSecret(deps.key, input.apiKey, aad(actor.tenantId, id));
  try {
    await sql`
      insert into integrations (id, tenant_id, kind, name, base_url, default_model, models,
                                secret_sealed, secret_hint, created_by)
      values (${id}, ${actor.tenantId}, ${input.kind}, ${input.name}, ${f.baseUrl}, ${f.defaultModel},
              ${f.models}, ${sealed}, ${secretHint(input.apiKey)}, ${actor.id})`;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe uma integração com esse nome');
    throw err;
  }
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'integration.created',
    target: input.name,
    ip,
  });
  return findIntegration(sql, actor.tenantId, id);
}

/** Leaving the key empty keeps the saved one. The kind of an integration never changes. */
export async function updateIntegration(
  deps: IntegrationDeps,
  actor: SessionUser,
  id: string,
  input: IntegrationInput,
  ip: string | null,
): Promise<Integration> {
  assertAdmin(actor);
  const { sql } = deps;
  const current = await findIntegration(sql, actor.tenantId, id);
  if (current.kind !== input.kind) throw badRequest('Não é possível mudar o tipo da integração');
  const f = await fields(deps, input);
  const sealed = input.apiKey ? sealSecret(deps.key, input.apiKey, aad(actor.tenantId, id)) : null;
  try {
    await sql`
      update integrations set name = ${input.name}, base_url = ${f.baseUrl},
        default_model = ${f.defaultModel}, models = ${f.models},
        secret_sealed = coalesce(${sealed}, secret_sealed),
        secret_hint = coalesce(${input.apiKey ? secretHint(input.apiKey) : null}, secret_hint),
        last_test_ok = case when ${sealed !== null}::boolean then null else last_test_ok end,
        updated_at = now()
      where id = ${id} and tenant_id = ${actor.tenantId}`;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Já existe uma integração com esse nome');
    throw err;
  }
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'integration.updated',
    target: input.name,
    ip,
  });
  return findIntegration(sql, actor.tenantId, id);
}

/** Agents using it fall back to the server's own credentials. */
export async function deleteIntegration(
  sql: Sql,
  actor: SessionUser,
  id: string,
  ip: string | null,
): Promise<void> {
  assertAdmin(actor);
  const [row] = await sql<{ name: string }[]>`
    delete from integrations where id = ${id} and tenant_id = ${actor.tenantId} returning name`;
  if (!row) throw notFound('Integração não encontrada');
  await audit(sql, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    action: 'integration.deleted',
    target: row.name,
    ip,
  });
}

/** The decrypted key, for server-side use only (probe, voice worker). */
export async function integrationSecret(
  sql: Sql,
  key: Buffer,
  tenantId: string,
  id: string,
): Promise<{ kind: IntegrationKind; baseUrl: string | null; defaultModel: string | null; apiKey: string }> {
  const [row] = await sql<
    { kind: IntegrationKind; baseUrl: string | null; defaultModel: string | null; sealed: string }[]
  >`
    select kind, base_url as "baseUrl", default_model as "defaultModel", secret_sealed as sealed
    from integrations where id = ${id} and tenant_id = ${tenantId}`;
  if (!row) throw notFound('Integração não encontrada');
  return {
    kind: row.kind,
    baseUrl: row.baseUrl,
    defaultModel: row.defaultModel,
    apiKey: openSecret(key, row.sealed, aad(tenantId, id)),
  };
}

/** "Testar conexão": checks the key live and records the outcome (models are returned, not saved). */
export async function testIntegration(
  deps: IntegrationDeps,
  actor: SessionUser,
  id: string,
): Promise<ProbeResult> {
  assertAdmin(actor);
  const secret = await integrationSecret(deps.sql, deps.key, actor.tenantId, id);
  const fetchImpl = deps.fetch ?? fetch;
  let result: ProbeResult;
  if (secret.kind === 'llm') {
    const baseUrl = await assertPublicHttpsUrl(secret.baseUrl ?? '', deps.resolve ?? systemResolver);
    result = await probeLlm(fetchImpl, baseUrl, secret.apiKey);
  } else {
    result = await probeFish(fetchImpl, secret.apiKey);
  }
  await deps.sql`
    update integrations set last_tested_at = now(), last_test_ok = ${result.ok},
      last_test_error = ${result.ok ? null : result.error}
    where id = ${id} and tenant_id = ${actor.tenantId}`;
  return result;
}

/** An agent may only use this organization's integrations, of the right kind. */
export async function assertTenantIntegration(
  sql: Sql,
  tenantId: string,
  id: string | null,
  kind: IntegrationKind,
): Promise<void> {
  if (!id) return;
  const [row] = await sql<{ kind: string }[]>`
    select kind from integrations where id = ${id} and tenant_id = ${tenantId}`;
  if (!row) throw notFound('Integração não encontrada');
  if (row.kind !== kind)
    throw badRequest(
      kind === 'llm' ? 'Escolha uma integração de LLM' : 'Escolha uma integração do Fish Audio',
    );
}
