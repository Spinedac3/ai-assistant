import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "../db/client.js";
import { MCP_SERVER } from "../mcp/names.js";
import { mintRunToken, revokeRunToken } from "../mcp/runTokens.js";

// Longer than two attempts of a turn; the token dies on its own if the release never runs
const TOKEN_MINUTES = 15;

/**
 * Builds the per-turn MCP configuration: a token bound to the person and the conversation, never
 * to any agent, so the chat keeps the meta catalog
 *
 * @param   db          Own database
 * @param   serverUrl   Address of this server's /mcp, as the CLI on the same host reaches it
 *
 * @return  The function the chat turn calls
 */
export function chatMcpConfig(db: Database, serverUrl: string) {
  return async (workspace: string, userId: number, conversationId: number) => {
    const token = await mintRunToken(db, userId, TOKEN_MINUTES, { tools: null, conversationId });
    const path = join(workspace, ".mcp.json");

    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER]: {
            type: "http",
            url: serverUrl,
            headers: { Authorization: `Bearer ${token}` },
            // Loaded before the first request; a lazily connected server left turns without tools
            alwaysLoad: true,
          },
        },
      }),
    );

    return async () => {
      rmSync(path, { force: true });
      await revokeRunToken(db, token);
    };
  };
}
