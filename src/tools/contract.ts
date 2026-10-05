export type JsonSchema = Record<string, unknown> & { type: "object" };

// Which path ran a call: the web chat, an external MCP client, or an agent run
export type ToolOrigin = "chat" | "mcp" | "run";

export interface ToolDefinition {
  name: string;
  // What the model reads to decide when to call it
  description: string;
  inputSchema: JsonSchema;
  // The shape of a successful result; an agent run reads fields of it, so it is part of the contract
  outputSchema?: JsonSchema;
  // Every one of these is required
  requiredScopes: readonly string[];
  // At least one of these is required, when present
  requiredAnyScopes?: readonly string[];
  // Read-only tools run without a confirmation prompt in MCP clients
  readOnly: boolean;
}

export interface ToolContext {
  userId: number;
  userEmail: string;
  scopes: ReadonlySet<string>;
  conversationId?: number;
  origin: ToolOrigin;
  timeZone: string;
}

export type ToolResult =
  | { ok: true; data: Record<string, unknown>; rows?: number; truncated?: boolean }
  | { ok: false; error: string; message: string };

export interface Tool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}
