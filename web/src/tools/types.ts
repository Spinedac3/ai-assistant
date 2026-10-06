// The shape of a tool definition, as the server validates it

export type ColumnKind = "number" | "text" | "date" | "datetime" | "boolean";

export interface BaseColumn {
  name: string;
  kind: ColumnKind;
}

// A table or view of a source, as the creator offers it
export interface Relation {
  name: string;
  kind: "table" | "view";
  comment: string | null;
}

// What reading a base gives: its columns, and what it holds when the database or the model says
export interface DescribedBase {
  columns: BaseColumn[];
  description: string | null;
  note?: string;
}

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

// What each operation means for a person, in the words the form shows
export const OP_LABELS: Record<FilterOp, string> = {
  "=": "es igual a",
  "!=": "es distinto de",
  ">": "es mayor que",
  ">=": "es mayor o igual a",
  "<": "es menor que",
  "<=": "es menor o igual a",
  between: "está entre",
  in: "es uno de",
  contains: "contiene",
  empty: "está vacío o no",
};

export const AGGREGATES = ["sum", "count", "avg", "min", "max"] as const;
export type Aggregate = (typeof AGGREGATES)[number];

export const AGGREGATE_LABELS: Record<Aggregate, string> = {
  sum: "Suma",
  count: "Cuenta",
  avg: "Promedio",
  min: "Mínimo",
  max: "Máximo",
};

export type FilterValue = string | number | boolean;

// The operators whose argument is one of the column's own values
export const VALUE_OPS: ReadonlySet<string> = new Set(["=", "!=", "in"]);

// What the server finds for a filter: the column's values and the explanation for the model
export interface FilterHelp {
  values: FilterValue[] | null;
  examples: FilterValue[] | null;
  description: string | null;
  note?: string;
}

export interface Definition {
  base: { kind: "table"; name: string } | { kind: "query"; sql: string };
  columns: { name: string; label?: string }[];
  filters: {
    column: string;
    op: FilterOp;
    required: boolean;
    description?: string;
    values?: { value: FilterValue; meaning?: string }[];
    examples?: FilterValue[];
  }[];
  summary?: {
    group_by: string[];
    aggregates: { fn: Aggregate; column?: string; as: string }[];
    with_detail?: boolean;
  };
  order_by: { column: string; direction: "asc" | "desc" }[];
  time_zone?: string;
  meaning: {
    definition: string;
    grain: string;
    additive: boolean;
    synonyms: string[];
    caveats: string[];
  };
}

export interface CheckResult {
  name: "runs" | "shape" | "filter_shrinks" | "sum_adds_up" | "range_splits";
  ok: boolean;
  skipped?: boolean;
  detail: string;
}

export const CHECK_LABELS: Record<CheckResult["name"], string> = {
  runs: "Corre",
  shape: "Devuelve lo que promete",
  filter_shrinks: "Un filtro solo quita filas",
  sum_adds_up: "Las sumas por grupo dan el total",
  range_splits: "Las mitades de un rango suman el rango",
};

export interface ToolSummary {
  name: string;
  source: string;
  status: "draft" | "published";
  updated_at: string;
  published_at: string | null;
}

export interface ToolDetail {
  name: string;
  source: string;
  status: "draft" | "published";
  definition: Definition;
  columns: BaseColumn[];
  description: string;
  input_schema: { properties?: Record<string, JsonSchema>; required?: string[] };
  output_schema: unknown;
}

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  format?: string;
}

export interface TraceEntry {
  id: string;
  tool: string;
  args: unknown;
  result: string | null;
  ok: boolean | null;
  bytes: number | null;
  excel: string | null;
}

/**
 * Starts a definition for a person who has not picked anything yet
 *
 * @return  An empty definition over a table
 */
export function blankDefinition(): Definition {
  return {
    base: { kind: "table", name: "" },
    columns: [],
    filters: [],
    order_by: [],
    meaning: { definition: "", grain: "", additive: true, synonyms: [], caveats: [] },
  };
}

/**
 * Names the columns a tool returns: the grouped ones and the aggregates when it summarizes,
 * otherwise the chosen ones
 *
 * @param   definition  Definition
 *
 * @return  The names of the result's columns
 */
