import type { EngineName } from "../sources/engines.js";

export type PastedCheck = { ok: true; sql: string } | { ok: false; message: string };

interface Token {
  kind: "word" | "symbol";
  text: string;
  depth: number;
  start: number;
  end: number;
}

interface Lexed {
  tokens: Token[];
  // Spans the engine ignores; they are blanked before the query runs
  comments: Array<[number, number]>;
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

const WORD_START = /[A-Za-z_@#$]/;
const WORD_PART = /[A-Za-z0-9_@#$]/;

/**
 * Splits a query into words and symbols the way its engine reads it: strings, quoted names and
 * comments with each engine's own rules, and how deep in parentheses each token is
 *
 * @param   sql     Query
 * @param   engine  Engine whose syntax applies
 *
 * @return  The tokens and the comments, or why the query cannot be read safely
 */
function lex(sql: string, engine: EngineName): Lexed | string {
  const tokens: Token[] = [];
  const comments: Array<[number, number]> = [];
  let depth = 0;
  let index = 0;
  const closing: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  const quotes =
    engine === "mysql" ? ["'", '"', "`"] : engine === "mssql" ? ["'", '"', "["] : ["'", '"'];

  while (index < sql.length) {
    const start = index;
    const char = sql[index] as string;
    const next = sql[index + 1] ?? "";

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    // MySQL takes -- as a comment only when a space or a control character follows
    const lineComment =
      (char === "-" && next === "-" && (engine !== "mysql" || (sql[index + 2] ?? " ") <= " ")) ||
      (char === "#" && engine === "mysql");
    if (lineComment) {
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      comments.push([start, index]);
      continue;
    }

    if (char === "/" && next === "*") {
      // MySQL runs the inside of /*! … */ as code
      if (engine === "mysql" && sql[index + 2] === "!") {
        return "La consulta tiene un comentario /*! */, que MySQL ejecuta como código.";
      }
      // Postgres and SQL Server nest block comments; MySQL ends at the first */
      const nests = engine !== "mysql";
      let level = 0;
      while (index < sql.length) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          level += nests || level === 0 ? 1 : 0;
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
      comments.push([start, index]);
      continue;
    }

    // Postgres dollar quoting: $tag$ … $tag$, with no escapes inside
    if (engine === "postgres" && char === "$") {
      const tag = sql.slice(index).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end < 0) {
          return "La consulta tiene un texto entre $ sin cerrar.";
        }
        index = end + tag.length;
        tokens.push({ kind: "word", text: "'…'", depth, start, end: index });
        continue;
      }
    }

    if (quotes.includes(char)) {
      const end = closing[char] as string;
      // A backslash escapes the next character in MySQL strings and in Postgres E'' strings
      const before = sql[index - 1] ?? "";
      const escapes =
        (engine === "mysql" && char !== "`") ||
        (engine === "postgres" &&
          char === "'" &&
          /[Ee]/.test(before) &&
          !WORD_PART.test(sql[index - 2] ?? ""));
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (escapes && sql[index] === "\\") {
          index += 2;
          continue;
        }
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
        index += 1;
      }
      if (!closed) {
        return "La consulta tiene un texto o un nombre sin cerrar.";
      }
      tokens.push({ kind: "word", text: char === "'" ? "'…'" : '"…"', depth, start, end: index });
      continue;
    }

    if (WORD_START.test(char)) {
      while (index < sql.length && WORD_PART.test(sql[index] as string)) {
        index += 1;
      }
      tokens.push({
        kind: "word",
        text: sql.slice(start, index).toUpperCase(),
        depth,
        start,
        end: index,
      });
      continue;
    }

    if (char === ")") {
      depth -= 1;
      if (depth < 0) {
        return "La consulta cierra un paréntesis que no abrió.";
      }
    }
    tokens.push({ kind: "symbol", text: char, depth, start, end: index + 1 });
    if (char === "(") {
      depth += 1;
    }
    index += 1;
  }

  return depth === 0 ? { tokens, comments } : "La consulta deja un paréntesis sin cerrar.";
}

/**
 * Checks a query pasted by a person before it becomes the base of a tool: one read statement that
 * the creator can wrap, filter and order
 *
 * The query that runs is the one read here with its comments blanked out, so an engine that reads
 * a comment differently from this check still sees exactly what was checked.
 *
 * @param   sql     Pasted query
 * @param   engine  Engine of the source
 *
 * @return  The query to run, or why it is refused
 */
export function checkPasted(sql: string, engine: EngineName): PastedCheck {
  const refuse = (message: string): PastedCheck => ({ ok: false, message });
  const lexed = lex(sql, engine);
  if (typeof lexed === "string") {
    return refuse(lexed);
  }

  // Semicolons before the query, as in ;WITH, and one closing it are dropped; any other is a
  // second statement
  let tokens = lexed.tokens;
  while (tokens[0]?.text === ";") {
    tokens = tokens.slice(1);
  }
  if (tokens.at(-1)?.text === ";") {
    tokens = tokens.slice(0, -1);
  }
  if (tokens.some((token) => token.text === ";")) {
    return refuse("Pega una sola consulta: después del ; hay otra sentencia.");
  }

  const first = tokens.find((token) => token.text !== "(");
  if (!first || (first.text !== "SELECT" && first.text !== "WITH")) {
    return refuse("La consulta tiene que empezar con SELECT o WITH.");
  }
  // SQL Server cannot read a common table expression inside a derived table
  if (engine === "mssql" && first.text === "WITH") {
    return refuse("En SQL Server reescribe el WITH como subconsulta: el creador la envuelve.");
  }

  for (const [position, token] of tokens.entries()) {
    const after = tokens[position + 1];
    const before = tokens[position - 1];

    // The creator orders the result itself; an order inside a wrapped query is lost or refused
    if (token.depth === 0 && token.text === "ORDER" && after?.text === "BY") {
      return refuse("Quita el ORDER BY final: el orden lo define el creador.");
    }
    if (token.depth === 0 && token.text === "INTO") {
      return refuse("La consulta no puede usar INTO: crearía o escribiría datos.");
    }
    if (token.text === "FOR" && ["UPDATE", "SHARE", "NO", "KEY"].includes(after?.text ?? "")) {
      return refuse("La consulta no puede bloquear filas (FOR UPDATE / FOR SHARE).");
    }
    if (token.text === "LOCK" && after?.text === "IN") {
      return refuse("La consulta no puede bloquear filas (LOCK IN SHARE MODE).");
    }
    if (engine === "mssql") {
      // WITH ( after a table is a hint
      const hint =
        (token.text === "WITH" && after?.text === "(") ||
        (token.text === "(" && before?.kind === "word" && MSSQL_HINTS.has(after?.text ?? ""));
      if (hint) {
        return refuse("Quita los hints de tabla (WITH (NOLOCK) y similares): toman bloqueos.");
      }
      if (token.depth === 0 && token.text === "OPTION" && after?.text === "(") {
        return refuse("Quita el OPTION (…) final: el creador arma la consulta completa.");
      }
    }
  }

  // What runs: the checked tokens and the space between them, every comment blanked
  const from = tokens[0]?.start ?? 0;
  const to = tokens.at(-1)?.end ?? 0;
  let text = sql.slice(from, to);
  for (const [start, end] of lexed.comments) {
    if (start >= from && end <= to) {
      text = `${text.slice(0, start - from)}${" ".repeat(end - start)}${text.slice(end - from)}`;
    }
  }

  return { ok: true, sql: text };
}
