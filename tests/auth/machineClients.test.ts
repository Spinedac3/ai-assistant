import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashSecret, loadMachineClients, machineClientOf } from "../../src/auth/machineClients.js";

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
