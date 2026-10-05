import { describe, expect, it } from "vitest";
import { PERSON_BYTES, Uploads } from "../../src/chat/uploads.js";

const MB = 1024 * 1024;

describe("chat uploads", () => {
  it("gives a file only to its owner, and only while it is in use", () => {
    // Performs the test.
    let now = 0;
    const uploads = new Uploads(() => now);
    const id = uploads.put(1, { name: "factura.pdf", bytes: Buffer.from("%PDF-1") }) ?? "";
    const owner = uploads.get(1, id);
    const other = uploads.get(2, id);
    // Read again after 20 minutes, it lasts another half hour from then
    now = 20 * 60_000;
    uploads.get(1, id);
    now = 49 * 60_000;
    const stillThere = uploads.get(1, id);
    now = 80 * 60_000;
    const gone = uploads.get(1, id);

    // Performs assertions.
    expect(owner).toEqual({ name: "factura.pdf", bytes: Buffer.from("%PDF-1") });
    expect(other).toBeNull();
    expect(stillThere).not.toBeNull();
    expect(gone).toBeNull();
  });

  it("keeps each person within a share, so no one fills the store for everybody", () => {
    // Performs the test.
    const uploads = new Uploads();
    const ten = Buffer.alloc(10 * MB);
    const own = [1, 2, 3].map(() => uploads.put(1, { name: "a.pdf", bytes: ten }));
    const fourth = uploads.put(1, { name: "d.pdf", bytes: ten });
    const before = uploads.accepts(1, 1);
    const someoneElse = uploads.accepts(2, 10 * MB);
    const others = [2, 3, 4, 5, 6, 7, 8].map((user) =>
      uploads.put(user, { name: "x.pdf", bytes: ten }),
    );

    // Performs assertions.
    expect(PERSON_BYTES).toBe(30 * MB);
    expect(own.every((id) => id !== null)).toBe(true);
    expect(fourth).toBeNull();
    expect(before).toBe(false);
    expect(someoneElse).toBe(true);
    // A hundred megabytes in all: seven more people fit, then nobody
    expect(others.filter((id) => id !== null)).toHaveLength(7);
    expect(uploads.accepts(9, 1)).toBe(false);
  });
});
