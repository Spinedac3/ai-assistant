// Name of the assistant's own MCP server inside every CLI workspace
export const MCP_SERVER = "assistant";

// Meta tools of the chat surface: discover a capability with its schema, then run it
export const FIND_CAPABILITY = "find_capability";
export const RUN_CAPABILITY = "run_capability";

/**
 * Qualifies a tool name the way the CLI sees it
 *
 * @param   tool  Tool name on the server
 *
 * @return  The name with the server prefix
 */
export function cliToolName(tool: string): string {
  return `mcp__${MCP_SERVER}__${tool}`;
}
