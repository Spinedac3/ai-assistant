// Reads the junit files vitest writes and prints the measured values as JSON for recibo.sh.
// Usage: node junit.mjs <file.xml> [<file.xml> ...]
import { existsSync, readFileSync } from "node:fs";

const files = process.argv.slice(2);
const empty = { tests: 0, failures: 0, failed: [], names: [] };

/**
 * Prints an error the receipt cannot pass and stops
 *
 * @param   error  What went wrong
 */
function refuse(error) {
  console.log(JSON.stringify({ error, ...empty }));
  process.exit(2);
}

/**
 * Turns the entities of an XML attribute back into text
 *
 * @param   text  Attribute value
 *
 * @return  The text
 */
function unescape(text) {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

if (files.length === 0) {
  refuse("no-junit");
}

const result = { tests: 0, failures: 0, failed: [], names: [] };
for (const file of files) {
  // A missing file voids the whole phase: an instrument that can only record success always does
  if (!existsSync(file)) {
    refuse("no-junit");
  }
  const xml = readFileSync(file, "utf8");
  if (!xml.includes("<testsuites")) {
    refuse("unreadable-junit");
  }
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attributes = match[1] ?? "";
    const body = match[3] ?? "";
    // A skipped test did not run, so it proves nothing either way
    if (/<skipped\b/.test(body)) {
      continue;
    }
    const file = unescape(/classname="([^"]*)"/.exec(attributes)?.[1] ?? "");
    const name = unescape(/\bname="([^"]*)"/.exec(attributes)?.[1] ?? "");
    const full = `${file}::${name}`;
    result.tests++;
    result.names.push(full);
    if (/<(failure|error)\b/.test(body)) {
      result.failures++;
      result.failed.push(full);
    }
  }
}

console.log(JSON.stringify(result));
