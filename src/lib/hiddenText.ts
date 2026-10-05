// Unicode tags (invisible mirrored ASCII), variation selectors (bytes hidden behind an emoji),
// bidirectional marks, zero-width and invisible operators, and blank fillers: unseen by people,
// read by a tokenizer, and the usual ways to smuggle instructions into a model
const HIDDEN =
  /[\u{E0000}-\u{E007F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{200B}-\u{200F}\u{061C}\u{00AD}\u{180E}\u{115F}\u{1160}\u{3164}\u{FFA0}\u{FFF9}-\u{FFFB}\u{FEFF}]|[\u{FE00}-\u{FE0F}]|[\u{E0100}-\u{E01EF}]|\u{034F}/gu;

/**
 * Removes characters that hide text from people but not from a model
 *
 * @param   text  Text a model is about to read
 *
 * @return  The text without them
 */
export function removeHidden(text: string): string {
  return text.replace(HIDDEN, "");
}

/**
 * Removes hidden characters from every text of a value, at any depth
 *
 * @param   value  Value parsed from JSON
 *
 * @return  The same value with clean texts
 */
export function removeHiddenDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return removeHidden(value);
  }
  if (Array.isArray(value)) {
    return value.map(removeHiddenDeep);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        removeHidden(key),
        removeHiddenDeep(item),
      ]),
    );
  }

  return value;
}

/**
 * Counts hidden characters, which never appear in normal data
 *
 * @param   text  Text to inspect
 *
 * @return  How many there are
 */
export function countHidden(text: string): number {
  return text.match(HIDDEN)?.length ?? 0;
}
