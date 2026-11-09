import http from 'node:http';
import https from 'node:https';
import { type LookupFunction, isIP } from 'node:net';
import { type Resolver, isPublicIp, systemResolver } from '../security/public-url';

/** Where agent tools may connect. */
export interface NetPolicy {
  /** Host names the server operator allows on a private network (and over plain http). */
  privateHosts: ReadonlySet<string>;
  resolve?: Resolver;
}

export interface OutboundRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  /** Stops reading once the answer is complete (MCP replies may stream on an open connection). */
  done?: (text: string) => boolean;
}

export interface OutboundResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

/** A tool call that could not be made; the message is safe to show and to tell the model. */
export class ToolNetworkError extends Error {}

const BLOCKED = 'A URL precisa apontar para um endereço público na internet';

const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

/** The parts of a tool URL that can be checked without the network. */
export function checkToolUrl(raw: string, policy: NetPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolNetworkError('URL inválida');
  }
  if (url.username || url.password) throw new ToolNetworkError('A URL não pode ter usuário ou senha');
  const host = bareHost(url);
  const allowed = policy.privateHosts.has(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowed))
    throw new ToolNetworkError('Use uma URL https://');
  if (isIP(host) && !allowed && !isPublicIp(host)) throw new ToolNetworkError(BLOCKED);
  return url;
}

/** Saving a tool: its host must resolve, and to public addresses unless the operator allowed it. */
export async function assertToolUrl(raw: string, policy: NetPolicy): Promise<URL> {
  const url = checkToolUrl(raw, policy);
  const host = bareHost(url);
  if (isIP(host) || policy.privateHosts.has(host)) return url;
  const addresses = await (policy.resolve ?? systemResolver)(host).catch(() => []);
  if (addresses.length === 0 || !addresses.every(isPublicIp)) throw new ToolNetworkError(BLOCKED);
  return url;
}

/**
 * Resolves at connection time and refuses private addresses there, so a name that pointed
 * somewhere public when the tool was saved cannot be re-pointed at an internal service.
 */
function guardedLookup(policy: NetPolicy): LookupFunction {
  const lookup = (
    hostname: string,
    options: { all?: boolean },
    callback: (err: Error | null, address: unknown, family?: number) => void,
  ) => {
    (policy.resolve ?? systemResolver)(hostname).then(
      (addresses) => {
        const allowed = policy.privateHosts.has(hostname.toLowerCase());
        if (addresses.length === 0 || (!allowed && !addresses.every(isPublicIp))) {
          callback(new ToolNetworkError(BLOCKED), '', 0);
        } else if (options.all) {
          callback(
            null,
            addresses.map((address) => ({ address, family: isIP(address) })),
          );
        } else {
          callback(null, addresses[0], isIP(addresses[0]));
        }
      },
      () => callback(new ToolNetworkError('Não foi possível encontrar o servidor da ferramenta'), '', 0),
    );
  };
  return lookup as unknown as LookupFunction;
}

function flatten(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers))
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

/** One request with a hard deadline and size cap. Redirects are returned, never followed. */
export function outbound(req: OutboundRequest, policy: NetPolicy): Promise<OutboundResponse> {
  const url = checkToolUrl(req.url, policy);
  const client = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string | number> = { 'user-agent': 'IMPA-Meet-Agent/1.0', ...req.headers };
  if (req.body !== undefined) headers['content-length'] = Buffer.byteLength(req.body);

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(
        err instanceof ToolNetworkError
          ? err
          : new ToolNetworkError('Não foi possível conectar à ferramenta'),
      );
    };
    const request = client.request(
      url,
      { method: req.method, headers, lookup: guardedLookup(policy), agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve({
            status: res.statusCode ?? 0,
            headers: flatten(res.headers),
            body: Buffer.concat(chunks).toString('utf8'),
            truncated,
          });
          res.destroy();
        };
        res.on('data', (chunk: Buffer) => {
          const room = req.maxBytes - size;
          if (chunk.length > room) truncated = true;
          const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
          chunks.push(part);
          size += part.length;
          if (truncated || req.done?.(Buffer.concat(chunks).toString('utf8'))) finish();
        });
        res.on('end', finish);
        res.on('error', fail);
        res.on('close', () => fail(new ToolNetworkError('A conexão com a ferramenta caiu')));
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new ToolNetworkError('A ferramenta demorou demais para responder')),
      req.timeoutMs,
    );
    request.on('error', fail);
    if (req.body !== undefined) request.write(req.body);
    request.end();
  });
}
