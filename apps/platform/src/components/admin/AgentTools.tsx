'use client';

import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { api } from '../api';
import { messageOf, useLoad } from './useLoad';

type Kind = 'http' | 'mcp';
type Access = 'moderators' | 'members';
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type ParamType = 'string' | 'number' | 'integer' | 'boolean';

interface Param {
  name: string;
  type: ParamType;
  description: string;
  required: boolean;
}

export interface AgentTool {
  id: string;
  kind: Kind;
  name: string;
  description: string;
  enabled: boolean;
  access: Access;
  confirm: boolean;
  url: string;
  method: Method | null;
  params: Param[];
  bodyTemplate: string | null;
  mcpTools: string[];
  timeoutMs: number;
  headerNames: string[];
}

interface Draft {
  id: string | null;
  kind: Kind;
  name: string;
  description: string;
  enabled: boolean;
  access: Access;
  confirm: boolean;
  url: string;
  method: Method;
  params: Param[];
  bodyTemplate: string;
  mcpTools: string[];
  timeoutS: number;
  /** Saved headers show an empty value: leaving it empty keeps the secret. */
  headers: { name: string; value: string; saved: boolean }[];
}

interface TestResult {
  ok: boolean;
  output?: string;
  status?: number;
  tools?: { name: string; description: string }[];
}

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PARAM_TYPES: ParamType[] = ['string', 'number', 'integer', 'boolean'];
const WITH_BODY = new Set<Method>(['POST', 'PUT', 'PATCH']);
const URL_EXAMPLE = 'https://api.suaempresa.com/pedidos/{{numero}}';
const BODY_EXAMPLE = '{"titulo": "{{titulo}}", "prioridade": "{{prioridade}}"}';

const blank = (kind: Kind): Draft => ({
  id: null,
  kind,
  name: '',
  description: '',
  enabled: true,
  access: 'moderators',
  confirm: true,
  url: '',
  method: 'GET',
  params: [],
  bodyTemplate: '',
  mcpTools: [],
  timeoutS: 10,
  headers: [],
});

function fromTool(tool: AgentTool): Draft {
  return {
    id: tool.id,
    kind: tool.kind,
    name: tool.name,
    description: tool.description,
    enabled: tool.enabled,
    access: tool.access,
    confirm: tool.confirm,
    url: tool.url,
    method: tool.method ?? 'GET',
    params: tool.params,
    bodyTemplate: tool.bodyTemplate ?? '',
    mcpTools: tool.mcpTools,
    timeoutS: Math.round(tool.timeoutMs / 1000),
    headers: tool.headerNames.map((name) => ({ name, value: '', saved: true })),
  };
}

