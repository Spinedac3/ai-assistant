import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

interface Sealed {
  v: 1;
  // The data key, encrypted with the master key
  dek: string;
  dekIv: string;
  dekTag: string;
  // The secret, encrypted with the data key
  iv: string;
  tag: string;
  data: string;
}

/**
 * Encrypts with AES-256-GCM
 *
 * @param   key        Key
 * @param   plaintext  Bytes to encrypt
 * @param   context    Bound to the ciphertext, so it cannot be moved to another record
 *
 * @return  The ciphertext with its nonce and tag
 */
function encrypt(key: Buffer, plaintext: Buffer, context: string) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return { iv, tag: cipher.getAuthTag(), data };
}

/**
 * Decrypts with AES-256-GCM, failing on any tampering or wrong context
 *
 * @param   key      Key
 * @param   parts    Ciphertext with its nonce and tag
 * @param   context  Context it was encrypted with
 *
 * @return  The plaintext
 */
function decrypt(
  key: Buffer,
  parts: { iv: Buffer; tag: Buffer; data: Buffer },
  context: string,
): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, parts.iv);
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(parts.tag);

  return Buffer.concat([decipher.update(parts.data), decipher.final()]);
}

export class Secrets {
  /**
   * Builds the vault on a master key that never leaves this object
   *
   * @param   kek  Master key, 32 bytes
   */
  private constructor(private readonly kek: Buffer) {}

  /**
   * Reads the master key from its file; the only place the key is read, so moving it to a
   * vault later changes nothing else
   *
   * @param   path  File with the key in base64
   *
   * @return  The vault
   */
  static fromFile(path: string): Secrets {
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.length !== KEY_BYTES) {
      throw new Error(`La llave maestra de ${path} debe tener ${KEY_BYTES} bytes en base64`);
    }

    return new Secrets(key);
  }

  /**
   * Builds a vault on a key held in memory, for tests
   *
   * @param   key  Master key, 32 bytes
   *
   * @return  The vault
   */
  static fromKey(key: Buffer): Secrets {
    if (key.length !== KEY_BYTES) {
      throw new Error(`La llave maestra debe tener ${KEY_BYTES} bytes`);
    }

    return new Secrets(Buffer.from(key));
  }

  /**
   * Encrypts a secret under a fresh data key, itself encrypted with the master key
   *
   * @param   plaintext  Secret
   * @param   context    What the secret belongs to, as "source:erp"
   *
   * @return  The sealed secret, safe to store
   */
  seal(plaintext: string, context: string): string {
    const dek = randomBytes(KEY_BYTES);
    const secret = encrypt(dek, Buffer.from(plaintext, "utf8"), context);
    const wrapped = encrypt(this.kek, dek, context);
    const sealed: Sealed = {
      v: 1,
      dek: wrapped.data.toString("base64"),
      dekIv: wrapped.iv.toString("base64"),
      dekTag: wrapped.tag.toString("base64"),
      iv: secret.iv.toString("base64"),
      tag: secret.tag.toString("base64"),
      data: secret.data.toString("base64"),
    };

    return JSON.stringify(sealed);
  }

  /**
   * Decrypts a sealed secret
   *
   * @param   stored   Sealed secret
   * @param   context  The context it was sealed with
   *
   * @return  The secret
   */
  open(stored: string, context: string): string {
    const sealed = JSON.parse(stored) as Sealed;
    const from = (value: string) => Buffer.from(value, "base64");
    const dek = decrypt(
      this.kek,
      { iv: from(sealed.dekIv), tag: from(sealed.dekTag), data: from(sealed.dek) },
      context,
    );

    return decrypt(
      dek,
      { iv: from(sealed.iv), tag: from(sealed.tag), data: from(sealed.data) },
      context,
    ).toString("utf8");
  }

  /**
   * Derives a key for another purpose from the master key, so one file covers every secret
   *
   * @param   purpose  What the key is for
   *
   * @return  A 32-byte key, the same every time for the same purpose
   */
  derive(purpose: string): Buffer {
    return Buffer.from(hkdfSync("sha256", this.kek, Buffer.alloc(0), purpose, KEY_BYTES));
  }
}
