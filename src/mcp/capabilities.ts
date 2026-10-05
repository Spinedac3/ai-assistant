import type { JsonSchema, ToolDefinition } from "../tools/contract.js";
import { FIND_CAPABILITY, RUN_CAPABILITY } from "./names.js";

export const DEFAULT_ACCESS_CONTACT = "el administrador del asistente";

// Two at most: enough not to hide what the person looks for, too few to become the answer
const MAX_RESTRICTED = 2;

const STOPWORDS = new Set([
  "de",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "y",
  "o",
  "a",
  "en",
  "con",
  "por",
  "para",
  "del",
  "al",
  "se",
  "su",
  "lo",
  "que",
  "es",
  "the",
  "of",
  "and",
  "to",
  "for",
]);

export const META_DEFINITIONS: Array<{
  name: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
}> = [
  {
    name: FIND_CAPABILITY,
    description:
      "Finds the capabilities that answer what the person needs and returns, for each one, its " +
      "name, description and typed parameter schema. Call this FIRST for any data question, then " +
      `call ${RUN_CAPABILITY} with the returned name and parameters built from that schema. A ` +
      "capability marked available: false exists but this person has no access: tell them it " +
      "exists and how to request access, and stop there.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "What the person needs, in plain words.",
        },
        top_k: {
          type: "integer",
          minimum: 1,
          maximum: 15,
          description: "How many to return. Default 6.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: RUN_CAPABILITY,
    description:
      `Runs a capability by its exact name, as returned by ${FIND_CAPABILITY}. The parameters must ` +
      "follow that capability's schema. An unknown name returns close matches to rediscover; a " +
      "capability without access returns how to request it, and the answer ends there.",
    inputSchema: {
      type: "object",
      properties: {
        capability: { type: "string", minLength: 1, description: "Exact capability name." },
        parameters: { type: "object", description: "Arguments for the capability; {} if none." },
      },
      required: ["capability", "parameters"],
      additionalProperties: false,
    },
    // It dispatches to tools that may write
    readOnly: false,
  },
];

export interface CapabilityHit {
  name: string;
  description: string;
  // Absent for restricted ones: a schema that cannot be called only tempts a doomed call
  parameters_schema?: JsonSchema;
  // Meaning similarity from 0 to 1 when ranked by meaning, word score otherwise; a restricted
  // one is always ranked by words
  relevance: number;
  available?: false;
  how_to_get_access?: string;
}

/**
 * Splits text into searchable words: lower case, no accents, no stopwords
 *
 * @param   text  Text to split
 *
 * @return  The words
 */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word));
}

/**
 * Ranks tools against a query by shared words, each weighted by how rare it is in the catalog
 *
 * A plain word count ties every tool that says "analyze"; the rare word is the one that discriminates.
 *
 * @param   tools  Candidates
 * @param   query  What the person needs
 *
 * @return  The candidates with their score, best first
 */
export function rankByWords(
  tools: ToolDefinition[],
  query: string,
): Array<{ tool: ToolDefinition; score: number }> {
  const terms = new Set(words(query));
  const bags = tools.map((tool) => ({
    tool,
    bag: new Set(words(`${tool.name} ${tool.description}`)),
  }));
  const frequency = new Map<string, number>();

  for (const { bag } of bags) {
    for (const word of bag) {
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }

  const total = Math.max(1, bags.length);

  return bags
    .map(({ tool, bag }) => {
      let score = 0;
      for (const term of terms) {
        if (bag.has(term)) {
          score += Math.log(total / (frequency.get(term) ?? total));
        }
      }

      return { tool, score: Math.round(score * 1000) / 1000 };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * The first sentence of a description, so a capability without access declares what it is
 * without publishing its manual
 *
 * @param   description  Full description
 *
 * @return  The public part
 */
export function publicDescription(description: string): string {
  return (
    description.match(/^.*?\.(?=\s|$)/s)?.[0] ??
    `${description.slice(0, 160)}${description.length > 160 ? "…" : ""}`
  );
}

/**
 * Tells how to request access, naming who to ask
 *
 * @param   contact  Person or team that grants access
 *
 * @return  The instruction for the model
 */
export function howToGetAccess(contact: string): string {
  return (
    `Esta capacidad existe pero tu usuario no tiene acceso. Pídelo a ${contact} explicando para qué ` +
    "la necesitas. No digas que no se puede: falta el permiso. Y responde SOLO eso, sin datos de " +
    "memoria ni alternativas."
  );
}

/**
 * Finds capabilities for a query, declaring at most two that exist but the caller cannot use
 *
 * Hiding what the person cannot use makes the only possible answer "that does not exist", which
 * is false; the scope names themselves are never revealed.
 *
 * @param   all         Every registered tool
 * @param   allowed     Tools the caller may run
 * @param   query       What the person needs
 * @param   topK        How many to return
 * @param   contact     Who grants access
 * @param   similarity  Meaning similarity of the usable tools by name, when available
 *
 * @return  The hits, usable first
 */
export function findCapabilities(
  all: ToolDefinition[],
  allowed: ToolDefinition[],
  query: string,
  topK: number,
  contact: string,
  similarity: ReadonlyMap<string, number> | null = null,
): CapabilityHit[] {
  const usable = new Set(allowed.map((tool) => tool.name));
  const ranked = rankByWords(all, query);
  const byMeaning = similarity
    ? allowed
        .map((tool) => ({ tool, score: similarity.get(tool.name) ?? 0 }))
        .sort((a, b) => b.score - a.score)
    : null;

  const available = (byMeaning ?? ranked.filter(({ tool }) => usable.has(tool.name)))
    .slice(0, topK)
    .map(({ tool, score }) => ({
      name: tool.name,
      description: tool.description,
      parameters_schema: tool.inputSchema,
      relevance: score,
    }));

  // Only those that earned a top place on their own words, so a declaration never displaces a
  // usable one; meaning alone is too loose to announce a capability the person cannot use
  const restricted = ranked
    .slice(0, topK)
    // Without a shared word it is not what the person asked for, so declaring it would mislead
    .filter(({ tool, score }) => !usable.has(tool.name) && score > 0)
    .slice(0, MAX_RESTRICTED)
    .map(({ tool, score }) => ({
      name: tool.name,
      description: publicDescription(tool.description),
      relevance: score,
      available: false as const,
      how_to_get_access: howToGetAccess(contact),
    }));

  return [...available, ...restricted];
}
