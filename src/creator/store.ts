import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/client.js";
import { sources, toolDefinitions } from "../db/schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { BaseColumn } from "./columns.js";
import { definitionSchema, type ToolDefinitionSpec } from "./definition.js";
import { type CreatedTool, type CreatedToolDependencies, toolFrom } from "./tool.js";

export type StoredTool = typeof toolDefinitions.$inferSelect;

/**
 * Gives a stored definition the shape the tool builder and the checks take
 *
 * @param   tool  Stored definition
 *
 * @return  The created tool
 */
export function shapeOf(tool: StoredTool): CreatedTool {
  return { name: tool.name, sourceCode: tool.sourceCode, spec: tool.spec, columns: tool.columns };
}

/**
 * Reads one definition with the zone of its source
 *
 * @param   db    Own database
 * @param   name  Tool name
 *
 * @return  The definition and the source's zone, or null when there is none
 */
export async function findDefinition(
  db: Database,
  name: string,
): Promise<{ tool: StoredTool; zone: string | null } | null> {
  const [row] = await db
    .select({ tool: toolDefinitions, zone: sources.timeZone })
    .from(toolDefinitions)
    .innerJoin(sources, eq(sources.code, toolDefinitions.sourceCode))
    .where(eq(toolDefinitions.name, name))
    .limit(1);

  return row ?? null;
}

/**
 * Saves a definition as a draft: a new tool, or a change to one that must be checked and
 * published again before anyone uses the new version
 *
 * @param   db     Own database
 * @param   input  Name, source, definition, described columns and author
 *
 * @return  The stored definition
 */
export async function saveDefinition(
  db: Database,
  input: {
    name: string;
    sourceCode: string;
    spec: ToolDefinitionSpec;
    columns: BaseColumn[];
    userId: number;
  },
): Promise<StoredTool> {
  const values = {
    sourceCode: input.sourceCode,
    spec: input.spec,
    columns: input.columns,
    status: "draft" as const,
    updatedAt: new Date(),
    publishedAt: null,
  };
  const [row] = await db
    .insert(toolDefinitions)
    .values({ ...values, name: input.name, createdBy: input.userId })
    .onConflictDoUpdate({ target: toolDefinitions.name, set: values })
    .returning();
  if (!row) {
    throw new Error("No se pudo guardar la herramienta");
  }

  return row;
}

/**
 * Publishes the version of a definition that was checked; a save in the meantime made another
 * version, which stays a draft until it is checked too
 *
 * @param   db    Own database
 * @param   tool  Definition as it was read before its checks
 *
 * @return  The published definition, or null when it changed since it was read
 */
export async function publishDefinition(
  db: Database,
  tool: StoredTool,
): Promise<StoredTool | null> {
  const [published] = await db
    .update(toolDefinitions)
    .set({ status: "published", publishedAt: new Date() })
    .where(and(eq(toolDefinitions.name, tool.name), eq(toolDefinitions.updatedAt, tool.updatedAt)))
    .returning();

  return published ?? null;
}

/**
 * Keeps the registry in step with the creator: published tools in it, drafts and deleted ones out
 */
export class CreatedTools {
  // Names the creator put in the registry, so it never touches a native tool
  private readonly own = new Set<string>();

  /**
   * Builds the bridge between stored definitions and the registry
   *
   * @param   registry  Tool registry every path runs through
   * @param   deps      Database, vault and the zone of the application
   */
  private logger?: FastifyBaseLogger;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly deps: CreatedToolDependencies,
  ) {}

  /**
   * Sets where a tool that cannot load is reported, once the server's logger exists
   *
   * @param   logger  Server logger
   */
  useLogger(logger: FastifyBaseLogger): void {
    this.logger = logger;
  }

  /**
   * Tells whether a name is taken by a tool the creator does not own
   *
   * @param   name  Tool name
   *
   * @return  Whether it belongs to a native tool
   */
  isNative(name: string): boolean {
    return this.registry.has(name) && !this.own.has(name);
  }

  /**
   * Puts a stored definition in the registry when published, and takes it out otherwise
   *
   * @param   tool  Stored definition
   * @param   zone  Zone of its source
   */
  sync(tool: StoredTool, zone: string | null): void {
    if (this.isNative(tool.name)) {
      this.logger?.error({ tool: tool.name }, "created tool shares a native tool's name");
      return;
    }
    if (tool.status !== "published") {
      this.drop(tool.name);
      return;
    }

    this.registry.replace(toolFrom(shapeOf(tool), this.deps, zone));
    this.own.add(tool.name);
  }

  /**
   * Takes a created tool out of the registry
   *
   * @param   name  Tool name
   */
  drop(name: string): void {
    if (this.own.delete(name)) {
      this.registry.remove(name);
    }
  }

  /**
   * Loads every published tool at start, from what is stored, so no source has to answer first
   *
   * @return  How many were loaded
   */
  async load(): Promise<number> {
    const rows = await this.deps.db
      .select({ tool: toolDefinitions, zone: sources.timeZone })
      .from(toolDefinitions)
      .innerJoin(sources, eq(sources.code, toolDefinitions.sourceCode))
      .where(eq(toolDefinitions.status, "published"));
    let loaded = 0;
    for (const { tool, zone } of rows) {
      // One definition that no longer reads right stays out; the others still load
      const spec = definitionSchema.safeParse(tool.spec);
      try {
        if (!spec.success) {
          throw new Error(spec.error.issues.map((issue) => issue.message).join("; "));
        }
        this.sync({ ...tool, spec: spec.data }, zone);
        loaded++;
      } catch (error) {
        this.logger?.error({ err: error, tool: tool.name }, "created tool could not load");
      }
    }

    return loaded;
  }

  /**
   * Follows a change to a source: its tools take its new zone, and when it now points to another
   * engine or database they go back to drafts, since their columns may no longer be there
   *
   * @param   code        Source code
   * @param   retargeted  Whether the engine, host or database changed
   */
  async sourceChanged(code: string, retargeted: boolean): Promise<void> {
    if (retargeted) {
      await this.deps.db
        .update(toolDefinitions)
        .set({ status: "draft", publishedAt: null, updatedAt: new Date() })
        .where(and(eq(toolDefinitions.sourceCode, code), eq(toolDefinitions.status, "published")));
    }

    const rows = await this.deps.db
      .select({ tool: toolDefinitions, zone: sources.timeZone })
      .from(toolDefinitions)
      .innerJoin(sources, eq(sources.code, toolDefinitions.sourceCode))
      .where(eq(toolDefinitions.sourceCode, code));
    for (const { tool, zone } of rows) {
      this.sync(tool, zone);
    }
  }
}
