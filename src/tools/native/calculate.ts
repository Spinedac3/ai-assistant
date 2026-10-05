import type { Tool, ToolResult } from "../contract.js";

const MAX_EXPRESSION = 200;

// A date written inside the expression; 2026-7-30 would otherwise read as 2026 minus 7 minus 30
const LOOSE_DATE = /\d{4}-\d{1,2}-\d{1,2}/;
const SIDE = String.raw`(\d{4}-\d{1,2}-\d{1,2}|today)`;
const DAYS_BETWEEN = new RegExp(String.raw`days_between\s*\(\s*${SIDE}\s*,\s*${SIDE}\s*\)`, "gi");

type Token =
  | { kind: "number"; value: number }
  | { kind: "operator"; symbol: "+" | "-" | "*" | "/" | "%" }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "comma" }
  | { kind: "round" };

/**
 * Turns an ISO date, or today in the given zone, into a day count since the epoch
 *
 * @param   literal   ISO date or "today"
 * @param   timeZone  Zone where today is measured
 *
 * @return  Days since 1970-01-01
 */
function toDays(literal: string, timeZone: string): number {
  const iso =
    literal.toLowerCase() === "today"
      ? new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date())
      : literal;
  const [year = 0, month = 1, day = 1] = iso.split("-").map(Number);
  const moment = new Date(Date.UTC(year, month - 1, day));

  // Date.UTC rolls 2026-02-30 over into March; a date that does not exist is an error, not a guess
  if (moment.getUTCMonth() !== month - 1 || moment.getUTCDate() !== day) {
    throw new Error(`La fecha ${iso} no existe`);
  }

  return Math.floor(moment.getTime() / 86_400_000);
}

/**
 * Replaces every days_between(from, to) with the days from the first date to the second
 *
 * @param   expression  Expression as written
 * @param   timeZone    Zone where today is measured
 *
 * @return  The expression with the day counts in place
 *
 * @throws  Error  When a date does not exist
 */
export function resolveDaysBetween(expression: string, timeZone: string): string {
  return expression.replace(DAYS_BETWEEN, (_match, from: string, to: string) =>
    String(toDays(to, timeZone) - toDays(from, timeZone)),
  );
}

/**
 * Rounds like people do, halves away from zero, working on the decimal text so 1.005 is not 1.00499…
 *
 * @param   value   Number to round
 * @param   digits  Decimals to keep
 *
 * @return  The rounded number
 */
export function roundHalfAway(value: number, digits: number): number {
  const text = String(Math.abs(value));
  // Very small or large numbers already print in exponent form, where the text shift does not apply
  if (text.includes("e")) {
    return Math.sign(value) * (Math.round(Math.abs(value) * 10 ** digits) / 10 ** digits);
  }

  const scaled = Math.round(Number(`${text}e${digits}`));

  return Math.sign(value) * Number(`${scaled}e-${digits}`);
}

/**
 * Splits an expression into tokens of the allowed grammar
 *
 * @param   source  Expression
 *
 * @return  The tokens
 *
 * @throws  Error  On any character outside the grammar
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i] ?? "";

    if (/\s/.test(char)) {
      i++;
    } else if (/\d/.test(char)) {
      const match = /^\d+(\.\d+)?/.exec(source.slice(i));
      tokens.push({ kind: "number", value: Number(match?.[0]) });
      i += match?.[0].length ?? 1;
    } else if ("+-*/%".includes(char)) {
      tokens.push({ kind: "operator", symbol: char as "+" | "-" | "*" | "/" | "%" });
      i++;
    } else if (char === "(") {
      tokens.push({ kind: "open" });
      i++;
    } else if (char === ")") {
      tokens.push({ kind: "close" });
      i++;
    } else if (char === ",") {
      tokens.push({ kind: "comma" });
      i++;
    } else if (source.slice(i, i + 5).toLowerCase() === "round") {
      tokens.push({ kind: "round" });
      i += 5;
    } else {
      throw new Error(`Carácter no permitido: '${char}' (solo números, + - * / % ( ) , round)`);
    }
  }

  return tokens;
}

class Parser {
  private position = 0;

  /**
   * Prepares a parse over a token list
   *
   * @param   tokens  Tokens of the expression
   */
  constructor(private readonly tokens: Token[]) {}

  /**
   * Evaluates the whole expression
   *
   * @return  The result
   */
  parse(): number {
    const value = this.sum();
    if (this.position !== this.tokens.length) {
      throw new Error("Expresión mal formada");
    }

    return value;
  }

  /**
   * Evaluates additions and subtractions
   *
   * @return  The value
   */
  private sum(): number {
    let value = this.product();

    for (
      let token = this.peek();
      token?.kind === "operator" && "+-".includes(token.symbol);
      token = this.peek()
    ) {
      this.position++;
      const right = this.product();
      value = token.symbol === "+" ? value + right : value - right;
    }

    return value;
  }

