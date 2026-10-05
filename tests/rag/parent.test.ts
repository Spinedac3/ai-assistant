import { describe, expect, it } from "vitest";
import { parentBlock } from "../../src/rag/parent.js";

/**
 * Builds siblings of a given size
 *
 * @param   sizes  Length of each chunk text
 *
 * @return  The siblings, numbered from 0
 */
function siblings(...sizes: number[]) {
  return sizes.map((size, index) => ({ text: String(index).repeat(size), chunk_index: index }));
}

describe("parent block", () => {
  it("joins the whole section in order when it fits", () => {
    // Performs the test.
    const block = parentBlock([...siblings(10, 10, 10)].reverse(), 1);

    // Performs assertions.
    expect(block).toEqual({
      text: `${"0".repeat(10)}\n\n${"1".repeat(10)}\n\n${"2".repeat(10)}`,
      cut: false,
      pieces: 3,
    });
  });

  it("keeps the requested chunk even when it falls past the limit", () => {
    // Performs the test.
    const block = parentBlock(siblings(40, 40, 40, 40), 3, 90);

    // Performs assertions.
    expect(block.text).toContain("3".repeat(40));
    expect(block.text).toContain("2".repeat(40));
    expect(block.text).not.toContain("0".repeat(40));
    expect(block.cut).toBe(true);
    expect(block.text.endsWith("[...la sección continúa en el documento completo]")).toBe(true);
  });

  it("grows forward before backward", () => {
    // Performs the test.
    const block = parentBlock(siblings(40, 40, 40), 1, 85);

    // Performs assertions.
    expect(block.text).toBe(
      `${"1".repeat(40)}\n\n${"2".repeat(40)}\n\n[...la sección continúa en el documento completo]`,
    );
  });

  it("cuts a requested chunk larger than the limit and says so", () => {
    // Performs the test.
    const block = parentBlock(siblings(200), 0, 50);

    // Performs assertions.
    expect(block.pieces).toBe(1);
    expect(block.text.startsWith("0".repeat(50))).toBe(true);
    expect(block.cut).toBe(true);
  });

  it("falls back to the first chunk when the requested one is not among the siblings", () => {
    // Performs the test.
    const block = parentBlock(siblings(10, 10), 7);

    // Performs assertions.
    expect(block.text.startsWith("0")).toBe(true);
    expect(parentBlock([], 0)).toEqual({ text: "", cut: false, pieces: 0 });
  });
});
