// The words a schema bounds a value with
const BOUND = /\b(maxItems|maximum|maxLength):\s*([A-Za-z_0-9]+)/g;

export interface SchemaCap {
  key: string;
  value: number;
}

/**
 * Reads a bound written as a number or as a constant of the same file
 *
 * @param   text        File contents
 * @param   expression  The number or the constant's name
 *
 * @return  Its value, or NaN when it cannot be read
 */
function boundValue(text: string, expression: string): number {
  const literal = expression.replaceAll("_", "");
  if (/^\d+$/.test(literal)) {
    return Number(literal);
  }
  const constant = new RegExp(`const ${expression} = ([\\d_]+)`).exec(text)?.[1];

  return constant ? Number(constant.replaceAll("_", "")) : Number.NaN;
}

/**
 * Names the property a position of a schema sits in, from the outermost one down
 *
 * @param   text      File contents
 * @param   position  Where the bound is written
 *
 * @return  The property path, without the schema's own words
 */
function propertyAt(text: string, position: number): string {
  const path: string[] = [];
  let depth = 0;
  for (let at = position - 1; at >= 0; at--) {
    const char = text[at];
    if (char === "}") {
      depth++;
    } else if (char === "{" && depth > 0) {
      depth--;
    } else if (char === "{") {
      const key = /(\w+):\s*$/.exec(text.slice(Math.max(0, at - 80), at))?.[1];
      if (!key || key === "inputSchema") {
        break;
      }
      path.unshift(key);
    }
  }

  // A schema built inline, as the pair of a range, bounds the value itself
  return path.filter((key) => key !== "properties").join(".") || "value";
}

/**
 * Lists every bound of the schemas in a file, under the property it bounds
 *
 * @param   name  Short name of the file, which leads each key
 * @param   text  File contents
 *
 * @return  Each bound with its key, as file:property.bound
 */
export function schemaCaps(name: string, text: string): SchemaCap[] {
  return [...text.matchAll(BOUND)].map((match) => ({
    key: `${name}:${propertyAt(text, match.index ?? 0)}.${match[1]}`,
    value: boundValue(text, match[2] ?? ""),
  }));
}
