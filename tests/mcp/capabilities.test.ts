import { describe, expect, it } from "vitest";
import type { Database } from "../../src/db/client.js";
import { removeHidden } from "../../src/lib/hiddenText.js";
import { findCapabilities, publicDescription, rankByWords } from "../../src/mcp/capabilities.js";
import { surfaceFor } from "../../src/mcp/surface.js";
import type { ToolDefinition } from "../../src/tools/contract.js";
import { ToolRegistry } from "../../src/tools/registry.js";

/**
 * Builds a tool definition for ranking tests
 *
 * @param   name         Tool name
 * @param   description  Tool description
 * @param   scopes       Required scopes
 *
 * @return  The definition
 */
function tool(name: string, description: string, scopes: string[] = ["chat.use"]): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
    requiredScopes: scopes,
    readOnly: true,
  };
}

const catalog = [
  tool("sales_by_day", "Analyze sales per day. Shows totals."),
  tool("stock_levels", "Analyze stock per warehouse. Shows units."),
  tool("staff_turnover", "Analyze staff turnover and retention. Shows rates.", ["hr.read"]),
  tool("route_delays", "Analyze delivery route delays. Shows minutes."),
];

describe("capabilities", () => {
  it("lets the rare word decide when every tool says analyze", () => {
    // Performs the test.
    const [best] = rankByWords(catalog, "analyze staff turnover");

    // Performs assertions.
    expect(best?.tool.name).toBe("staff_turnover");
  });

  it("declares a capability without access, with no schema and no scope names", () => {
    // Performs the test.
    const allowed = catalog.filter((definition) => definition.requiredScopes.includes("chat.use"));
    const hits = findCapabilities(catalog, allowed, "staff turnover", 3, "rrhh@example.com");
    const restricted = hits.find((hit) => hit.name === "staff_turnover");

    // Performs assertions.
    expect(restricted).toEqual({
      name: "staff_turnover",
      description: "Analyze staff turnover and retention.",
      relevance: expect.any(Number),
      available: false,
      how_to_get_access: expect.stringContaining("rrhh@example.com"),
    });
    expect(JSON.stringify(hits)).not.toContain("hr.read");
  });

  it("keeps only the first sentence of a description that cannot be used", () => {
    // Performs assertions.
    expect(publicDescription("Reads payroll. Use the period parameter.")).toBe("Reads payroll.");
  });
});

describe("surface", () => {
  const registry = new ToolRegistry({} as Database);
  for (const definition of catalog) {
    registry.register({ definition, execute: async () => ({ ok: true, data: {} }) });
  }
  const scopes = new Set(["chat.use"]);

  it("offers the chat and external clients the two meta tools", () => {
    // Performs assertions.
    expect(surfaceFor(registry, scopes, "chat").catalog).toEqual([
      "find_capability",
      "run_capability",
    ]);
    expect(surfaceFor(registry, scopes, "external").catalog).toEqual([
      "find_capability",
      "run_capability",
    ]);
  });

  it("gives an agent run only its own tools that its scopes allow", () => {
    // Performs the test.
    const surface = surfaceFor(registry, scopes, "run", ["sales_by_day", "staff_turnover"]);

    // Performs assertions.
    expect(surface.catalog).toEqual(["sales_by_day"]);
  });

  it("gives a run with no tools nothing, never the full catalog", () => {
    // Performs assertions.
    expect(surfaceFor(registry, scopes, "run", []).catalog).toEqual([]);
  });
});

describe("hiddenText", () => {
  it("removes tag, bidi and zero-width characters", () => {
    // Performs assertions.
    expect(removeHidden("ok\u{E0041}‮hola​")).toBe("okhola");
  });
});
