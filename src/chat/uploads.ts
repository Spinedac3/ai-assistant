import { randomUUID } from "node:crypto";

export interface Upload {
  name: string;
  bytes: Buffer;
}

interface Stored extends Upload {
  userId: number;
  expiresAt: number;
}

// A file is read within the conversation that brought it; past this it is gone
const TTL_MS = 30 * 60_000;
// Uploads live in memory, so all of them together stay under this
const TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * Files a person attaches to the chat, kept in memory for a while and only for that person
 */
export class Uploads {
  private readonly files = new Map<string, Stored>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Keeps a file for its owner
   *
   * @param   userId  Owner
   * @param   upload  Name and contents
   *
   * @return  Its id, or null when there is no room left
   */
  put(userId: number, upload: Upload): string | null {
    this.sweep();
    const used = [...this.files.values()].reduce((sum, file) => sum + file.bytes.length, 0);
    if (used + upload.bytes.length > TOTAL_BYTES) {
      return null;
    }
    const id = randomUUID();
    this.files.set(id, { ...upload, userId, expiresAt: this.now() + TTL_MS });

    return id;
  }

  /**
   * Gives a file back only to its owner, and only while it lives
   *
   * @param   userId  Who asks
   * @param   id      Id of the file
   *
   * @return  The file, or null
   */
  get(userId: number, id: string): Upload | null {
    this.sweep();
    const file = this.files.get(id);

    return file && file.userId === userId ? { name: file.name, bytes: file.bytes } : null;
  }

  /**
   * Drops the files whose time is over
   */
  private sweep(): void {
    const now = this.now();
    for (const [id, file] of this.files) {
      if (file.expiresAt <= now) {
        this.files.delete(id);
      }
    }
  }
}
