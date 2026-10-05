import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "../../src/auth/password.js";

describe("password", () => {
  it("rejects a password shorter than twelve characters", () => {
    // Performs assertions.
    expect(passwordProblem("corta-123", "ana@example.com")).toBe(
      "La contraseña debe tener al menos 12 caracteres",
    );
  });

  it("rejects a common password regardless of case", () => {
    // Performs assertions.
    expect(passwordProblem("PassWord1234", "ana@example.com")).toBe(
      "La contraseña es demasiado común",
    );
  });

  it("rejects a password that contains the email user", () => {
    // Performs assertions.
    expect(passwordProblem("mariana-del-campo", "mariana@example.com")).toBe(
      "La contraseña no puede contener el usuario del correo",
    );
  });

  it("accepts a long uncommon password", () => {
    // Performs assertions.
    expect(passwordProblem("tres caballos verdes", "ana@example.com")).toBeNull();
  });

  it("verifies the password it hashed with argon2id", async () => {
    // Performs the test.
    const stored = await hashPassword("tres caballos verdes");

    // Performs assertions.
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(stored, "tres caballos verdes")).toBe(true);
    expect(await verifyPassword(stored, "tres caballos azules")).toBe(false);
  });

  it("never matches an account without a hash", async () => {
    // Performs assertions.
    expect(await verifyPassword(null, "not-a-real-account-password")).toBe(false);
  });
});
