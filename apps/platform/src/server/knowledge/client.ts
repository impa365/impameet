import 'server-only';
import { config } from '../config';
import { db } from '../db';
import { parseMasterKey } from '../security/secrets';
import { openAiEmbedder } from './ingest';
import { type VectorStore, qdrantStore } from './qdrant';
import type { KnowledgeDeps } from './service';

let store: VectorStore | null | undefined;
let key: Buffer | null | undefined;
let privateHosts: ReadonlySet<string> | undefined;

export function knowledgeDeps(): KnowledgeDeps {
  const cfg = config();
  if (store === undefined)
    store = cfg.qdrantUrl && cfg.qdrantApiKey ? qdrantStore(cfg.qdrantUrl, cfg.qdrantApiKey) : null;
  key ??= cfg.encryptionKey ? parseMasterKey(cfg.encryptionKey) : null;
  privateHosts ??= new Set(cfg.toolsPrivateHosts);
  return { sql: db(), key, net: { privateHosts }, store, embedder: (c) => openAiEmbedder(c) };
}
