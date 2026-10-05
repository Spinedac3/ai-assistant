import type { Embedder } from "../rag/embeddings.js";
import type { ToolDefinition } from "../tools/contract.js";

// The opening of a description carries its purpose; the rest are usage caveats that dilute the
// match, and long texts in one batch make the service slow
const MAX_TOOL_CHARS = 512;
// A capability search waits this long for the catalog vectors before going on with words
const EMBED_TIMEOUT_MS = 20_000;

/**
 * Cosine similarity of two vectors
 *
 * @param   a  First vector
 * @param   b  Second vector
 *
 * @return  The similarity, 0 when either is empty
 */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
}

export class CapabilityRanker {
  // Keyed by the embedded text itself, so an edited description is embedded again
  private readonly vectors = new Map<string, number[]>();

  /**
   * Builds a ranker on the embedding service
   *
   * @param   embedder  Embedding client
   */
  constructor(private readonly embedder: Embedder) {}

  /**
   * Ranks tools by meaning against a query; words alone miss synonyms and paraphrases
   *
   * @param   tools  Candidates
   * @param   query  What the person needs
   *
   * @return  The similarity of each tool by name, or null when the service is unavailable
   */
  async rank(tools: readonly ToolDefinition[], query: string): Promise<Map<string, number> | null> {
    if (tools.length === 0) {
      return new Map();
    }

    const texts = tools.map((tool) => `${tool.name}. ${tool.description}`.slice(0, MAX_TOOL_CHARS));
    const missing = texts.filter((text) => !this.vectors.has(text));

    try {
      if (missing.length > 0) {
        const vectors = await this.embedder.passages(missing, EMBED_TIMEOUT_MS);
        for (const [position, text] of missing.entries()) {
          this.vectors.set(text, vectors[position] ?? []);
        }
      }
    } catch {
      return null;
    }

    const asked = await this.embedder.query(query);
    if (!asked) {
      return null;
    }

    return new Map(
      tools.map((tool, position) => [
        tool.name,
        Math.round(cosine(asked, this.vectors.get(texts[position] ?? "") ?? []) * 1000) / 1000,
      ]),
    );
  }
}
