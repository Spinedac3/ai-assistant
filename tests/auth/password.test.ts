import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "../../src/auth/password.js";

const owner = ["mariana@example.com", "Mariana Delcampo"];
const stranger = ["ana@example.com", "Ana López"];

describe("password", () => {
  it("rejects a password shorter than twelve characters", () => {
    // Performs assertions.
    expect(passwordProblem("corta-123", owner)).toBe(
      "La contraseña debe tener al menos 12 caracteres",
    );
  });

  it("rejects a commonly used password", () => {
    // Performs assertions.
    expect(passwordProblem("password1234", owner)).toBe(
      "Es similar a una contraseña usada habitualmente.",
    );
  });

  it("rejects repeated characters", () => {
    // Performs assertions.
    expect(passwordProblem("aaaaaaaaaaaaaaa", owner)).toBe(
      'Caracteres repetidos como "aaa" son fáciles de adivinar',
    );
  });

  it("rejects a word plus a year", () => {
    // Performs assertions.
    expect(passwordProblem("Barcelona2026!", stranger)).not.toBeNull();
  });

  it("rejects a password built from the owner's own name", () => {
    // Performs assertions.
    expect(passwordProblem("delcampomariana71", owner)).not.toBeNull();
    expect(passwordProblem("delcampomariana71", stranger)).toBeNull();
  });

  it("accepts a passphrase of uncommon words", () => {
    // Performs assertions.
    expect(passwordProblem("nube-cactus-farol-29", owner)).toBeNull();
  });

  it("verifies the password it hashed with argon2id", async () => {
    // Performs the test.
    const stored = await hashPassword("nube-cactus-farol-29");

    // Performs assertions.
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(stored, "nube-cactus-farol-29")).toBe(true);
    expect(await verifyPassword(stored, "nube-cactus-farol-30")).toBe(false);
  });

  it("never matches an account without a hash", async () => {
    // Performs assertions.
    expect(await verifyPassword(null, "not-a-real-account-password")).toBe(false);
  });
});
