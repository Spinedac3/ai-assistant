import type { Readable } from "node:stream";
import { Client } from "minio";
import { DOC_CODE } from "./document.js";

export type OriginalKind = "md" | "pdf";

export const CONTENT_TYPES: Record<OriginalKind, string> = {
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
};

// Each original carries the scope of its area, so a download checks the file it serves and not an
// index that may still describe a previous upload
const SCOPE_META = "required-scope";

// Parts of documents sent in pieces wait here until the last one arrives
const PARTS = "_parts";

export interface Original {
  stream: Readable;
  requiredScope: string;
}

export interface StorageConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

/**
 * Builds a client for any S3 compatible service
 *
 * @param   config  Endpoint and credentials
 *
 * @return  The client
 */
export function s3Client(config: StorageConfig): Client {
  const url = new URL(config.endpoint);

  return new Client({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    useSSL: url.protocol === "https:",
    accessKey: config.accessKey,
    secretKey: config.secretKey,
  });
}

/**
 * Tells whether a storage error means the object does not exist
 *
 * @param   error  Error thrown by the client
 *
 * @return  Whether it is a missing object
 */
export function isMissing(error: unknown): boolean {
  const code = (error as { code?: string }).code;

  return code === "NotFound" || code === "NoSuchKey";
}

export class DocumentStorage {
  private readonly client: Client;

  /**
   * Builds the store of uploaded originals on any S3 compatible service
   *
   * @param   config  Endpoint, credentials and bucket
   */
  constructor(private readonly config: StorageConfig) {
    this.client = s3Client(config);
  }

  /**
   * Creates the bucket when it does not exist yet
   */
  async ensureBucket(): Promise<void> {
    if (!(await this.client.bucketExists(this.config.bucket))) {
      await this.client.makeBucket(this.config.bucket);
    }
  }

  /**
   * Saves an original, replacing a previous one with the same code
   *
   * @param   docCode        Document code
   * @param   kind           Markdown or PDF
   * @param   data           File contents
   * @param   requiredScope  Scope of the document area
   */
  async save(
    docCode: string,
    kind: OriginalKind,
    data: Buffer,
    requiredScope: string,
  ): Promise<void> {
    await this.client.putObject(this.config.bucket, key(docCode, kind), data, data.length, {
      "Content-Type": CONTENT_TYPES[kind],
      [`X-Amz-Meta-${SCOPE_META}`]: requiredScope,
    });
  }

  /**
   * Reads the stored markdown of a document
   *
   * @param   docCode  Document code
   *
   * @return  Its text
   */
  async readMarkdown(docCode: string): Promise<string> {
    const stream = await this.client.getObject(this.config.bucket, key(docCode, "md"));
    const parts: Buffer[] = [];
    for await (const part of stream) {
      parts.push(part as Buffer);
    }

    return Buffer.concat(parts).toString("utf8");
  }

