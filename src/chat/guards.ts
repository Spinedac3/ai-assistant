import { cliToolName, FIND_CAPABILITY, RUN_CAPABILITY } from "../mcp/names.js";

export const NO_ANSWER = "No pude completar la respuesta a eso. ¿Me la repites?";

export const NO_DATA =
  "No pude consultar los datos para responder eso. Prueba de nuevo en un momento.";

export const NOT_FINISHED =
  "No terminé esta consulta: necesitaba más pasos de los que puedo dar en una sola respuesta y " +
  "prefiero no entregarte un resultado a medias. Si es una lista larga, envíamela en partes más " +
  "pequeñas y te respondo cada una completa.";

// What the retry carries after a turn that left the person without an answer
export const RETRY_DIRECTIVE =
  "AVISO DEL SISTEMA: tu turno anterior dejó a la persona SIN respuesta (anunciaste que ibas a " +
  "consultar y no llamaste herramientas, cerraste el turno sin escribir nada, ESCRIBISTE llamadas " +
  "y resultados como texto sin ejecutarlas, o afirmaste cifras sin haber consultado ninguna " +
  "herramienta). No anuncies y NO termines el turno sin la respuesta escrita: llama " +
  `\`${cliToolName(FIND_CAPABILITY)}\`, después \`${cliToolName(RUN_CAPABILITY)}\`, y responde ` +
  "con el DATO. Si la capacidad está bloqueada, falla o no devuelve el dato, responde SOLO ese " +
  "estado: nunca produzcas el dato de memoria ni con una capacidad que responde otra cosa.";

// Openers the model writes after its tools even when told not to; only ever trimmed, never added
const NARRATION_OPENER =
  /^\s*(encontr[eé] el tema[^\n]*|el tema (es|exacto)[^\n]*|perfecto[,.! ]+(encontr|identifi)[^\n]*|(d[eé]jame|dejame|voy a|necesito)\s+(buscar|consultar|revisar|verificar)[^\n]*)$/i;

// Wider than the opener on purpose: it only detects to trigger a retry, it never cuts content
const ANNOUNCEMENT =
  /^\s*(?:(?:perd[oó]n|disculp[ae]|disculpe|claro|ok|listo)[^.\n]{0,40}[.]\s*)?(?:d[eé]jame|perm[ií]teme|voy a|necesito|ahora)\s+(?:ver|mirar|buscar|consultar|revisar|verificar|chequear|averiguar|confirmar)[^\n]*$/i;

// Markup of tool calls and results typed as plain text; the source gate script uses it too
export const TOOL_THEATER_SOURCE = String.raw`<(?:invoke|tool_result|available_tool|use_tool)\b|<parameter name=|Tool search results`;

// A figure as written in an answer: digits with thousands, decimal, time or date separators
export const FIGURE_SOURCE = String.raw`\d[\d.,:/]*`;

// The numbering of a list item is layout, not a figure; two digits at most, so a year that opens
// a line is still checked
export const LIST_MARKER_SOURCE = String.raw`^\s*(?:\*\*)?\d{1,2}[.)](?:\*\*)?\s`;

const TOOL_THEATER = new RegExp(TOOL_THEATER_SOURCE, "i");

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/**
 * Writes ISO dates in the ways an answer usually quotes them
 *
 * @param   isoDates  Dates the server itself gave the model
 *
 * @return  Every spelling, longest first, so a long one is removed before its parts
 */
export function dateSpellings(isoDates: readonly string[]): string[] {
  const spellings = isoDates.flatMap((iso) => {
    const [year, month, day] = iso.split("-");
    const monthName = MONTHS[Number(month) - 1] ?? "";
    const d = String(Number(day));
    const m = String(Number(month));

    return [
      iso,
      `${day}/${month}/${year}`,
      `${d}/${m}/${year}`,
      `${d} de ${monthName} de ${year}`,
      `${d} de ${monthName}`,
    ];
  });

  return [...new Set(spellings)].sort((a, b) => b.length - a.length);
}

/**
 * Matches a date only when no digit touches it, so the 4th never matches inside the 24th
 *
 * @param   date  Exact spelling of a date
 *
 * @return  A global pattern for that date
 */
