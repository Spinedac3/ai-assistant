import { describe, expect, it } from "vitest";
import { holdTurn, openTurns } from "../../src/chat/conversationLock.js";

describe("conversationLock", () => {
  it("makes the second turn of a conversation wait for the first", async () => {
    // Performs the test.
    const order: string[] = [];
    const releaseFirst = await holdTurn("c1");
    const second = holdTurn("c1").then((release) => {
      order.push("second starts");
      release();
    });
    order.push("first ends");
    releaseFirst();
    await second;

    // Performs assertions.
    expect(order).toEqual(["first ends", "second starts"]);
    expect(openTurns()).toBe(0);
  });

  it("lets other conversations run at the same time", async () => {
    // Performs the test.
    const releaseA = await holdTurn("a");
    const releaseB = await holdTurn("b");

    // Performs assertions.
    expect(openTurns()).toBe(2);
    releaseA();
    releaseB();
  });

  it("stops waiting for a hung turn after the limit", async () => {
    // Performs the test.
    await holdTurn("hung");
    const started = Date.now();
    const release = await holdTurn("hung", 50);

    // Performs assertions.
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    release();
  });
});
