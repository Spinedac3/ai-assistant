// About 3 to 4 thousand tokens: a whole procedure section without crowding the context
export const PARENT_MAX_CHARS = 12_000;

const SEPARATOR = "\n\n";
// Always in the text: the model reads the text, not the metadata, and a silent cut hides a gap
const CUT_MARK = "\n\n[...la sección continúa en el documento completo]";

export interface Sibling {
  text: string;
  chunk_index: number;
}

export interface ParentBlock {
  text: string;
  cut: boolean;
  pieces: number;
}

/**
 * Rebuilds the section a chunk belongs to, centered on the chunk that was asked for
 *
 * A step of a procedure usually depends on a condition a few lines before it, so a lone chunk can
 * answer a right step out of context. The window grows from the requested chunk, forward first,
 * so the requested text is always inside even when the section does not fit.
 *
 * @param   siblings   Chunks of the same section
 * @param   requested  chunk_index of the chunk asked for
 * @param   maxChars   Size limit
 *
 * @return  The text, whether it was cut, and how many chunks it joins
 */
export function parentBlock(
  siblings: readonly Sibling[],
  requested: number,
  maxChars = PARENT_MAX_CHARS,
): ParentBlock {
  const ordered = siblings
    .filter((sibling) => sibling.text.trim() !== "")
    .sort((a, b) => a.chunk_index - b.chunk_index);
  if (ordered.length === 0) {
    return { text: "", cut: false, pieces: 0 };
  }

  const anchorAt = Math.max(
    0,
    ordered.findIndex((sibling) => sibling.chunk_index === requested),
  );
  const anchor = (ordered[anchorAt] as Sibling).text.trim();
  if (anchor.length >= maxChars) {
    return { text: `${anchor.slice(0, maxChars)}${CUT_MARK}`, cut: true, pieces: 1 };
  }

  const chosen = [anchor];
  let length = anchor.length;
  let before = anchorAt - 1;
  let after = anchorAt + 1;
  let cut = false;

  while (before >= 0 || after < ordered.length) {
    // What follows a step weighs more than what precedes it
    const forward = after < ordered.length;
    const next = (ordered[forward ? after : before] as Sibling).text.trim();
    if (length + next.length + SEPARATOR.length > maxChars) {
      cut = true;
      break;
    }

    if (forward) {
      chosen.push(next);
      after++;
    } else {
      chosen.unshift(next);
      before--;
    }

    length += next.length + SEPARATOR.length;
  }

  const text = chosen.join(SEPARATOR);

  return { text: cut ? `${text}${CUT_MARK}` : text, cut, pieces: chosen.length };
}
