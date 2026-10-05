import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Secrets } from "../../src/vault/envelope.js";

const vault = Secrets.fromKey(randomBytes(32));

describe("envelope", () => {
  it("opens what it sealed, with a fresh data key each time", () => {
    // Performs the test.
    const first = vault.seal("contraseña-de-la-fuente", "source:erp");
    const second = vault.seal("contraseña-de-la-fuente", "source:erp");

    // Performs assertions.
    expect(vault.open(first, "source:erp")).toBe("contraseña-de-la-fuente");
    expect(first).not.toBe(second);
    expect(first).not.toContain("contraseña");
    expect(JSON.parse(first).dek).not.toBe(JSON.parse(second).dek);
  });

  it("refuses a sealed secret moved to another record or tampered with", () => {
    // Performs the test.
    const sealed = vault.seal("secreto", "source:erp");
    const parsed = JSON.parse(sealed);
    const flipped = Buffer.from(parsed.data, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const tampered = JSON.stringify({ ...parsed, data: flipped.toString("base64") });

    // Performs assertions.
    expect(() => vault.open(sealed, "source:crm")).toThrow();
    expect(() => vault.open(tampered, "source:erp")).toThrow();
    expect(() => Secrets.fromKey(randomBytes(32)).open(sealed, "source:erp")).toThrow();
  });

  it("derives the same key for a purpose and a different one for another", () => {
    // Performs assertions.
    expect(vault.derive("export-links").equals(vault.derive("export-links"))).toBe(true);
    expect(vault.derive("export-links").equals(vault.derive("otra-cosa"))).toBe(false);
    expect(vault.derive("export-links")).toHaveLength(32);
  });

  it("reads the master key from its file and refuses one of the wrong size", () => {
    // Performs the test.
    const folder = mkdtempSync(join(tmpdir(), "kek-"));
    const good = join(folder, "good.key");
    const short = join(folder, "short.key");
    const key = randomBytes(32);
    writeFileSync(good, `${key.toString("base64")}\n`);
    writeFileSync(short, randomBytes(16).toString("base64"));
    const sealed = Secrets.fromKey(key).seal("x", "c");

    // Performs assertions.
    expect(Secrets.fromFile(good).open(sealed, "c")).toBe("x");
    expect(() => Secrets.fromFile(short)).toThrow("32 bytes");
  });
});
