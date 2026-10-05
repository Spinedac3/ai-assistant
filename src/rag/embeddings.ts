// The service takes at most 64 texts per request; 32 keeps each request short
const BATCH = 32;
const PASSAGES_TIMEOUT_MS = 120_000;
// A search waits this long at most before going on with words only
const QUERY_TIMEOUT_MS = 8_000;

/**
 * Rounds to 6 decimals: Solr 9 rejects some vectors with more precision, and float32 holds about 7
 *
 * @param   vector  Raw vector
 *
 * @return  The rounded vector
 */
export function roundVector(vector: readonly number[]): number[] {
  return vector.map((value) => Math.round(value * 1e6) / 1e6);
}

export class Embedder {
  /**
   * Builds a client for the embedding service
   *
   * @param   baseUrl  Service address
   */
  constructor(private readonly baseUrl: string) {}

  /**
   * Embeds passages in batches; any failure throws, since an index without vectors is incomplete
   *
   * @param   texts      Passages
   * @param   timeoutMs  Limit per batch
   *
   * @return  One rounded vector per passage, in order
   */
  async passages(texts: readonly string[], timeoutMs = PASSAGES_TIMEOUT_MS): Promise<number[][]> {
    const vectors: number[][] = [];

    for (let start = 0; start < texts.length; start += BATCH) {
      const batch = texts.slice(start, start + BATCH);
      const response = await fetch(`${this.baseUrl}/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ texts: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`El servicio de embeddings respondió ${response.status}`);
      }

      const body = (await response.json()) as { vectors?: number[][] };
      if (!Array.isArray(body.vectors) || body.vectors.length !== batch.length) {
        throw new Error("El servicio de embeddings devolvió otra cantidad de vectores");
      }

      vectors.push(...body.vectors.map(roundVector));
    }

    return vectors;
  }

  /**
   * Embeds a search query; a failure returns null so the search goes on with words only
   *
   * @param   text  Query
   *
   * @return  The rounded vector, or null
   */
  async query(text: string): Promise<number[] | null> {
    try {
      const response = await fetch(`${this.baseUrl}/embed/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      });

      if (!response.ok) {
        return null;
      }

      const body = (await response.json()) as { vector?: number[] };

      return Array.isArray(body.vector) ? roundVector(body.vector) : null;
    } catch {
      return null;
    }
  }
}
