// Unicode tags (invisible mirrored ASCII), bidirectional overrides and zero-width characters:
// unseen by people, read by a tokenizer, and the usual way to smuggle instructions into a model
const HIDDEN = /[\u{E0000}-\u{E007F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200B}-\u{200D}\u{FEFF}]/gu;

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
 * Counts hidden characters, which never appear in normal data
 *
 * @param   text  Text to inspect
 *
 * @return  How many there are
 */
export function countHidden(text: string): number {
  return text.match(HIDDEN)?.length ?? 0;
}