  /**
   * Opens an original for download
   *
   * @param   docCode  Document code
   * @param   kind     Markdown or PDF
   *
   * @return  The stream and the scope it was saved with, or null when there is no such original
   */
  async open(docCode: string, kind: OriginalKind): Promise<Original | null> {
    try {
      const stat = await this.client.statObject(this.config.bucket, key(docCode, kind));
      const stream = await this.client.getObject(this.config.bucket, key(docCode, kind));

      return { stream, requiredScope: String(stat.metaData?.[SCOPE_META] ?? "") };
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }

      throw error;
    }
  }

  /**
   * Tells whether an original exists
   *
   * @param   docCode  Document code
   * @param   kind     Markdown or PDF
   *
   * @return  Whether it is stored
   */
  async exists(docCode: string, kind: OriginalKind): Promise<boolean> {
    try {
      await this.client.statObject(this.config.bucket, key(docCode, kind));

      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }

      throw error;
    }
  }

  /**
   * Removes originals of a document; a missing one is not an error
   *
   * @param   docCode  Document code
   * @param   kinds    Which originals, both by default
   */
  async remove(docCode: string, kinds: OriginalKind[] = ["md", "pdf"]): Promise<void> {
    await this.client.removeObjects(
      this.config.bucket,
      kinds.map((kind) => key(docCode, kind)),
    );
  }

  /**
   * Keeps one part of a document sent in pieces, replacing a part with the same number
   *
   * @param   owner    Who sends it
   * @param   docCode  Document code
   * @param   part     Part number
   * @param   text     Markdown of the part
   */
  async savePart(owner: number, docCode: string, part: number, text: string): Promise<void> {
    const data = Buffer.from(text, "utf8");
    await this.client.putObject(
      this.config.bucket,
      partKey(owner, docCode, part),
      data,
      data.length,
    );
  }

  /**
   * Lists the part numbers received of a document since a moment, dropping older ones: those are
   * of an upload left unfinished, and must not join a new one
   *
   * @param   owner    Who sends it
   * @param   docCode  Document code
   * @param   since    Parts saved before this moment no longer count
   *
   * @return  The numbers
   */
  async partsReceived(owner: number, docCode: string, since = new Date(0)): Promise<number[]> {
    const names = await this.list(partKey(owner, docCode));
    const stale = names.filter((item) => item.lastModified < since);
    if (stale.length > 0) {
      await this.client.removeObjects(
        this.config.bucket,
        stale.map(({ name }) => name),
      );
    }

    return names
      .filter((item) => item.lastModified >= since)
      .map(({ name }) => Number(name.split("/").pop()?.replace(".md", "")))
      .sort((a, b) => a - b);
  }

  /**
   * Reads one part of a document
   *
   * @param   owner    Who sends it
   * @param   docCode  Document code
   * @param   part     Part number
   *
   * @return  Its markdown
   */
  async readPart(owner: number, docCode: string, part: number): Promise<string> {
    const stream = await this.client.getObject(this.config.bucket, partKey(owner, docCode, part));
    const pieces: Buffer[] = [];
    for await (const piece of stream) {
      pieces.push(piece as Buffer);
    }

    return Buffer.concat(pieces).toString("utf8");
  }

  /**
   * Drops every part of a document, once it is gathered or refused
   *
   * @param   owner    Who sends it
   * @param   docCode  Document code
   */
  async removeParts(owner: number, docCode: string): Promise<void> {
    const names = await this.list(partKey(owner, docCode));
    await this.client.removeObjects(
      this.config.bucket,
      names.map(({ name }) => name),
    );
  }

  /**
   * Drops the parts of uploads left unfinished
   *
   * @param   olderThan  Parts saved before this moment go
   */
  async purgeParts(olderThan: Date): Promise<void> {
    const stale = (await this.list(`${PARTS}/`)).filter((item) => item.lastModified < olderThan);
    if (stale.length > 0) {
      await this.client.removeObjects(
        this.config.bucket,
        stale.map(({ name }) => name),
      );
    }
  }

  /**
   * Lists the objects under a prefix
   *
   * @param   prefix  Key prefix
   *
   * @return  Their names and when they were saved
   */
  private async list(prefix: string): Promise<{ name: string; lastModified: Date }[]> {
    const found: { name: string; lastModified: Date }[] = [];
    for await (const item of this.client.listObjectsV2(this.config.bucket, prefix, true)) {
      if (item.name) {
        found.push({ name: item.name, lastModified: item.lastModified });
      }
    }

    return found;
  }
}

/**
 * Builds the key of a part of a document still being sent; the folder holds a slash, which no
 * document code can, so a part never overwrites or joins a real document
 *
 * @param   owner    Who sends it
 * @param   docCode  Document code
 * @param   part     Part number
 *
 * @return  The key
 */
export function partKey(owner: number, docCode: string, part?: number): string {
  if (!DOC_CODE.test(docCode) || !Number.isInteger(owner)) {
    throw new Error(`Código de documento inválido: ${docCode}`);
  }

  return `${PARTS}/${owner}/${docCode}/${part === undefined ? "" : `${part}.md`}`;
}

/**
 * Builds the object key, refusing a code that could escape its name
 *
 * @param   docCode  Document code
 * @param   kind     Markdown or PDF
 *
 * @return  The key
 */
export function key(docCode: string, kind: OriginalKind): string {
  if (!DOC_CODE.test(docCode)) {
    throw new Error(`Código de documento inválido: ${docCode}`);
  }

  return `${docCode}.${kind}`;
}
