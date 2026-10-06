import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import { eq, inArray, lte, sql } from "drizzle-orm";
import type { Client } from "minio";
import type { Database } from "../db/client.js";
import { exportFiles } from "../db/schema.js";
import { isMissing, type StorageConfig, s3Client } from "../rag/storage.js";
import { type Sheet, workbook, XLSX_CONTENT_TYPE } from "./xlsx.js";

const RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;

export interface SavedExport {
  url: string;
  expiresInDays: number;
}

export interface ExportFile {
  fileName: string;
  stream: Readable;
}

/**
 * Builds the object key of an export
 *
 * @param   id  Export id
 *
 * @return  The key
 */
function objectKey(id: string): string {
  return `exports/${id}.xlsx`;
}

export class ExportStore {
  private readonly client: Client;

  /**
   * Builds the store of Excel files that carry what a tool result could not
   *
   * @param   db             Own database
   * @param   storage        S3 endpoint, credentials and bucket
   * @param   signingKey     Key of the download links
   * @param   publicBaseUrl  Public address of this server
   * @param   client         S3 client, built from the settings unless given
   */
  constructor(
    private readonly db: Database,
    private readonly storage: StorageConfig,
    private readonly signingKey: Buffer,
    private readonly publicBaseUrl: string,
    client?: Client,
  ) {
    this.client = client ?? s3Client(storage);
  }

  /**
   * Signs an export id and its expiry
   *
   * @param   id       Export id
   * @param   expires  Expiry, in seconds since the epoch
   *
   * @return  The signature
   */
  private sign(id: string, expires: number): string {
    return createHmac("sha256", this.signingKey).update(`${id}.${expires}`).digest("base64url");
  }

  /**
   * Writes an Excel file and returns a link that works without login until it expires
   *
   * @param   sheets    Sheets, main one first
   * @param   owner     Who ran the tool, and which
   * @param   signed    Whether the link must open without a session, as outside the panel
   *
   * @return  The link and how many days it lasts
   */
  async save(
    sheets: Sheet[],
    owner: { userId: number; toolName: string },
    signed = true,
  ): Promise<SavedExport> {
    const id = randomUUID();
    const data = workbook(sheets);
    const expiresAt = new Date(Date.now() + RETENTION_DAYS * DAY_MS);
    // Only safe characters reach the download header, whatever a tool is named
    const safeName = owner.toolName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
    const fileName = `${safeName}-${new Date().toISOString().slice(0, 10)}.xlsx`;

    // The row goes first, so a file is never stored without the record that purges it
    await this.db.insert(exportFiles).values({
      id,
      userId: owner.userId,
      toolName: owner.toolName,
      fileName,
      rows: sheets[0]?.rows.length ?? 0,
      bytes: data.length,
      expiresAt,
    });
    await this.client.putObject(this.storage.bucket, objectKey(id), data, data.length, {
      "Content-Type": XLSX_CONTENT_TYPE,
    });

    // Inside the panel the person's session opens it, so the link carries no permission of its own
    if (!signed) {
      return { url: `/exports/${id}`, expiresInDays: RETENTION_DAYS };
    }
    const expires = Math.floor(expiresAt.getTime() / 1000);
    const query = new URLSearchParams({ exp: String(expires), sig: this.sign(id, expires) });

    return {
      url: `${this.publicBaseUrl}/exports/${id}?${query}`,
      expiresInDays: RETENTION_DAYS,
    };
  }

  /**
   * Opens an export if its link is genuine and has not expired
   *
   * @param   id         Export id
   * @param   expires    Expiry from the link
   * @param   signature  Signature from the link
   *
   * @return  The file, or null for a forged, expired or deleted link
   */
  async open(id: string, expires: number, signature: string): Promise<ExportFile | null> {
    const expected = Buffer.from(this.sign(id, expires));
    const given = Buffer.from(signature);
    if (
      given.length !== expected.length ||
      !timingSafeEqual(given, expected) ||
      expires * 1000 <= Date.now()
    ) {
      return null;
    }

    return this.read(id);
  }

  /**
   * Opens an export for the person who ran the tool that made it
   *
   * @param   id      Export id
   * @param   userId  Who asks for it
   *
   * @return  The file, or null when it is someone else's, expired or deleted
   */
  async openOwned(id: string, userId: number): Promise<ExportFile | null> {
    return this.read(id, userId);
  }

  /**
   * Reads an export that has not expired, of one person when one is given
   *
   * @param   id      Export id
   * @param   userId  Its owner, when only theirs may be read
   *
   * @return  The file, or null
   */
  private async read(id: string, userId?: number): Promise<ExportFile | null> {
    const [row] = await this.db.select().from(exportFiles).where(eq(exportFiles.id, id)).limit(1);
    if (!row || row.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    if (userId !== undefined && row.userId !== userId) {
      return null;
    }

    try {
      return {
        fileName: row.fileName,
        stream: await this.client.getObject(this.storage.bucket, objectKey(id)),
      };
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }

      throw error;
    }
  }

  /**
   * Deletes the exports whose time ran out, files first so no file outlives its row
   *
   * @return  How many were deleted
   */
  async purge(): Promise<number> {
    const expired = await this.db
      .select({ id: exportFiles.id })
      .from(exportFiles)
      .where(lte(exportFiles.expiresAt, sql`now()`));
    if (expired.length === 0) {
      return 0;
    }

    // The client reports objects it could not remove instead of throwing; their rows stay for
    // the next sweep
    const failures = await this.client.removeObjects(
      this.storage.bucket,
      expired.map((row) => objectKey(row.id)),
    );
    // Its types say { Error: { Key } }, but it returns the error itself, as { Key, Code }
    const failed = new Set(
      failures.map((item) => (item as { Key?: string } | null)?.Key ?? item?.Error?.Key),
    );
    const removed = expired.filter((row) => !failed.has(objectKey(row.id)));
    if (removed.length > 0) {
      await this.db.delete(exportFiles).where(
        inArray(
          exportFiles.id,
          removed.map((row) => row.id),
        ),
      );
    }

    return removed.length;
  }
}
