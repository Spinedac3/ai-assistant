import { removeHidden } from "./hiddenText.js";

/**
 * Finds the JSON object in a model's answer, which may come with words around it
 *
 * @param   answer  What the model replied
 *
 * @return  Its fields, or none when there is no readable object
 */
export function jsonIn(answer: string): Record<string, unknown> {
  const json = /\{[\s\S]*\}/.exec(answer)?.[0];
  try {
    const parsed: unknown = json ? JSON.parse(json) : {};
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Reads a text the model wrote: trimmed, cut and with nothing hidden
 *
 * @param   value  Field of the answer
 * @param   max    Most characters kept
 *
 * @return  The text, or null when there is none
 */
export function answerText(value: unknown, max: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const clean = removeHidden(value).trim();

  return clean === "" ? null : clean.slice(0, max);
}
