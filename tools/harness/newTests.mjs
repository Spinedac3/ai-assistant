// Decides which tests of a run are new against the base branch, for recibo.sh: only new tests must
// have been seen failing. Usage: node newTests.mjs <base-ref> < names (file::describe > test)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Counts how many tests of a file carry a title, written as it( or test( with any quotes
 *
 * @param   text   File contents, or null when the file does not exist there
 * @param   title  The test's own title
 *
 * @return  How many
 */
function declared(text, title) {
  if (text === null) {
    return 0;
  }
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return [...text.matchAll(new RegExp(`\\b(it|test)(\\.\\w+)*\\(\\s*(["'\`])${escaped}\\3`, "g"))]
    .length;
}

/**
 * Lists the tests that are new: their file declares the title more times now than on the base, so
 * a title repeated under another describe still counts as new; one whose title cannot be found as
 * written, as a template with values, counts as new too, so the receipt errs toward degrading
 *
 * @param   names     Tests as file::describe > title
 * @param   readBase  Reads a file on the base, or null when it is not there
 * @param   readNow   Reads a file as it is now
 *
 * @return  The new ones
 */
export function newTests(names, readBase, readNow) {
  const fresh = [];
  const byFile = new Map();
  for (const name of names) {
    const file = name.split("::")[0];
    const title = name.split(" > ").pop().split("::").pop();
    const key = `${file}::${title}`;
    byFile.set(key, [...(byFile.get(key) ?? []), name]);
  }
  for (const [key, group] of byFile) {
    const [file, title] = key.split("::");
    const before = declared(readBase(file), title);
    const now = declared(readNow(file), title);
    // As many of the group as the file gained are new; when the title is not found, all of them
    const added = now === 0 ? group.length : Math.max(0, Math.min(group.length, now - before));
    fresh.push(...group.slice(group.length - added));
  }

  return fresh;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const base = process.argv[2] ?? "main";
  const names = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean);
  const readBase = (file) => {
    try {
      return execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8", stdio: "pipe" });
    } catch {
      return null;
    }
  };
  const readNow = (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  for (const name of newTests(names, readBase, readNow)) {
    console.log(name);
  }
}
