// A backstop only: attempts end on their own timeout and a stuck CLI is killed, so a turn ahead
// never takes this long unless something below them is broken
export const MAX_WAIT_MS = 900_000;

const queues = new Map<string, Promise<void>>();

/**
 * Waits until no earlier turn of the same conversation is running, then holds the turn
 *
 * @param   key          Conversation key
 * @param   abortSignal  Gives up the place in the queue when the client leaves
 * @param   maxWaitMs    Longest wait for the turn ahead
 *
 * @return  The function that releases the turn, or null when the client left while waiting
 */
export async function holdTurn(
  key: string,
  abortSignal?: AbortSignal,
  maxWaitMs: number = MAX_WAIT_MS,
): Promise<(() => void) | null> {
  // Two turns resuming the same CLI session at once would interleave its transcript, so the second
  // waits and then runs seeing the first one's answer. The queue lives in this process; more than one
  // server instance would need a lock in the database.
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxWaitMs);
  });
  const left = new Promise<"left">((resolve) => {
    if (abortSignal?.aborted) {
      resolve("left");
    }
    abortSignal?.addEventListener("abort", () => resolve("left"), { once: true });
  });

  const outcome = await Promise.race([ahead, waited, left]);
  clearTimeout(timer);

  if (outcome === "left") {
    // Whoever queued behind must still wait for the turn ahead, not for this one that never ran
    void ahead.then(done);

    return null;
  }

  return done;
}