  /**
   * Evaluates multiplications, divisions and remainders
   *
   * @return  The value
   */
  private product(): number {
    let value = this.factor();

    for (
      let token = this.peek();
      token?.kind === "operator" && "*/%".includes(token.symbol);
      token = this.peek()
    ) {
      this.position++;
      const right = this.factor();
      if (token.symbol !== "*" && right === 0) {
        throw new Error("División entre cero");
      }
      value =
        token.symbol === "*" ? value * right : token.symbol === "/" ? value / right : value % right;
    }

    return value;
  }

  /**
   * Evaluates a number, a negation, a parenthesis or round()
   *
   * @return  The value
   */
  private factor(): number {
    const token = this.peek();
    this.position++;

    if (token?.kind === "number") {
      return token.value;
    }

    if (token?.kind === "operator" && token.symbol === "-") {
      return -this.factor();
    }

    if (token?.kind === "open") {
      const value = this.sum();
      this.expect("close");
      return value;
    }

    if (token?.kind === "round") {
      this.expect("open");
      const value = this.sum();
      let digits = 0;
      if (this.peek()?.kind === "comma") {
        this.position++;
        digits = this.sum();
        if (!Number.isInteger(digits) || digits < 0 || digits > 10) {
          throw new Error("round: los decimales deben ser un entero de 0 a 10");
        }
      }
      this.expect("close");
      return roundHalfAway(value, digits);
    }

    throw new Error("Expresión incompleta o mal formada");
  }

  /**
   * Reads the next token without consuming it
   *
   * @return  The token, if any
   */
  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  /**
   * Consumes a token of the expected kind
   *
   * @param   kind  Expected kind
   */
  private expect(kind: Token["kind"]): void {
    if (this.peek()?.kind !== kind) {
      throw new Error(`Se esperaba ${kind === "close" ? ")" : "("}`);
    }
    this.position++;
  }
}

/**
 * Evaluates an arithmetic expression of the allowed grammar, never through eval
 *
 * @param   expression  Expression without dates
 *
 * @return  The result
 */
export function evaluate(expression: string): number {
  return new Parser(tokenize(expression)).parse();
}

export const calculateTool: Tool = {
  definition: {
    name: "calculate",
    description:
      "Evaluates an arithmetic expression deterministically and returns the exact result. Use it " +
      "for ANY arithmetic not already computed in a tool result, especially when combining figures " +
      "from two tools (percentages, differences, ratios). Never do the math yourself. Supports " +
      "numbers, + - * / % (remainder), parentheses, round(x, decimals) and days_between(from, to), " +
      "the days from the first date to the second, with ISO dates or the word today. Does not " +
      "replace official metrics a tool exposes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        expression: {
          type: "string",
          minLength: 1,
          maxLength: MAX_EXPRESSION,
          description:
            "For example '62.97 / 840.95 * 100', 'round(19.89 / 62.97 * 100, 1)' or " +
            "'days_between(2026-09-01, today)'. A date outside days_between is rejected.",
        },
      },
      required: ["expression"],
    },
    outputSchema: {
      type: "object",
      properties: {
        expression: { type: "string" },
        resolvedExpression: { type: "string" },
        result: { type: "number" },
        rounded: { type: "number" },
        percent: { type: "string" },
      },
      required: ["expression", "result", "rounded"],
    },
    requiredScopes: ["chat.use"],
    readOnly: true,
  },

  async execute(args, context): Promise<ToolResult> {
    const expression = String(args.expression).trim();
    let resolved: string;
    try {
      resolved = resolveDaysBetween(expression, context.timeZone);
    } catch (error) {
      return { ok: false, error: "invalid_date", message: (error as Error).message };
    }

    // Left in place, a date would be read as chained subtractions and give a plausible wrong number
    if (LOOSE_DATE.test(resolved)) {
      return {
        ok: false,
        error: "date_in_expression",
        message:
          "La expresión tiene una fecha suelta y se leería como restas. Para días entre fechas usa days_between(2026-09-01, today).",
      };
    }

    let result: number;
    try {
      result = evaluate(resolved);
    } catch (error) {
      return { ok: false, error: "invalid_expression", message: (error as Error).message };
    }

    if (!Number.isFinite(result)) {
      return { ok: false, error: "not_finite", message: "La expresión no da un número finito" };
    }

    return {
      ok: true,
      data: {
        expression,
        ...(resolved !== expression ? { resolvedExpression: resolved } : {}),
        result,
        rounded: roundHalfAway(result, 2),
        // Only for proportions, so a value already in percent is not turned into percent again
        ...(Math.abs(result) <= 1 ? { percent: `${Math.round(result * 10_000) / 100}%` } : {}),
      },
    };
  },
};
