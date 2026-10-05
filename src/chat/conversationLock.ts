const queues = new Map<string, Promise<void>>();

/**
 * Waits until no earlier turn of the same conversation is running, then holds the turn
 *
 * Two turns resuming the same CLI session at once would interleave its transcript, so the second
 * waits and then runs seeing the first one's answer. Turns end on their own time limit, so the wait
 * needs none. The queue lives in this process; more than one server instance would need a lock in
 * the database.
 *
 * @param   key          Conversation key
 * @param   abortSignal  Gives up the place in the queue when the client leaves
 *
 * @return  The function that releases the turn, or null when the client left while waiting
 */
export async function holdTurn(
  key: string,
  abortSignal?: AbortSignal,
): Promise<(() => void) | null> {
  const ahead = queues.get(key) ?? Promise.resolve();
  let release = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(key, mine);

  const done = () => {
    release();
    if (queues.get(key) === mine) {
      queues.delete(key);
    }
  };

  const left = new Promise<"left">((resolve) => {
    if (abortSignal?.aborted) {
      resolve("left");
    }
    abortSignal?.addEventListener("abort", () => resolve("left"), { once: true });
  });

  if ((await Promise.race([ahead, left])) === "left") {
    // Whoever queued behind must still wait for the turn ahead, not for this one that never ran
    void ahead.then(done);

    return null;
  }

  return done;
}