export function wholeDate(date: string): RegExp {
  return new RegExp(`(?<!\\d)${date.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?!\\d)`, "g");
}

/**
 * Extracts the figures of a text, leaving out list numbering, given dates and trailing punctuation
 *
 * @param   text       Answer text
 * @param   knownDates Exact spellings of dates the server gave the model
 *
 * @return  The figures in order
 */
export function figuresIn(text: string, knownDates: readonly string[] = []): string[] {
  let remaining = text.replace(new RegExp(LIST_MARKER_SOURCE, "gm"), "");

  for (const date of knownDates) {
    remaining = remaining.replace(wholeDate(date), " ");
  }

  return (remaining.match(new RegExp(FIGURE_SOURCE, "g")) ?? []).map((figure) =>
    figure.replace(/[.,:/]+$/, ""),
  );
}

/**
 * Tells whether a whole turn was only the announcement of a lookup that never happened
 *
 * @param   text  Text of the turn
 *
 * @return  Whether every paragraph is an announcement
 */
export function isOnlyAnnouncement(text: string): boolean {
  const trimmed = text.trim();

  // An announcement is short; the cap keeps a real answer that starts with "voy a revisar"
  if (trimmed === "" || trimmed.length > 240) {
    return false;
  }

  return trimmed
    .split(/\n{2,}/)
    .every(
      (paragraph) => ANNOUNCEMENT.test(paragraph.trim()) || NARRATION_OPENER.test(paragraph.trim()),
    );
}

/**
 * Tells whether the model typed tool calls and their results instead of running them
 *
 * @param   text  Text of the turn
 *
 * @return  Whether the text carries tool markup
 */
export function isToolTheater(text: string): boolean {
  return TOOL_THEATER.test(text);
}

/**
 * Tells whether an answer states figures that no tool and no earlier message provided
 *
 * @param   answer         Text about to be delivered
 * @param   known          Question and earlier messages of the conversation
 * @param   toolsExecuted  Tools run in the turn
 * @param   knownDates     Exact spellings of dates the server gave the model
 *
 * @return  Whether the answer has a figure without a source
 */
export function claimsUnsourcedFigures(
  answer: string,
  known: string,
  toolsExecuted: number,
  knownDates: readonly string[] = [],
): boolean {
  if (toolsExecuted > 0) {
    return false;
  }

  // Whole figures, separators aside: 1,240 matches 1240, but 20 never hides inside 2026
  const digits = (figure: string) => figure.replace(/\D/g, "");
  const knownFigures = new Set(figuresIn(known).map(digits));

  return figuresIn(answer, knownDates).some((figure) => !knownFigures.has(digits(figure)));
}

/**
 * Drops narration paragraphs from the start of an answer while other content remains
 *
 * @param   text  Answer text
 *
 * @return  The answer without leading narration
 */
export function trimLeadingNarration(text: string): string {
  const paragraphs = text.split(/\n{2,}/);

  while (paragraphs.length > 1 && NARRATION_OPENER.test(paragraphs[0]?.trim() ?? "")) {
    paragraphs.shift();
  }

  return paragraphs.join("\n\n");
}

/**
 * Joins text blocks, keeping only the longest of two that share most of their lines
 *
 * @param   blocks  Text blocks of the turn
 *
 * @return  The joined text
 */
export function joinWithoutRepeats(blocks: readonly string[]): string {
  const lines = (block: string) =>
    new Set(
      block
        .split(/\n+/)
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.length > 0),
    );
  const kept: string[] = [];

  for (const block of blocks) {
    if (block.trim() === "") {
      continue;
    }

    const blockLines = lines(block);
    const twin = kept.findIndex((other) => {
      const otherLines = lines(other);
      const shared = [...blockLines].filter((line) => otherLines.has(line)).length;

      return shared / Math.max(1, Math.min(otherLines.size, blockLines.size)) >= 0.7;
    });

    if (twin === -1) {
      kept.push(block);
    } else if (block.length > (kept[twin] ?? "").length) {
      kept[twin] = block;
    }
  }

  return kept.join("\n\n").trim();
}

