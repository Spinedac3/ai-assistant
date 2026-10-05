import { describe, expect, it } from "vitest";
import { removeHidden, removeHiddenDeep } from "../../src/lib/hiddenText.js";

describe("hidden text", () => {
  it("removes every way of hiding text from people, at any depth, and keeps what people see", () => {
    // Performs the test.
    const hidden = [
      "\u{E0041}",
      "\u{E0101}",
      "\uFE0F",
      "\u200E",
      "\u061C",
      "\u2061",
      "\u206A",
      "\u00AD",
      "\u034F",
      "\u3164",
      "\uFFF9",
    ];
    const deep = removeHiddenDeep({ [`a${hidden[0]}`]: [`ruta${hidden.join("")}`, 3, null] });

    // Performs assertions.
    expect(removeHidden(`R-Norte${hidden.join("")}-1 ñ é 😀`)).toBe("R-Norte-1 ñ é 😀");
    expect(deep).toEqual({ a: ["ruta", 3, null] });
  });
});
