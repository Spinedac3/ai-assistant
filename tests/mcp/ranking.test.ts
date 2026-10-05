import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findCapabilities } from "../../src/mcp/capabilities.js";
import { CapabilityRanker } from "../../src/mcp/ranking.js";
import { Embedder } from "../../src/rag/embeddings.js";
import type { ToolDefinition } from "../../src/tools/contract.js";
import { type FakeEmbed, startFakeEmbed } from "../support/fakeEmbed.js";

/**
 * Builds a tool definition
 *
 * @param   name         Tool name
 * @param   description  What it does
 * @param   scopes       Required scopes
 *
 * @return  The definition
 */
function tool(name: string, description: string, scopes = ["chat.use"]): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: "object" },
    requiredScopes: scopes,
    readOnly: true,
  };
}

const SALES = tool("sales_by_route", "Ventas por ruta de entrega y vendedor.");
const STOCK = tool("stock_levels", "Existencias de inventario por bodega y producto.");
const PAYROLL = tool("payroll", "Planilla y salarios del personal.", ["payroll.read"]);

let embed: FakeEmbed;

describe("capability ranking", () => {
  beforeAll(async () => {
    embed = await startFakeEmbed();
  });

  afterAll(async () => {
    await embed.close();
  });

  it("orders the usable tools by meaning and embeds each description once", async () => {
    // Performs the test.
    const ranker = new CapabilityRanker(new Embedder(embed.url));
    const first = await ranker.rank([SALES, STOCK], "existencias en bodega");
    await ranker.rank([SALES, STOCK], "ventas");
    const passages = embed.calls.filter((call) => call === "/embed").length;

    // Performs assertions.
    expect((first?.get("stock_levels") ?? 0) > (first?.get("sales_by_route") ?? 0)).toBe(true);
    expect(passages).toBe(1);
  });

  it("returns nothing when the service is down, so the words decide", async () => {
    // Performs the test.
    const ranker = new CapabilityRanker(new Embedder("http://127.0.0.1:9"));

    // Performs assertions.
    expect(await ranker.rank([SALES], "ventas")).toBeNull();
  });

  it("puts the meaning order first but declares restricted tools only by their words", () => {
    // Performs the test.
    const similarity = new Map([
      ["sales_by_route", 0.2],
      ["stock_levels", 0.9],
    ]);
    const hits = findCapabilities(
      [SALES, STOCK, PAYROLL],
      [SALES, STOCK],
      "planilla",
      5,
      "rrhh",
      similarity,
    );
    const unrelated = findCapabilities(
      [SALES, STOCK, PAYROLL],
      [SALES, STOCK],
      "bodega",
      5,
      "rrhh",
      similarity,
    );

    // Performs assertions.
    expect(hits.map((hit) => hit.name)).toEqual(["stock_levels", "sales_by_route", "payroll"]);
    expect(hits[0]?.relevance).toBe(0.9);
    expect(unrelated.map((hit) => hit.name)).not.toContain("payroll");
  });
});
