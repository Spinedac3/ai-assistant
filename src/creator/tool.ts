import type { Database } from "../db/client.js";
import { type ColumnKind, runQuery, TooManyRowsError } from "../sources/engines.js";
import { connectionFor, sourceScope } from "../sources/registry.js";
import type { JsonSchema, Tool, ToolResult } from "../tools/contract.js";
import type { Secrets } from "../vault/envelope.js";
import { type BaseColumn, normalizeRows } from "./columns.js";
import { type ToolDefinitionSpec, VALUE_OPS } from "./definition.js";
import { checkPasted } from "./pasted.js";
import { buildQuery, paramName } from "./sql.js";

export interface CreatedToolDependencies {
  db: Database;
  secrets: Secrets;
  // Zone of the application, the last one a date without zone falls back to
  appTimeZone: string;
}

export interface CreatedTool {
  name: string;
  sourceCode: string;
  spec: ToolDefinitionSpec;
  // Columns of the base as the source describes them
  columns: BaseColumn[];
}

// A slow report still answers; past this the source is struggling and the person should narrow it
const QUERY_TIMEOUT_MS = 60_000;
// Rows held in memory before the query is cut; the cap by bytes and the Excel come after, so this
// only guards the server, and it fails loudly instead of answering with part of the rows
const MAX_ROWS = 200_000;

const DATE = "^\\d{4}-\\d{2}-\\d{2}$";
const DATE_TIME = "^\\d{4}-\\d{2}-\\d{2}( \\d{2}:\\d{2}(:\\d{2})?)?$";

/**
 * Describes one value of a column for the input schema
 *
 * @param   kind  What the column holds
 *
 * @return  JSON schema of one value
 */
function valueSchema(kind: ColumnKind): Record<string, unknown> {
  switch (kind) {
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", pattern: DATE };
    case "datetime":
      return { type: "string", pattern: DATE_TIME };
    case "text":
      return { type: "string" };
  }
}

/**
 * Tells in words what a filter does, for the model choosing the arguments
 *
 * @param   filter  Filter of the definition
 * @param   kind    What its column holds
 *
 * @return  The description
 */
function filterText(filter: ToolDefinitionSpec["filters"][number], kind: ColumnKind): string {
  const own = filter.description ? ` ${filter.description}` : "";
  const day =
    kind === "date" || kind === "datetime"
      ? " Una fecha sola (AAAA-MM-DD) cubre el día entero."
      : "";
  const what: Record<string, string> = {
    "=": `Igual a ${filter.column}.`,
    "!=": `Distinto de ${filter.column}.`,
    ">": `${filter.column} mayor que el valor.`,
    ">=": `${filter.column} desde el valor.`,
    "<": `${filter.column} menor que el valor.`,
    "<=": `${filter.column} hasta el valor.`,
    between: `${filter.column} entre [desde, hasta], ambos incluidos.`,
    in: `${filter.column} igual a alguno de la lista.`,
    contains: `${filter.column} contiene el texto, sin distinguir mayúsculas.`,
    empty: `true: solo filas sin ${filter.column}; false: solo filas con ${filter.column}.`,
  };

  const relative = day
    ? " Si la persona habla de fechas relativas (hoy, ayer, este mes), conviértelas con la fecha de hoy."
    : "";
  const listed =
    filter.values && VALUE_OPS.has(filter.op)
      ? ` Valores posibles: ${filter.values
          .map((item) =>
            item.meaning
              ? `${JSON.stringify(item.value)} (${item.meaning})`
              : JSON.stringify(item.value),
          )
          .join(", ")}.`
      : "";
  const examples =
    !listed && filter.examples
      ? ` Ejemplos reales: ${filter.examples.map((value) => JSON.stringify(value)).join(", ")}.`
      : "";
  const omitted = filter.required ? "" : ` Si se omite, no se filtra por ${filter.column}.`;

  return `${what[filter.op]}${day}${relative}${listed}${examples}${own}${omitted}`;
}

/**
 * Builds the input schema of a created tool: one parameter per filter, typed by its column
 *
 * @param   tool  Created tool
 *
 * @return  The input schema
 */
