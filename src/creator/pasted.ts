import type { EngineName } from "../sources/engines.js";

export type PastedCheck = { ok: true; sql: string } | { ok: false; message: string };

interface Token {
  kind: "word" | "symbol";
  text: string;
  depth: number;
}

// Table hints of SQL Server: they take locks or change isolation, which a read-only tool must not
const MSSQL_HINTS = new Set([
  "NOLOCK",
  "READUNCOMMITTED",
  "READCOMMITTED",
  "READCOMMITTEDLOCK",
  "REPEATABLEREAD",
  "SERIALIZABLE",
  "HOLDLOCK",
  "UPDLOCK",
  "XLOCK",
  "TABLOCK",
  "TABLOCKX",
  "ROWLOCK",
  "PAGLOCK",
  "READPAST",
  "NOWAIT",
  "INDEX",
  "FORCESEEK",
  "FORCESCAN",
  "SNAPSHOT",
]);

/**
 * Splits a query into words and symbols, skipping strings, quoted names and comments as the engine
 * reads them, and marks how deep in parentheses each one is
 *
 * @param   sql     Query
 * @param   engine  Engine whose syntax applies
 *
 * @return  The tokens, or why the query cannot be read safely
 */
function tokenize(sql: string, engine: EngineName): Token[] | string {
  const tokens: Token[] = [];
  let depth = 0;
  let index = 0;
  const closing: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  const quotes =
    engine === "mysql" ? ["'", '"', "`"] : engine === "mssql" ? ["'", '"', "["] : ["'", '"'];

  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];

    if (/\s/.test(char)) {
      index += 1;
    } else if ((char === "-" && next === "-") || (char === "#" && engine === "mysql")) {
      // Postgres also ends a line comment at a carriage return
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") {
        index += 1;
      }
    } else if (char === "/" && next === "*") {
      // MySQL runs the inside of /*! … */ as code
      if (sql[index + 2] === "!") {
        return "La consulta tiene un comentario /*! */, que MySQL ejecuta como código.";
      }
      // Postgres nests block comments; the others end at the first */
      let level = 0;
      while (index < sql.length) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          level += engine === "postgres" || level === 0 ? 1 : 0;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          level -= 1;
          index += 2;
          if (level === 0) {
            break;
          }
        } else {
          index += 1;
        }
      }
      if (level !== 0) {
        return "La consulta tiene un comentario sin cerrar.";
      }
    } else if (quotes.includes(char)) {
      const end = closing[char] as string;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === end) {
          // A doubled closing mark is the mark itself, inside the string or name
          if (sql[index + 1] === end) {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        // MySQL also escapes with a backslash inside strings
        index += engine === "mysql" && sql[index] === "\\" && char !== "`" ? 2 : 1;
      }
      if (!closed) {
        return "La consulta tiene un texto o un nombre sin cerrar.";
      }
      tokens.push({ kind: "word", text: char === "'" ? "'…'" : '"…"', depth });
    } else if (/[A-Za-z_@#$]/.test(char)) {
      const start = index;
      while (index < sql.length && /[A-Za-z0-9_@#$]/.test(sql[index] as string)) {
        index += 1;
      }
      tokens.push({ kind: "word", text: sql.slice(start, index).toUpperCase(), depth });
    } else {
      if (char === ")") {
        depth -= 1;
        if (depth < 0) {
          return "La consulta cierra un paréntesis que no abrió.";
        }
      }
      tokens.push({ kind: "symbol", text: char, depth });
      if (char === "(") {
        depth += 1;
      }
      index += 1;
    }
  }

  return depth === 0 ? tokens : "La consulta deja un paréntesis sin cerrar.";
}

/**
 * Checks a query pasted by a person before it becomes the base of a tool: one read statement that
 * the creator can wrap, filter and order
 *
 * @param   sql     Pasted query
 * @param   engine  Engine of the source
 *
 * @return  The query without a closing semicolon, or why it is refused
 */
export function checkPasted(sql: string, engine: EngineName): PastedCheck {
  const refuse = (message: string): PastedCheck => ({ ok: false, message });
  const tokens = tokenize(sql, engine);
  if (typeof tokens === "string") {
    return refuse(tokens);
  }

  // A closing semicolon is dropped; anything after one is a second statement
  const semicolon = tokens.findIndex((token) => token.text === ";");
  if (semicolon >= 0 && semicolon < tokens.length - 1) {
    return refuse("Pega una sola consulta: después del ; hay otra sentencia.");
  }
  const body = semicolon >= 0 ? tokens.slice(0, -1) : tokens;

  const first = body.find((token) => token.text !== "(");
  if (!first || (first.text !== "SELECT" && first.text !== "WITH")) {
    return refuse("La consulta tiene que empezar con SELECT o WITH.");
  }

  for (const [position, token] of body.entries()) {
    const after = body[position + 1];
    const before = body[position - 1];

    // The creator orders the result itself; an order inside a wrapped query is lost or refused
    if (token.depth === 0 && token.text === "ORDER" && after?.text === "BY") {
      return refuse("Quita el ORDER BY final: el orden lo define el creador.");
    }
    if (token.depth === 0 && token.text === "INTO") {
      return refuse("La consulta no puede usar INTO: crearía o escribiría datos.");
    }
    if (token.text === "FOR" && (after?.text === "UPDATE" || after?.text === "SHARE")) {
      return refuse("La consulta no puede bloquear filas (FOR UPDATE / FOR SHARE).");
    }
    if (token.text === "LOCK" && after?.text === "IN") {
      return refuse("La consulta no puede bloquear filas (LOCK IN SHARE MODE).");
    }
    if (engine === "mssql") {
      // WITH ( after a table is a hint; a common table expression names itself first
      const hint =
        (token.text === "WITH" && after?.text === "(" && position > 0) ||
        (token.text === "(" && before?.kind === "word" && MSSQL_HINTS.has(after?.text ?? ""));
      if (hint) {
        return refuse("Quita los hints de tabla (WITH (NOLOCK) y similares): toman bloqueos.");
      }
      if (token.depth === 0 && token.text === "OPTION" && after?.text === "(") {
        return refuse("Quita el OPTION (…) final: el creador arma la consulta completa.");
      }
    }
  }

  const text = sql.trim();

  return {
    ok: true,
    sql: semicolon >= 0 ? text.replace(/;\s*(--[^\r\n]*|\/\*[\s\S]*?\*\/|\s)*$/, "") : text,
  };
}
