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
 * Tells whether a storage error means the object does not exist
 *
 * @param   error  Error thrown by the client
 *
 * @return  Whether it is a missing object
 */
function isMissing(error: unknown): boolean {
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
    const url = new URL(config.endpoint);
    this.client = new Client({
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      useSSL: url.protocol === "https:",
      accessKey: config.accessKey,
      secretKey: config.secretKey,
    });
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
