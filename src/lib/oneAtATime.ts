// Work running for each key; the next call for a key waits for it
const running = new Map<string, Promise<unknown>>();

/**
 * Tells whether some work for a key is running or waiting
 *
 * @param   key  What the work is about
 *
 * @return  Whether there is any
 */
export function isRunning(key: string): boolean {
  return running.has(key);
}

/**
 * Runs some work after the work already running for the same key, so two calls for one thing
 * never overlap; calls for other keys run alongside
 *
 * @param   key   What the work is about
 * @param   work  What to run
 *
 * @return  What the work returns
 */
export async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = running.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  running.set(key, current);
  try {
    return await current;
  } finally {
    if (running.get(key) === current) {
      running.delete(key);
    }
  }
}
