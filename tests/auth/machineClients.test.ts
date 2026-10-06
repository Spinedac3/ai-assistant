import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  declareMachineClient,
  hashSecret,
  loadMachineClients,
  machineClientOf,
} from "../../src/auth/machineClients.js";

/**
 * Writes a list of machine clients to a temporary file
 *
 * @param   list  The entries
 *
 * @return  Its path
 */
function listFile(list: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "machines-")), "machine-clients.json");
  writeFileSync(path, JSON.stringify(list));

  return path;
}

describe("machine clients", () => {
  it("knows a client only by its own secret, sent as HTTP Basic", () => {
    // Performs the test.
    const clients = loadMachineClients(
      listFile([{ client_id: "agent-factory", secret_sha256: hashSecret("s3cret:with:colons") }]),
    );
    const header = (value: string) => `Basic ${Buffer.from(value).toString("base64")}`;

    // Performs assertions.
    expect(machineClientOf(header("agent-factory:s3cret:with:colons"), clients)?.clientId).toBe(
      "agent-factory",
    );
    expect(machineClientOf(header("agent-factory:other"), clients)).toBeNull();
    expect(machineClientOf(header("someone:s3cret:with:colons"), clients)).toBeNull();
    expect(machineClientOf(header(":s3cret:with:colons"), clients)).toBeNull();
    expect(machineClientOf("Bearer agent-factory", clients)).toBeNull();
    expect(machineClientOf(undefined, clients)).toBeNull();
  });

  it("never replaces a client's secret by accident, and replaces it when asked to rotate", () => {
    // Performs the test.
    const listPath = join(mkdtempSync(join(tmpdir(), "machines-")), "machine-clients.json");
    const secretPath = declareMachineClient(listPath, "agent-factory", false);
    const first = readFileSync(secretPath, "utf8");
    const again = () => declareMachineClient(listPath, "agent-factory", false);
    declareMachineClient(listPath, "agent-factory", true);
    const second = readFileSync(secretPath, "utf8");
    const clients = loadMachineClients(listPath);
    const header = (secret: string) =>
      `Basic ${Buffer.from(`agent-factory:${secret}`).toString("base64")}`;

    // Performs assertions.
    expect(again).toThrow("agent-factory ya está declarado");
    expect(second).not.toBe(first);
    expect(clients.size).toBe(1);
    expect(machineClientOf(header(second), clients)?.clientId).toBe("agent-factory");
    expect(machineClientOf(header(first), clients)).toBeNull();
  });

  it("refuses a file that names one client twice", () => {
    // Performs the test.
    const twice = () =>
      loadMachineClients(
        listFile([
          { client_id: "agent-factory", secret_sha256: hashSecret("a") },
          { client_id: "agent-factory", secret_sha256: hashSecret("b") },
        ]),
      );

    // Performs assertions.
    expect(twice).toThrow("Un cliente aparece dos veces");
  });

  it("declares no client without a file, and refuses the name the assistant uses itself", () => {
    // Performs the test.
    const none = loadMachineClients(undefined);
    const own = () =>
      loadMachineClients(listFile([{ client_id: "internal-run", secret_sha256: hashSecret("x") }]));
    const plain = () =>
      loadMachineClients(listFile([{ client_id: "agent-factory", secret_sha256: "secret" }]));

    // Performs assertions.
    expect(none.size).toBe(0);
    expect(own).toThrow("Ese nombre lo usa el propio asistente");
    expect(plain).toThrow();
  });
});
