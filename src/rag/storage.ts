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
    return (await this.readAll(key(docCode, "md"))).toString("utf8");
  }

  /**
   * Keeps the PDF of a conversion until it is published or discarded
   *
   * @param   id   Conversion id
   * @param   pdf  File
   */
  async saveConversion(id: string, pdf: Buffer): Promise<void> {
    await this.client.putObject(this.config.bucket, conversionKey(id), pdf, pdf.length, {
      "Content-Type": CONTENT_TYPES.pdf,
    });
  }

  /**
   * Reads the PDF of a conversion
   *
   * @param   id  Conversion id
   *
   * @return  The file
   */
  async readConversion(id: string): Promise<Buffer> {
    return this.readAll(conversionKey(id));
  }

  /**
   * Drops the PDF of a conversion; one already gone is no error
   *
   * @param   id  Conversion id
   */
  async removeConversion(id: string): Promise<void> {
    await this.removeKeys([conversionKey(id)]);
  }

  /**
   * Reads a whole object
   *
   * @param   objectKey  Its key
   *
   * @return  Its contents
   */
  private async readAll(objectKey: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.config.bucket, objectKey);
    const parts: Buffer[] = [];
    for await (const part of stream) {
      parts.push(part as Buffer);
    }

    return Buffer.concat(parts);
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
   * @param   upload  Who sends which document, in how many parts
   * @param   part    Part number
   * @param   text    Markdown of the part
   */
  async savePart(upload: PartUpload, part: number, text: string): Promise<void> {
    const data = Buffer.from(text, "utf8");
    await this.client.putObject(this.config.bucket, partKey(upload, part), data, data.length);
  }

  /**
   * Lists the parts received of an upload, dropping those of an earlier attempt left unfinished
   *
   * @param   upload    Who sends which document, in how many parts
   * @param   lifetime  Milliseconds a part counts, before the newest one; measured on the storage
   *                    clock alone, so a server running ahead or behind cannot drop a fresh part
   *
   * @return  Each part number with its size in bytes
   */
  async partsReceived(
    upload: PartUpload,
    lifetime: number,
  ): Promise<{ part: number; bytes: number }[]> {
    const found = await this.list(partKey(upload));
    const newest = Math.max(0, ...found.map((item) => item.lastModified.getTime()));
    const stale = found.filter((item) => item.lastModified.getTime() < newest - lifetime);
    await this.removeKeys(stale.map((item) => item.name));

    return found
      .filter((item) => !stale.includes(item))
      .map((item) => ({
        part: Number(item.name.split("/").pop()?.replace(".md", "")),
        bytes: item.size,
      }))
      .sort((a, b) => a.part - b.part);
  }

  /**
   * Reads one part of an upload
   *
   * @param   upload  Who sends which document, in how many parts
   * @param   part    Part number
   *
   * @return  Its markdown
   */
  async readPart(upload: PartUpload, part: number): Promise<string> {
    const stream = await this.client.getObject(this.config.bucket, partKey(upload, part));
    const pieces: Buffer[] = [];
    for await (const piece of stream) {
      pieces.push(piece as Buffer);
    }

    return Buffer.concat(pieces).toString("utf8");
  }

  /**
   * Drops every part a person sent of a document, whatever the number of parts it was split in
   *
   * @param   owner    Who sends it
   * @param   docCode  Document code
   */
  async removeParts(owner: number, docCode: string): Promise<void> {
    const found = await this.list(partKey({ owner, docCode }));
    await this.removeKeys(found.map((item) => item.name));
  }

  /**
   * Drops the parts of uploads left unfinished
   *
   * @param   olderThan  Parts saved before this moment go
   */
  async purgeParts(olderThan: Date): Promise<void> {
    const found = await this.list(`${PARTS}/`);
    await this.removeKeys(
      found.filter((item) => item.lastModified < olderThan).map((item) => item.name),
    );
  }

  /**
   * Removes objects by key; an empty list makes no request
   *
   * @param   keys  Object keys
   */
  private async removeKeys(keys: string[]): Promise<void> {
    if (keys.length > 0) {
      await this.client.removeObjects(this.config.bucket, keys);
    }
  }

  /**
   * Lists the objects under a prefix
   *
   * @param   prefix  Key prefix
   *
   * @return  Their names, sizes and when they were saved
   */
  private async list(
    prefix: string,
  ): Promise<{ name: string; size: number; lastModified: Date }[]> {
    const found: { name: string; size: number; lastModified: Date }[] = [];
    for await (const item of this.client.listObjectsV2(this.config.bucket, prefix, true)) {
      if (item.name) {
        found.push({ name: item.name, size: item.size, lastModified: item.lastModified });
      }
    }

    return found;
  }
}

export interface PartUpload {
  owner: number;
  docCode: string;
  parts: number;
}

/**
 * Builds the key of a part, or the folder of an upload or of a person's document
 *
 * @param   upload  Who sends which document, and in how many parts when known
 * @param   part    Part number, for the key of one part
 *
 * @return  The key or folder
 */
export function partKey(
  upload: Omit<PartUpload, "parts"> & { parts?: number },
  part?: number,
): string {
  // The folder holds a slash, which no document code can, so a part never overwrites or joins a real
  // document; the number of parts is part of it, so an attempt split differently never mixes in.
  const { owner, docCode, parts } = upload;
  if (!DOC_CODE.test(docCode) || !Number.isInteger(owner)) {
    throw new Error(`Código de documento inválido: ${docCode}`);
  }

  const folder = `${PARTS}/${owner}/${docCode}/`;
  if (parts === undefined) {
    return folder;
  }

  return `${folder}${parts}/${part === undefined ? "" : `${part}.md`}`;
}

/**
 * Names the object of a PDF being converted
 *
 * @param   id  Conversion id
 *
 * @return  The object key
 */
export function conversionKey(id: string): string {
  return `conversions/${id}.pdf`;
}

/**
 * Names the object of an original
 *
 * @param   docCode  Document code
 * @param   kind     Markdown or PDF
 *
 * @return  The object key
 */
export function key(docCode: string, kind: OriginalKind): string {
  if (!DOC_CODE.test(docCode)) {
    throw new Error(`Código de documento inválido: ${docCode}`);
  }

  return `${docCode}.${kind}`;
}
