import type { ToolDefinition } from "../tools/contract.js";
import { FETCH, SEARCH } from "../tools/native/documents.js";
import type { ToolRegistry } from "../tools/registry.js";
import { cliToolName, FIND_CAPABILITY, RUN_CAPABILITY } from "./names.js";

// Who is calling decides what is offered: the web chat's CLI, an external MCP client or an agent run
export type Channel = "chat" | "external" | "run";

export interface Surface {
  // Tools the caller may run, already filtered by its scopes
  allowed: ToolDefinition[];
  // Names offered in tools/list, in order
  catalog: string[];
}

export const META_TOOLS = [FIND_CAPABILITY, RUN_CAPABILITY] as const;

// Offered directly, outside the capability search: ChatGPT connects a knowledge source only through
// tools with exactly these names
export const DOCUMENT_TOOLS: readonly string[] = [SEARCH, FETCH];

// The chat CLI may call only what its catalog offers; both lists come from the same names
export const CHAT_CLI_ALLOWED = [
  "ToolSearch",
  ...[...META_TOOLS, ...DOCUMENT_TOOLS].map(cliToolName),
].join(" ");

/**
 * The single answer to what a caller sees and may run
 *
 * The chat and external clients get the two meta tools, a fixed catalog that scales past client
 * tool limits, plus the document search when they may use it. An agent run gets only its own tools, direct, and an empty list means no tools at
 * all, never the full catalog.
 *
 * @param   registry  Registered tools
 * @param   scopes    Effective scopes of the caller
 * @param   channel   Where the call comes from
 * @param   runTools  Tools of an agent run, when the channel is a run
 *
 * @return  What the caller may run and what it is offered
 */
export function surfaceFor(
  registry: ToolRegistry,
  scopes: ReadonlySet<string>,
  channel: Channel,
  runTools: readonly string[] = [],
): Surface {
  const visible = registry.visibleTo(scopes);

  if (channel === "run") {
    const allowed = visible.filter((definition) => runTools.includes(definition.name));

    return { allowed, catalog: allowed.map((definition) => definition.name) };
  }

  const documents = DOCUMENT_TOOLS.filter((name) => visible.some((tool) => tool.name === name));

  return { allowed: visible, catalog: [...META_TOOLS, ...documents] };
}