export function inputSchemaOf(tool: CreatedTool): JsonSchema {
  const kinds = new Map(tool.columns.map((column) => [column.name, column.kind]));
  const properties: Record<string, unknown> = {};
  for (const filter of tool.spec.filters) {
    const kind = kinds.get(filter.column) ?? "text";
    // A closed list keeps the model to values the source has
    const one =
      filter.values && VALUE_OPS.has(filter.op)
        ? { ...valueSchema(kind), enum: filter.values.map((item) => item.value) }
        : valueSchema(kind);
    const schema =
      filter.op === "between"
        ? { type: "array", items: one, minItems: 2, maxItems: 2 }
        : filter.op === "in"
          ? { type: "array", items: one, minItems: 1 }
          : filter.op === "contains"
            ? { type: "string", minLength: 1 }
            : filter.op === "empty"
              ? { type: "boolean" }
              : one;
    properties[paramName(filter.column)] = { ...schema, description: filterText(filter, kind) };
  }

  return {
    type: "object",
    properties,
    required: tool.spec.filters.filter((filter) => filter.required).map((f) => paramName(f.column)),
    additionalProperties: false,
  };
}

/**
 * Lists the columns a created tool returns and what each holds
 *
 * @param   tool  Created tool
 *
 * @return  Output columns in order
 */
export function outputColumnsOf(tool: CreatedTool): BaseColumn[] {
  const kinds = new Map(tool.columns.map((column) => [column.name, column.kind]));
  const summary = tool.spec.summary;
  if (!summary) {
    return tool.spec.columns.map((column) => ({
      name: column.name,
      kind: kinds.get(column.name) ?? "text",
    }));
  }

  return [
    ...summary.group_by.map((name) => ({ name, kind: kinds.get(name) ?? "text" })),
    // Every aggregate is a number but min and max, which keep their column's kind
    ...summary.aggregates.map((aggregate) => ({
      name: aggregate.as,
      kind:
        (aggregate.fn === "min" || aggregate.fn === "max") && aggregate.column
          ? (kinds.get(aggregate.column) ?? "text")
          : ("number" as ColumnKind),
    })),
  ];
}

/**
 * The same definition without its summary: each row of the chosen columns, ordered by those of
 * them the order names, for a summary that also brings its detail
 *
 * @param   spec  Tool definition
 *
 * @return  The definition of the detail
 */
export function detailOf(spec: ToolDefinitionSpec): ToolDefinitionSpec {
  const chosen = new Set(spec.columns.map((column) => column.name));

  return {
    ...spec,
    summary: undefined,
    order_by: spec.order_by.filter((order) => chosen.has(order.column)),
  };
}

/**
 * Builds the output schema of a created tool: its rows and how many there are
 *
 * @param   tool  Created tool
 *
 * @return  The output schema
 */
export function outputSchemaOf(tool: CreatedTool): JsonSchema {
  const json: Record<ColumnKind, string> = {
    number: "number",
    boolean: "boolean",
    text: "string",
    date: "string",
    datetime: "string",
  };
  const rowsOf = (columns: BaseColumn[]) => ({
    type: "array",
    items: {
      type: "object",
      properties: Object.fromEntries(
        columns.map((column) => [column.name, { type: [json[column.kind], "null"] }]),
      ),
      required: columns.map((column) => column.name),
    },
  });
  const detail = tool.spec.summary?.with_detail
    ? {
        properties: {
          detalle: rowsOf(outputColumnsOf({ ...tool, spec: detailOf(tool.spec) })),
          total_detalle: { type: "integer" },
        },
        required: ["detalle", "total_detalle"],
      }
    : { properties: {}, required: [] };

  return {
    type: "object",
    properties: {
      filas: rowsOf(outputColumnsOf(tool)),
      total_filas: { type: "integer" },
      ...detail.properties,
    },
    required: ["filas", "total_filas", ...detail.required],
  };
}

/**
 * Says what one row of a tool is: as the person put it, or what its totals are grouped by
 *
 * @param   spec  Tool definition
 *
 * @return  What a row is
 */
function grainOf(spec: ToolDefinitionSpec): string {
  if (spec.meaning.grain) {
    return spec.meaning.grain;
  }
  const summary = spec.summary;
  if (!summary) {
    return "un registro de lo que lee la herramienta";
  }

  return summary.group_by.length > 0
    ? `el total de cada ${summary.group_by.join(" y ")}`
    : "el total de todo lo filtrado";
}