/** The agent's HTTP and MCP tools; each is saved on its own, apart from the agent form. */
export function AgentTools({ agentId }: { agentId: string }) {
  const t = useT();
  const path = `/api/admin/agents/${agentId}/tools`;
  const { data, error, setError, reload } = useLoad<{ tools: AgentTool[] }>(path);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testArgs, setTestArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<TestResult | null>(null);
  const [offered, setOffered] = useState<{ name: string; description: string }[] | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    draft && setDraft({ ...draft, [key]: value });

  function open(next: Draft) {
    setDraft(next);
    setOffered(null);
    setResult(null);
    setTesting(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    const common = {
      kind: draft.kind,
      name: draft.name.trim(),
      description: draft.description,
      enabled: draft.enabled,
      access: draft.access,
      confirm: draft.confirm,
      url: draft.url.trim(),
      timeoutMs: Math.round(draft.timeoutS * 1000),
      headers: draft.headers
        .filter((h) => h.name.trim())
        .map((h) => ({ name: h.name.trim(), value: h.value })),
    };
    const body =
      draft.kind === 'http'
        ? {
            ...common,
            method: draft.method,
            params: draft.params.filter((p) => p.name.trim()),
            bodyTemplate:
              WITH_BODY.has(draft.method) && draft.bodyTemplate.trim() ? draft.bodyTemplate : null,
          }
        : { ...common, mcpTools: draft.mcpTools };
    try {
      const saved = draft.id
        ? await api<{ tool: AgentTool }>(`${path}/${draft.id}`, { method: 'PUT', body })
        : await api<{ tool: AgentTool }>(path, { body });
      await reload();
      // A new MCP server stays open so its tools can be fetched and picked.
      if (draft.kind === 'mcp' && !draft.id) open(fromTool(saved.tool));
      else setDraft(null);
    } catch (err) {
      setError(messageOf(err, t('admin.tools.couldNotSave')));
    } finally {
      setBusy(false);
    }
  }

  async function remove(tool: AgentTool) {
    if (!window.confirm(t('admin.tools.confirmDelete', { name: tool.name }))) return;
    try {
      await api(`${path}/${tool.id}`, { method: 'DELETE', body: {} });
      await reload();
    } catch (err) {
      setError(messageOf(err, t('admin.couldNotDelete')));
    }
  }

  async function runTest(tool: AgentTool) {
    setBusy(true);
    setResult(null);
    try {
      const args = Object.fromEntries(Object.entries(testArgs).filter(([, v]) => v !== ''));
      const res = await api<TestResult>(`${path}/${tool.id}/test`, { body: { args } });
      if (tool.kind === 'mcp') setOffered(res.tools ?? []);
      setResult(res);
    } catch (err) {
      setResult({ ok: false, output: messageOf(err, t('admin.tools.couldNotTest')) });
    } finally {
      setBusy(false);
    }
  }

  const tools = data?.tools ?? [];

  return (
    <section
      className="card form"
      style={{ maxWidth: 820, margin: '16px 0 0' }}
      aria-labelledby="agent-tools"
    >
      <strong id="agent-tools">{t('admin.tools.legend')}</strong>
      <p className="muted small-print">{t('admin.tools.intro')}</p>
      <div className="error" role="alert">
        {error}
      </div>
      {tools.length === 0 && !draft && <p className="muted">{t('admin.tools.empty')}</p>}
      <ul className="rooms">
        {tools.map((tool) => (
          <li key={tool.id}>
            <div>
              <strong>{tool.name}</strong>
              <span className="badge">{tool.kind === 'http' ? `HTTP ${tool.method}` : 'MCP'}</span>
              <span className="badge">
                🔒{' '}
                {tool.access === 'members' ? t('admin.tools.membersBadge') : t('admin.tools.moderatorsBadge')}
              </span>
              {tool.confirm && <span className="badge">✋ {t('admin.tools.confirmBadge')}</span>}
              {tool.kind === 'mcp' && (
                <span className="badge">
                  {t('admin.tools.mcpCount', { count: String(tool.mcpTools.length) })}
                </span>
              )}
              {!tool.enabled && <span className="badge warn">{t('admin.tools.off')}</span>}
              <div className="muted" style={{ fontSize: 13, marginTop: 4, wordBreak: 'break-all' }}>
                {tool.url}
              </div>
              {testing === tool.id && (
                <div className="form" style={{ marginTop: 8 }}>
                  {tool.kind === 'http' && tool.params.length > 0 && (
                    <fieldset className="group">
                      <legend>{t('admin.tools.testArgs')}</legend>
                      {tool.params.map((p) => (
                        <label key={p.name}>
                          {p.name}
                          <input
                            value={testArgs[p.name] ?? ''}
                            onChange={(e) => setTestArgs({ ...testArgs, [p.name]: e.target.value })}
                          />
                        </label>
                      ))}
                    </fieldset>
                  )}
                  <button type="button" className="btn small" disabled={busy} onClick={() => runTest(tool)}>
                    {busy ? t('admin.tools.testing') : t('admin.tools.runTest')}
                  </button>
                  {result && (
                    <div role="status">
                      <strong>
                        {result.ok ? `✅ ${t('admin.tools.testOk')}` : `⚠️ ${t('admin.tools.testFailed')}`}
                      </strong>
                      {result.output && <pre className="tool-output">{result.output}</pre>}
                      {result.tools && (
                        <ul>
                          {result.tools.map((x) => (
                            <li key={x.name}>
                              <code>{x.name}</code> {x.description}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="row">
              <button
                type="button"
                className="btn secondary small"
                onClick={() => {
                  setTesting(testing === tool.id ? null : tool.id);
                  setTestArgs({});
                  setResult(null);
                }}
              >
                {t('admin.tools.test')}
              </button>
              <button type="button" className="btn secondary small" onClick={() => open(fromTool(tool))}>
                {t('common.edit')}
              </button>
              <button type="button" className="btn danger small" onClick={() => remove(tool)}>
                {t('common.delete')}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {!draft && (
        <div className="row">
          <button type="button" className="btn secondary" onClick={() => open(blank('http'))}>
            {t('admin.tools.addHttp')}
          </button>
          <button type="button" className="btn secondary" onClick={() => open(blank('mcp'))}>
            {t('admin.tools.addMcp')}
          </button>
        </div>
      )}

      {draft && (
        <form onSubmit={save} className="form">
          <strong>
            {draft.id
              ? t('admin.editNamed', { name: draft.name })
              : draft.kind === 'http'
                ? t('admin.tools.newHttp')
                : t('admin.tools.newMcp')}
          </strong>
          <label>
            {t('admin.tools.nameLabel')}
            <input
              required
              maxLength={40}
              pattern="[a-z][a-z0-9_]{1,39}"
              value={draft.name}
              onChange={(e) => set('name', e.target.value.toLowerCase())}
              placeholder={draft.kind === 'http' ? 'consultar_pedido' : 'crm'}
            />
          </label>
          <label>
            {draft.kind === 'http' ? t('admin.tools.descriptionLabel') : t('admin.tools.mcpDescriptionLabel')}
            <textarea
              rows={3}
              maxLength={1000}
              required={draft.kind === 'http'}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder={draft.kind === 'http' ? t('admin.tools.descriptionPlaceholder') : ''}
            />
          </label>
          <div className="row">
            {draft.kind === 'http' && (
              <label>
                {t('admin.tools.methodLabel')}
                <select value={draft.method} onChange={(e) => set('method', e.target.value as Method)}>
                  {METHODS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              </label>
            )}
            <label style={{ flex: 1 }}>
              {draft.kind === 'http' ? t('admin.tools.urlLabel') : t('admin.tools.mcpUrlLabel')}
              <input
                required
                type="text"
                inputMode="url"
                maxLength={2000}
                value={draft.url}
                onChange={(e) => set('url', e.target.value)}
                placeholder={draft.kind === 'http' ? URL_EXAMPLE : 'https://mcp.suaempresa.com/mcp'}
              />
            </label>
          </div>
          <span className="muted small-print">
            {draft.kind === 'http' ? (
              <>
                {t('admin.tools.urlHelp')} <code>{URL_EXAMPLE}</code>
              </>
            ) : (
              t('admin.tools.mcpUrlHelp')
            )}
          </span>

          {draft.kind === 'http' && (
            <fieldset className="group">
              <legend>{t('admin.tools.paramsLegend')}</legend>
              {draft.params.map((p, i) => {
                const update = (patch: Partial<Param>) =>
                  set(
                    'params',
                    draft.params.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                  );
                return (
                  <div className="row" key={i}>
                    <label>
                      {t('admin.tools.paramName')}
                      <input
                        required
                        maxLength={40}
                        pattern="[A-Za-z_][A-Za-z0-9_]{0,39}"
                        value={p.name}
                        onChange={(e) => update({ name: e.target.value })}
                      />
                    </label>
                    <label>
                      {t('admin.tools.paramType')}
                      <select value={p.type} onChange={(e) => update({ type: e.target.value as ParamType })}>
                        {PARAM_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {t(`admin.tools.types.${type}`)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label style={{ flex: 1 }}>
                      {t('admin.tools.paramDescription')}
                      <input
                        maxLength={300}
                        value={p.description}
                        onChange={(e) => update({ description: e.target.value })}
                      />
                    </label>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={p.required}
                        onChange={(e) => update({ required: e.target.checked })}
                      />
                      <span>{t('admin.tools.paramRequired')}</span>
                    </label>
                    <button
                      type="button"
                      className="btn danger small"
                      aria-label={t('admin.tools.removeParam', { name: p.name || String(i + 1) })}
                      onClick={() =>
                        set(
                          'params',
                          draft.params.filter((_, j) => j !== i),
                        )
                      }
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
              {draft.params.length < 20 && (
                <button
                  type="button"
                  className="btn secondary small"
                  onClick={() =>
                    set('params', [
                      ...draft.params,
                      { name: '', type: 'string', description: '', required: false },
                    ])
                  }
                >
                  {t('admin.tools.addParam')}
                </button>
              )}
              {WITH_BODY.has(draft.method) && (
                <label>
                  {t('admin.tools.bodyLabel')}
                  <textarea
                    rows={4}
                    maxLength={8000}
                    value={draft.bodyTemplate}
                    onChange={(e) => set('bodyTemplate', e.target.value)}
                    placeholder={BODY_EXAMPLE}
                    spellCheck={false}
                  />
                  <span className="muted small-print">{t('admin.tools.bodyHelp')}</span>
                </label>
              )}
            </fieldset>
          )}

          {draft.kind === 'mcp' && (
            <fieldset className="group">
              <legend>{t('admin.tools.mcpToolsLegend')}</legend>
              <p className="muted small-print">{t('admin.tools.mcpToolsHelp')}</p>
              {!draft.id ? (
                <p className="muted">{t('admin.tools.saveToFetch')}</p>
              ) : (
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={busy}
                  onClick={() => {
                    const tool = tools.find((x) => x.id === draft.id);
                    if (tool) void runTest(tool);
                  }}
                >
                  {busy ? t('admin.tools.testing') : t('admin.tools.fetchMcp')}
                </button>
              )}
              {result && !result.ok && testing === null && <div className="error">{result.output}</div>}
              {offered?.length === 0 && <p className="muted">{t('admin.tools.noMcpTools')}</p>}
              {[...new Set([...(offered ?? []).map((x) => x.name), ...draft.mcpTools])].map((name) => (
                <label key={name} className="switch">
                  <input
                    type="checkbox"
                    checked={draft.mcpTools.includes(name)}
                    onChange={(e) =>
                      set(
                        'mcpTools',
                        e.target.checked
                          ? [...draft.mcpTools, name]
                          : draft.mcpTools.filter((x) => x !== name),
                      )
                    }
                  />
                  <span>
                    <code>{name}</code>
                    <small>{offered?.find((x) => x.name === name)?.description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          <fieldset className="group">
            <legend>{t('admin.tools.headersLegend')}</legend>
            <p className="muted small-print">{t('admin.tools.headersHelp')}</p>
            {draft.headers.map((h, i) => {
              const update = (patch: Partial<Draft['headers'][number]>) =>
                set(
                  'headers',
                  draft.headers.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                );
              return (
                <div className="row" key={i}>
                  <label>
                    {t('admin.tools.headerName')}
                    <input
                      maxLength={64}
                      pattern="[A-Za-z0-9-]{1,64}"
                      value={h.name}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </label>
                  <label style={{ flex: 1 }}>
                    {t('admin.tools.headerValue')}
                    <input
                      type="password"
                      autoComplete="off"
                      maxLength={4000}
                      required={!h.saved}
                      value={h.value}
                      onChange={(e) => update({ value: e.target.value })}
                      placeholder={h.saved ? t('admin.tools.headerSaved') : 'Bearer …'}
                    />
                  </label>
                  <button
                    type="button"
                    className="btn danger small"
                    aria-label={t('admin.tools.removeHeader', { name: h.name || String(i + 1) })}
                    onClick={() =>
                      set(
                        'headers',
                        draft.headers.filter((_, j) => j !== i),
                      )
                    }
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            {draft.headers.length < 20 && (
              <button
                type="button"
                className="btn secondary small"
                onClick={() => set('headers', [...draft.headers, { name: '', value: '', saved: false }])}
              >
                {t('admin.tools.addHeader')}
              </button>
            )}
          </fieldset>

          <fieldset className="group">
            <legend>{t('admin.tools.accessLegend')}</legend>
            {(['moderators', 'members'] as Access[]).map((access) => (
              <label key={access} className="switch">
                <input
                  type="radio"
                  name="tool-access"
                  checked={draft.access === access}
                  onChange={() => set('access', access)}
                />
                <span>{t(`admin.tools.access.${access}`)}</span>
              </label>
            ))}
            <p className="muted small-print">{t('admin.tools.accessHelp')}</p>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.confirm}
                onChange={(e) => set('confirm', e.target.checked)}
              />
              <span>
                {t('admin.tools.confirmLabel')}
                <small>{t('admin.tools.confirmHelp')}</small>
              </span>
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
              />
              <span>{t('admin.tools.enabledLabel')}</span>
            </label>
            <label>
              {t('admin.tools.timeoutLabel')}
              <input
                type="number"
                min={1}
                max={30}
                value={draft.timeoutS}
                onChange={(e) => set('timeoutS', Math.min(30, Math.max(1, Number(e.target.value) || 10)))}
              />
            </label>
          </fieldset>

          <div className="row">
            <button className="btn" disabled={busy}>
              {t('admin.tools.save')}
            </button>
            <button type="button" className="btn secondary" onClick={() => setDraft(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