export interface TurnEvent {
  spentTokens?: number;
  text?: string;
  rejected?: true;
  toolResult?: { id: string; ok: boolean };
  toolPending?: { id: string; name: string };
}

/**
 * Splits the text of a turn into everything said and what was said after the last tool
 *
 * @param   events  Events of the turn in order
 *
 * @return  All text blocks and the blocks after the last tool
 */
export function turnBlocks(events: readonly TurnEvent[]): { all: string[]; afterTools: string[] } {
  let before: string[] = [];
  let after: string[] = [];
  let draft: string[] = [];

  for (const event of events) {
    if (event.text !== undefined) {
      after.push(event.text);
    } else if (event.rejected) {
      // The source gate refused this text; the rewrite replaces it
      draft = after;
      after = [];
    } else if (event.toolResult) {
      before = before.concat(after);
      after = [];
      draft = [];
    }
  }

  if (after.length === 0 && draft.length > 0) {
    after = draft;
  }

  return { all: before.concat(after), afterTools: after };
}

/**
 * Gives the declared failure when the turn hit the step cap with nothing written after its tools
 *
 * @param   cutByMaxTurns  Whether the CLI stopped at the step cap
 * @param   afterTools     Text written after the last tool
 *
 * @return  The failure text, or null when the turn ended normally
 */
export function cutOffAnswer(cutByMaxTurns: boolean, afterTools: readonly string[]): string | null {
  return cutByMaxTurns && afterTools.length === 0 ? NOT_FINISHED : null;
}

/**
 * Returns the answer, or the declared failure when there is nothing to deliver
 *
 * @param   answer  Answer text
 *
 * @return  Text that is never empty
 */
export function finalAnswer(answer: string): string {
  return answer.trim() !== "" ? answer : NO_ANSWER;
}

/**
 * Appends which tools really ran, taken from the trace and never from the model's text
 *
 * @param   answer   Answer text
 * @param   sources  Names of the tools that ran
 *
 * @return  The answer with its source line
 */
export function sealSources(answer: string, sources: readonly string[]): string {
  if (answer === NO_ANSWER || answer === NO_DATA) {
    return answer;
  }

  const names = [...new Set(sources)].map((source) => source.replace(/_/g, " "));
  if (names.length > 0) {
    return `${answer}\n\n_Fuentes consultadas: ${names.join(", ")}._`;
  }

  return `${answer}\n\n_Respondido sin consultar fuentes._`;
}

/**
 * Builds a deterministic summary to seed a fresh CLI session from the stored conversation
 *
 * @param   messages  Earlier messages, oldest first
 *
 * @return  The summary, or null when there is nothing to summarize
 */
export function threadSummary(
  messages: ReadonlyArray<{ role: string; content: string }>,
): string | null {
  const dialogue = messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.content.trim() !== "",
    )
    .slice(-10)
    .map((message) => {
      const line = message.content.replace(/\s+/g, " ").trim();
      // What the person wrote goes whole: it is their data and cannot be looked up again
      const whole = message.role === "user" || line.length <= 220;

      return `- ${message.role === "user" ? "persona" : "tú"}: ${whole ? line : `${line.slice(0, 220)}…`}`;
    });

  if (dialogue.length === 0) {
    return null;
  }

  return [
    "[nota del sistema, no la menciones a la persona] El hilo de esta conversación se reinició",
    "porque el contexto acumulado superaba el límite técnico. Resumen de los últimos intercambios",
    "(el historial completo sigue guardado):",
    ...dialogue,
    "Responde el mensaje nuevo con normalidad, consultando tus herramientas.",
  ].join("\n");
}

/**
 * Tells whether a user event is the feedback the CLI injects when a Stop hook blocks
 *
 * @param   content  Content of the user event
 *
 * @return  Whether it is a hook rejection
 */
export function isHookRejection(content: unknown): boolean {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              block &&
              typeof block === "object" &&
              typeof (block as { text?: unknown }).text === "string"
                ? (block as { text: string }).text
                : "",
            )
            .join("")
        : "";

  return text.trimStart().startsWith("Stop hook feedback");
}