export function outputNames(definition: Definition): string[] {
  return definition.summary
    ? [
        ...definition.summary.group_by,
        ...definition.summary.aggregates.map((aggregate) => aggregate.as),
      ]
    : definition.columns.map((column) => column.name);
}

/**
 * Fills the parts a stored or proposed definition may leave out
 *
 * @param   definition  Definition
 *
 * @return  The same definition with every list present
 */
export function withDefaults(definition: Definition): Definition {
  return {
    ...definition,
    filters: definition.filters ?? [],
    order_by: definition.order_by ?? [],
    summary: definition.summary
      ? { ...definition.summary, group_by: definition.summary.group_by ?? [] }
      : undefined,
    meaning: {
      ...definition.meaning,
      synonyms: definition.meaning.synonyms ?? [],
      caveats: definition.meaning.caveats ?? [],
    },
  };
}

/**
 * Drops what the form keeps while a person types but the server would refuse: empty labels,
 * descriptions, synonyms and caveats
 *
 * @param   definition  Definition as edited
 *
 * @return  The definition to save
 */
export function cleanDefinition(definition: Definition): Definition {
  const text = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
  return {
    ...definition,
    columns: definition.columns.map((column) => ({ name: column.name, label: text(column.label) })),
    // A closed list only goes with an operator that takes one of its values
    filters: definition.filters.map(({ values, ...filter }) => ({
      ...filter,
      description: text(filter.description),
      ...(values && VALUE_OPS.has(filter.op)
        ? { values: values.map((item) => ({ value: item.value, meaning: text(item.meaning) })) }
        : {}),
    })),
    time_zone: text(definition.time_zone),
    meaning: {
      ...definition.meaning,
      synonyms: definition.meaning.synonyms.map((word) => word.trim()).filter(Boolean),
      caveats: definition.meaning.caveats.map((line) => line.trim()).filter(Boolean),
    },
  };
}

/**
 * Names the type of a parameter, whatever form its schema gives it
 *
 * @param   schema  Schema of the parameter
 *
 * @return  The type
 */
export function typeOf(schema: JsonSchema): string {
  const type = Array.isArray(schema.type)
    ? schema.type.find((item) => item !== "null")
    : schema.type;
  return type ?? "string";
}

/**
 * Turns what a person typed into the value a parameter takes
 *
 * @param   schema  Schema of the parameter
 * @param   value   What was typed
 *
 * @return  The argument
 */
export function argument(schema: JsonSchema, value: string | boolean): unknown {
  if (typeof value === "boolean") {
    return value;
  }
  const type = typeOf(schema);
  if (type === "boolean") {
    return value === "true";
  }
  if (type === "array") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const numeric = schema.items && ["number", "integer"].includes(typeOf(schema.items));
    return numeric ? items.map(Number) : items;
  }
  return type === "number" || type === "integer" ? Number(value) : value;
}

/**
 * Drops the choices that no longer fit what the tool reads and returns: grouping and totals over
 * columns no longer chosen, filters over columns the base no longer has, and an order over a
 * column the result no longer has
 *
 * @param   definition  Definition after a change
 * @param   base        Columns of the base, when they were read
 *
 * @return  The definition the form shows and saves
 */
export function prune(definition: Definition, base: BaseColumn[]): Definition {
  const chosen = new Set(definition.columns.map((column) => column.name));
  const known = new Set(base.map((column) => column.name));
  const summary = definition.summary && {
    ...definition.summary,
    group_by: definition.summary.group_by.filter((column) => chosen.has(column)),
    // A count counts rows; any other total needs a column that is still chosen
    aggregates: definition.summary.aggregates.map((aggregate) =>
      aggregate.fn === "count" || (aggregate.column && !chosen.has(aggregate.column))
        ? { ...aggregate, column: undefined }
        : aggregate,
    ),
  };
  const kept = {
    ...definition,
    summary,
    filters:
      base.length > 0
        ? definition.filters.filter((filter) => known.has(filter.column))
        : definition.filters,
  };
  const outputs = new Set(outputNames(kept));

  return { ...kept, order_by: kept.order_by.filter((order) => outputs.has(order.column)) };
}
