import type { Index } from "../../rag/ingest.js";
import { fetchPassage, searchDocuments } from "../../rag/search.js";
import type { Tool } from "../contract.js";

export const SEARCH = "search";
export const FETCH = "fetch";

// What each status means for the model, so an empty list is never read as "it does not exist"
const STATUS_NOTES: Record<string, string> = {
  no_results: "No hay documentos que coincidan. Di que no lo encontraste en la documentación.",
  no_access:
    "La persona no tiene acceso a ningún área de documentos. Dilo y no respondas de memoria.",
  unavailable:
    "La búsqueda de documentos no está disponible ahora. Dilo; no respondas de memoria como si " +
    "lo hubieras verificado.",
  not_found: "Ese id no existe o la persona no puede leerlo. Vuelve a buscar con search.",
};

/**
 * Builds the search tool: passages of the documents the person can read
 *
 * @param   index  Solr, embedder and cores
 *
 * @return  The tool
 */
export function searchTool(index: Index): Tool {
  return {
    definition: {
      name: SEARCH,
      description:
        "Searches the organization's documents (procedures, policies, manuals) and returns the " +
        "best matching passages, each with an id, a title and a short snippet. Use it for any " +
        `question the documents may answer, then call ${FETCH} with the id of the passage that ` +
        "answers it to read its whole section before answering. A document code on its own " +
        "returns that document.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 2,
            maxLength: 500,
            description: "The question or the words to look for, as the person said them.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
                snippet: { type: "string" },
              },
              required: ["id", "title", "url"],
            },
          },
        },
        required: ["results"],
      },
      requiredScopes: ["chat.use"],
      readOnly: true,
    },
    execute: async (args, context) => {
      const { status, results } = await searchDocuments(index, context.scopes, String(args.query));

      return {
        ok: true,
        data: { status, results, ...(STATUS_NOTES[status] ? { note: STATUS_NOTES[status] } : {}) },
        rows: results.length,
      };
    },
  };
}

/**
 * Builds the fetch tool: one passage with the whole section it belongs to
 *
 * @param   index  Solr, embedder and cores
 *
 * @return  The tool
 */
export function fetchTool(index: Index): Tool {
  return {
    definition: {
      name: FETCH,
      description:
        `Reads a passage returned by ${SEARCH}, by its id, together with the whole section it ` +
        "belongs to, so a step is never read without its conditions. Quote the document code " +
        "when answering from it.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            pattern: "^\\S+$",
            description: `Passage id as returned by ${SEARCH}.`,
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          text: { type: "string" },
          url: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["id", "title", "text", "url"],
      },
      requiredScopes: ["chat.use"],
      readOnly: true,
    },
    execute: async (args, context) => {
      const { status, document } = await fetchPassage(index, context.scopes, String(args.id));
      if (!document) {
        return { ok: false, error: status, message: STATUS_NOTES[status] ?? "Sin documento" };
      }

      return { ok: true, data: { ...document }, rows: 1 };
    },
  };
}