/**
 * Writes what the model reads to decide when to call a created tool and how to read it
 *
 * @param   tool      Created tool
 * @param   timeZone  Zone of its dates
 *
 * @return  The description
 */
export function descriptionOf(tool: CreatedTool, timeZone: string): string {
  const { meaning } = tool.spec;
  const labels = new Map(tool.spec.columns.map((column) => [column.name, column.label]));
  const columns = outputColumnsOf(tool)
    .map((column) =>
      labels.get(column.name) ? `${column.name} (${labels.get(column.name)})` : column.name,
    )
    .join(", ");
  const parts = [
    meaning.definition,
    `Cada fila es: ${grainOf(tool.spec)}. Columnas: ${columns}.`,
    ...(tool.spec.summary?.with_detail
      ? [
          "filas trae los totales; detalle trae cada registro detrás de ellos, con las columnas " +
            `${tool.spec.columns.map((column) => column.name).join(", ")}.`,
        ]
      : []),
    meaning.additive
      ? "Las cantidades se pueden sumar entre filas."
      : "Las cantidades NO se suman entre filas: cada fila ya es un valor completo.",
    `Las fechas están en hora de ${timeZone}; «hoy» es la fecha de esa zona.`,
    ...(meaning.synonyms.length > 0 ? [`También se le dice: ${meaning.synonyms.join(", ")}.`] : []),
    ...meaning.caveats.map((caveat) => `Ojo: ${caveat}`),
  ];

  return parts.join(" ");
}

/**
 * Turns a definition into a tool the registry runs like any other: it reads the source as its
 * read-only user, with the values bound and never written into the query
 *
 * @param   tool  Created tool
 * @param   deps  Database, vault and the zone of the application
 * @param   zone  Zone of the source, which the tool's own overrides
 *
 * @return  The tool
 */
export function toolFrom(
  tool: CreatedTool,
  deps: CreatedToolDependencies,
  zone: string | null,
): Tool {
  const timeZone = tool.spec.time_zone ?? zone ?? deps.appTimeZone;
  const kinds = new Map(tool.columns.map((column) => [column.name, column.kind]));

  return {
    definition: {
      name: tool.name,
      description: descriptionOf(tool, timeZone),
      inputSchema: inputSchemaOf(tool),
      outputSchema: outputSchemaOf(tool),
      requiredScopes: [sourceScope(tool.sourceCode)],
      readOnly: true,
    },
    execute: async (args): Promise<ToolResult> => {
      const source = await connectionFor(deps.db, deps.secrets, tool.sourceCode);
      if (!source) {
        return {
          ok: false,
          error: "source_missing",
          message: "La fuente de esta herramienta ya no existe",
        };
      }

      let pasted: string | null = null;
      if (tool.spec.base.kind === "query") {
        const checked = checkPasted(tool.spec.base.sql, source.info.engine);
        if (!checked.ok) {
          return { ok: false, error: "invalid_base", message: checked.message };
        }
        pasted = checked.sql;
      }

      const query = buildQuery(tool.spec, source.info.engine, pasted, args, kinds);
      try {
        const result = await runQuery(source.info, query.sql, query.params, {
          timeoutMs: QUERY_TIMEOUT_MS,
          maxRows: MAX_ROWS,
          timeZone,
        });
        const rows = normalizeRows(result);
        if (!tool.spec.summary?.with_detail) {
          return { ok: true, data: { filas: rows, total_filas: rows.length }, rows: rows.length };
        }

        // The detail reads the same rows the totals came from, with the same filters
        const detailQuery = buildQuery(
          detailOf(tool.spec),
          source.info.engine,
          pasted,
          args,
          kinds,
        );
        const detail = normalizeRows(
          await runQuery(source.info, detailQuery.sql, detailQuery.params, {
            timeoutMs: QUERY_TIMEOUT_MS,
            maxRows: MAX_ROWS,
            timeZone,
          }),
        );
        return {
          ok: true,
          data: {
            filas: rows,
            total_filas: rows.length,
            detalle: detail,
            total_detalle: detail.length,
          },
          rows: detail.length,
          // The totals stay whole in the answer; the detail behind them is what goes to the Excel
          main: "filas",
        };
      } catch (error) {
        if (error instanceof TooManyRowsError) {
          return { ok: false, error: "too_many_rows", message: error.message };
        }
        throw error;
      }
    },
  };
}
