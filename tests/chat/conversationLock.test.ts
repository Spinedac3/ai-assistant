import { describe, expect, it } from "vitest";
import { holdTurn } from "../../src/chat/conversationLock.js";

describe("conversationLock", () => {
  it("makes the second turn of a conversation wait for the first", async () => {
    // Performs the test.
    const order: string[] = [];
    const releaseFirst = await holdTurn("c1");
    const second = holdTurn("c1").then((release) => {
      order.push("second starts");
      release?.();
    });
    order.push("first ends");
    releaseFirst?.();
    await second;

    // Performs assertions.
    expect(order).toEqual(["first ends", "second starts"]);
  });

  it("lets other conversations run at the same time", async () => {
    // Performs the test.
    const releaseA = await holdTurn("a");
    const releaseB = await holdTurn("b");

    // Performs assertions.
    expect(releaseA).toEqual(expect.any(Function));
    expect(releaseB).toEqual(expect.any(Function));
    releaseA?.();
    releaseB?.();
  });

  it("gives up the place of a client that left, without letting the next one jump the queue", async () => {
    // Performs the test.
    const order: string[] = [];
    const releaseFirst = await holdTurn("c2");
    const leaving = new AbortController();
    const second = holdTurn("c2", leaving.signal);
    const third = holdTurn("c2").then((release) => {
      order.push("third starts");
      release?.();
    });
    leaving.abort();
    const secondResult = await second;
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push("first ends");
    releaseFirst?.();
    await third;

    // Performs assertions.
    expect(secondResult).toBeNull();
    expect(order).toEqual(["first ends", "third starts"]);
  });
});

describe("conversationLock backstop", () => {
  it("stops waiting for a turn ahead that never ends", async () => {
    // Performs the test.
    await holdTurn("stuck");
    const started = Date.now();
    const release = await holdTurn("stuck", undefined, 50);

    // Performs assertions.
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(release).toEqual(expect.any(Function));
    release?.();
  });
});
