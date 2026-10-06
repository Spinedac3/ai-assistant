import { z } from "zod";
import { countHidden } from "../lib/hiddenText.js";
import { timeZone } from "../sources/registry.js";
import { paramName } from "./sql.js";

// Also the name the model calls; lowercase so it reads the same on every client
export const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * Tells whether a name can be quoted by any of the three engines: none of their quote marks, no
 * control characters and nothing hidden
 *
 * @param   name  Name as the source writes it
 *
 * @return  Whether it is safe to quote
 */
function quotable(name: string): boolean {
  return (
    name.length > 0 &&
    countHidden(name) === 0 &&
    ![...name].some((char) => '"`]'.includes(char) || char < " ")
  );
}

// Any name the source uses; the creator quotes it, and the length is the longest the engines take
export const columnName = z
  .string()
  .max(128)
  .refine(quotable, "sin comillas, corchetes ni caracteres de control");

// A table or a view, optionally with its schema, written as the source names it
const relationName = z
  .string()
  .max(257)
  .refine((name) => {
    const parts = name.split(".");
    return parts.length <= 2 && parts.every(quotable);
  }, "esquema.tabla o tabla, sin comillas ni corchetes");

// The most values a filter offers as a closed list; a column with more gets examples instead
export const MAX_FILTER_VALUES = 30;
// The operators whose argument is one of the column's own values
export const VALUE_OPS = new Set(["=", "!=", "in"]);

const filterValue = z.union([z.string().max(200), z.number(), z.boolean()]);

export const FILTER_OPS = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "between",
  "in",
  "contains",
  "empty",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const AGGREGATES = ["sum", "count", "avg", "min", "max"] as const;

const aliasName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "minúsculas, números y guion bajo");

// What a tool reads: a table or view, or a query a person pastes
export const baseSchema = z.discriminatedUnion("kind", [
  // A table or a view: both are read the same way
  z.object({ kind: z.literal("table"), name: relationName }).strict(),
  // A query a person pastes is a few thousand characters; it travels to the source on every call
  z.object({ kind: z.literal("query"), sql: z.string().trim().min(1).max(100_000) }).strict(),
]);

export const definitionSchema = z
  .object({
    base: baseSchema,
    columns: z
      .array(z.object({ name: columnName, label: z.string().trim().min(1).optional() }).strict())
      .min(1),
    filters: z
      .array(
        z
          .object({
            column: columnName,
            op: z.enum(FILTER_OPS),
            required: z.boolean().default(false),
            description: z.string().trim().min(1).max(2_000).optional(),
            // The only values the model may send, each with what it means
            values: z
              .array(
                z
                  .object({
                    value: filterValue,
                    meaning: z.string().trim().min(1).max(200).optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(MAX_FILTER_VALUES)
              .optional(),
            // Real values, so the model writes them as the source does
            examples: z.array(filterValue).min(1).max(5).optional(),
          })
          .strict(),
      )
      .default([]),
    summary: z
      .object({
        group_by: z.array(columnName).default([]),
        aggregates: z
          .array(
            z
              .object({ fn: z.enum(AGGREGATES), column: columnName.optional(), as: aliasName })
              .strict(),
          )
          .min(1),
        // The rows behind the totals too; a long detail travels whole in the Excel
        with_detail: z.boolean().optional(),
      })
      .strict()
      .optional(),
    order_by: z
      .array(z.object({ column: z.string().min(1), direction: z.enum(["asc", "desc"]) }).strict())
      .default([]),
    // Zone of the dates without one; absent, the source's applies
    time_zone: timeZone.optional(),
    meaning: z
      .object({
        definition: z.string().trim().min(1),
        // Said by the person or suggested; without it the totals say what a row is
        grain: z.string().trim().min(1).optional(),
        additive: z.boolean().default(true),
        synonyms: z.array(z.string().trim().min(1)).default([]),
        caveats: z.array(z.string().trim().min(1)).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    const columns = definition.columns.map((column) => column.name);

    // Each filter is a parameter of the tool, named after its column
    const filtered = definition.filters.map((filter) => filter.column);
    if (new Set(filtered).size !== filtered.length) {
      issue("Cada columna lleva un solo filtro; para un rango usa between");
    } else if (new Set(filtered.map(paramName)).size !== filtered.length) {
      issue(
        "Dos filtros darían el mismo nombre de parámetro; sus columnas solo difieren en tildes o signos",
      );
    }
    if (new Set(columns).size !== columns.length) {
      issue("Hay columnas repetidas");
    }
    for (const filter of definition.filters) {
      if (filter.values && !VALUE_OPS.has(filter.op)) {
        issue(`El filtro de ${filter.column} no toma un valor de la lista; quita sus valores`);
      }
      const listed = (filter.values ?? []).map((item) => JSON.stringify(item.value));
      if (new Set(listed).size !== listed.length) {
        issue(`El filtro de ${filter.column} repite un valor`);
      }
    }

    const summary = definition.summary;
    for (const aggregate of summary?.aggregates ?? []) {
      if (aggregate.fn !== "count" && !aggregate.column) {
        issue(`${aggregate.fn} necesita una columna`);
      }
    }
    for (const column of summary?.group_by ?? []) {
      if (!columns.includes(column)) {
        issue(`Se agrupa por ${column}, que no está entre las columnas`);
      }
    }

    // Each column of the result needs a name of its own
    const named = [...(summary?.group_by ?? []), ...(summary?.aggregates ?? []).map((a) => a.as)];
    if (new Set(named).size !== named.length) {
      issue("Cada agregado necesita un nombre que no repita otra columna del resultado");
    }

    // The result has the grouped columns and the aggregates, or the plain columns
    const output = summary
      ? [...summary.group_by, ...summary.aggregates.map((aggregate) => aggregate.as)]
      : columns;
    for (const order of definition.order_by) {
      if (!output.includes(order.column)) {
        issue(`Se ordena por ${order.column}, que no sale en el resultado`);
      }
    }
  });

export type ToolDefinitionSpec = z.infer<typeof definitionSchema>;
