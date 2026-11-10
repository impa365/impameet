import 'server-only';
import { config } from '../config';
import { db } from '../db';
import { openAiComplete } from '../insights/llm';
import { parseMasterKey } from '../security/secrets';
import type { NetPolicy } from '../tools/net';
import { openAiEmbedder, webGet } from './ingest';
import { type VectorStore, qdrantStore } from './qdrant';
import { httpReranker } from './rerank';
import { type KnowledgeDeps, knowledgeTick, processSource } from './service';

let store: VectorStore | null | undefined;
let key: Buffer | null | undefined;
let privateHosts: ReadonlySet<string> | undefined;
let deps: KnowledgeDeps | undefined;

const CONCURRENCY = 2;
const TICK_MS = 60_000;

/** Sources are indexed a couple at a time, in this process, in the order they were queued. */
function queue(run: (id: string) => Promise<void>) {
  const waiting: string[] = [];
  const known = new Set<string>();
  let running = 0;
  const pump = () => {
    while (running < CONCURRENCY && waiting.length > 0) {
      const id = waiting.shift()!;
      running += 1;
      void run(id)
        .catch(() => undefined)
        .finally(() => {
          running -= 1;
          known.delete(id);
          pump();
        });
    }
  };
  return (id: string) => {
    if (known.has(id)) return;
    known.add(id);
    waiting.push(id);
    pump();
  };
}

export function knowledgeDeps(): KnowledgeDeps {
  if (deps) return deps;
  const cfg = config();
  if (store === undefined)
    store = cfg.qdrantUrl && cfg.qdrantApiKey ? qdrantStore(cfg.qdrantUrl, cfg.qdrantApiKey) : null;
  key ??= cfg.encryptionKey ? parseMasterKey(cfg.encryptionKey) : null;
  privateHosts ??= new Set(cfg.toolsPrivateHosts);
  const net: NetPolicy = { privateHosts };
  const built: KnowledgeDeps = {
    sql: db(),
    key,
    net,
    store,
    embedder: (c) => openAiEmbedder(c),
    reranker: (c) => httpReranker(c),
    complete: openAiComplete(),
    get: webGet(net),
  };
  built.schedule = queue((id) => processSource(built, id));
  deps = built;
  if (store) {
    // The clock: interrupted work, due re-syncs, old searches.
    const tick = () => void knowledgeTick(built).catch(() => undefined);
    setTimeout(tick, 5_000).unref?.();
    setInterval(tick, TICK_MS).unref?.();
  }
  return built;
}
