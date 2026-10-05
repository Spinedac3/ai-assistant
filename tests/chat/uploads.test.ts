import { describe, expect, it } from "vitest";
import { Uploads } from "../../src/chat/uploads.js";

describe("chat uploads", () => {
  it("gives a file only to its owner, only for half an hour, and only while there is room", () => {
    // Performs the test.
    let now = 0;
    const uploads = new Uploads(() => now);
    const id = uploads.put(1, { name: "factura.pdf", bytes: Buffer.from("%PDF-1") }) ?? "";
    const owner = uploads.get(1, id);
    const other = uploads.get(2, id);
    now = 30 * 60_000 - 1;
    const stillThere = uploads.get(1, id);
    now = 30 * 60_000;
    const gone = uploads.get(1, id);
    const big = Buffer.alloc(60 * 1024 * 1024);
    const first = uploads.put(1, { name: "a.pdf", bytes: big });
    const second = uploads.put(1, { name: "b.pdf", bytes: big });

    // Performs assertions.
    expect(owner).toEqual({ name: "factura.pdf", bytes: Buffer.from("%PDF-1") });
    expect(other).toBeNull();
    expect(stillThere).not.toBeNull();
    expect(gone).toBeNull();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
