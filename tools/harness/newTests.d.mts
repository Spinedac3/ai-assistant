export function newTests(
  names: string[],
  readBase: (file: string) => string | null,
  readNow: (file: string) => string | null,
): string[];
