// A hung turn must not silence the conversation: past this the next one runs anyway
export const MAX_WAIT_MS = 180_000;

const queues = new Map<string, Promise<void>>();

/**
 * Waits until no earlier turn of the same conversation is running, then holds the turn
 *
 * Two turns resuming the same CLI session at once would interleave its transcript, so the second
 * waits and then runs seeing the first one's answer. The queue lives in this process; more than one
 * server instance would need a lock in the database.
 *
 * @param   key        Conversation key
 * @param   maxWaitMs  Longest wait for the turn ahead
 *
 * @return  The function that releases the turn
 */
export async function holdTurn(key: string, maxWaitMs: number = MAX_WAIT_MS): Promise<() => void> {
  const ahead = queues.get(key) ?? Promise.resolve();
  let release = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(key, mine);

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    ahead,
    new Promise<void>((resolve) => (timer = setTimeout(resolve, maxWaitMs))),
  ]);
  clearTimeout(timer);

  return () => {
    release();
    if (queues.get(key) === mine) {
      queues.delete(key);
    }
  };
}

/**
 * Counts conversations with a turn running or waiting
 *
 * @return  The number of open turns
 */
export function openTurns(): number {
  return queues.size;
}
