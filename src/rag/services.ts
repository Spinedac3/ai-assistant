import type { RagEnv } from "../config/env.js";
import { Embedder } from "./embeddings.js";
import type { Index } from "./ingest.js";
import { Solr } from "./solr.js";
import { DocumentStorage, type StorageConfig } from "./storage.js";

/**
 * Builds the document index from the settings: the cores created by docker-compose
 *
 * @param   env  Document search settings
 *
 * @return  The index
 */
export function indexFrom(env: RagEnv): Index {
  return {
    solr: new Solr(env.SOLR_URL),
    embedder: new Embedder(env.EMBED_URL),
    cores: { current: "docs", historical: "docs_historical" },
  };
}

/**
 * Reads the S3 storage settings, shared by the originals and the exported files
 *
 * @param   env  Document search settings
 *
 * @return  Endpoint, credentials and bucket
 */
export function s3Config(env: RagEnv): StorageConfig {
  return {
    endpoint: env.S3_ENDPOINT,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
  };
}

/**
 * Builds the store of originals from the settings
 *
 * @param   env  Document search settings
 *
 * @return  The storage
 */
export function storageFrom(env: RagEnv): DocumentStorage {
  return new DocumentStorage(s3Config(env));
}
