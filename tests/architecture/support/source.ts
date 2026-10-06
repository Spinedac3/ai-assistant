import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface SourceFile {
  path: string;
  text: string;
}

export interface MeasuredFunction {
  name: string;
  lines: number;
  from: number;
}

// A line that starts as text is a prompt or a message, not logic
const STARTS_AS_TEXT = /^\s*["'`]/;

/**
 * Reads the TypeScript files under a folder of the repository
 *
 * @param   folder  Folder, relative to the repository
 * @param   suffix  File ending to keep
 *
 * @return  Each file with its path relative to the repository
 */
export function sourceFiles(folder: string, suffix = ".ts"): SourceFile[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        return name === "node_modules" || name === "dist" ? [] : walk(path);
      }
      return name.endsWith(suffix) ? [path] : [];
    });

  return walk(join(ROOT, folder)).map((path) => ({
    path: relative(ROOT, path).split(sep).join("/"),
    text: readFileSync(path, "utf8"),
  }));
}

/**
 * Finds the comments of a file, never a // inside a string
 *
 * @param   text  File contents
 * @param   path  File path, which tells the parser whether it holds JSX
 *
 * @return  Each comment with the line it starts on
 */
export function commentsOf(text: string, path = "file.ts"): Array<{ line: number; text: string }> {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const found = new Map<number, string>();
  const collect = (position: number) => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, position) ?? []),
      ...(ts.getTrailingCommentRanges(text, position) ?? []),
    ]) {
      found.set(range.pos, text.slice(range.pos, range.end));
    }
  };
  // Every token, punctuation included, since a comment can sit before a closing brace or after a
  // last comma where no node starts; the text of JSX is prose, never a comment
  const prose: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      prose.push([node.getFullStart(), node.getEnd()]);
      return;
    }
    collect(node.getFullStart());
    collect(node.getEnd());
    for (const child of node.getChildren(file)) {
      visit(child);
    }
  };
  visit(file);

  // A scan that ends where JSX text begins would read that text as a comment
  return [...found]
    .filter(([position]) => !prose.some(([from, to]) => position >= from && position < to))
    .sort(([a], [b]) => a - b)
    .map(([position, comment]) => ({
      line: file.getLineAndCharacterOfPosition(position).line + 1,
      text: comment,
    }));
}

/**
 * Measures the own lines of every function in a file: its body without the functions nested in it
 * and without text, so a function that only registers handlers or returns a long prompt is small
 *
 * @param   text  File contents
 * @param   path  File path, for the parser
 *
 * @return  Each function with a readable name, its own lines and where it starts
 */
export function measureFunctions(text: string, path = "file.ts"): MeasuredFunction[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lineOf = (position: number) => file.getLineAndCharacterOfPosition(position).line;
  const found: Array<{ name: string; from: number; to: number }> = [];
  const textLines = new Set<number>();
  for (const [index, line] of text.split("\n").entries()) {
    if (STARTS_AS_TEXT.test(line)) {
      textLines.add(index);
    }
  }

  const visit = (node: ts.Node, parent?: string): void => {
    let name = parent;
    if (ts.isFunctionLike(node) && (node as ts.FunctionLikeDeclaration).body) {
      const own = nameOf(node as ts.FunctionLikeDeclaration);
      name = parent ? `${parent} › ${own}` : own;
      found.push({ name, from: lineOf(node.getStart()), to: lineOf(node.getEnd()) });
    } else if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      for (let line = lineOf(node.getStart()) + 1; line < lineOf(node.getEnd()); line++) {
        textLines.add(line);
      }
    }
    // A callback that returns something truthy stops forEachChild, so this one returns nothing
    ts.forEachChild(node, (child) => {
      visit(child, name);
    });
  };
  ts.forEachChild(file, (child) => {
    visit(child);
  });

  const measured = found.map((fn) => {
    const nested = new Set<number>();
    for (const other of found) {
      const inside = other.from >= fn.from && other.to <= fn.to;
      if (other !== fn && inside && !(other.from === fn.from && other.to === fn.to)) {
        for (let line = other.from; line <= other.to; line++) {
          nested.add(line);
        }
      }
    }
    let lines = 0;
    for (let line = fn.from; line <= fn.to; line++) {
      if (!nested.has(line) && !textLines.has(line)) {
        lines++;
      }
    }
    return { name: fn.name, lines, from: fn.from + 1 };
  });

  // Several handlers in one container share a name, so the later ones are numbered
  const seen = new Map<string, number>();
  for (const fn of measured.sort((a, b) => a.from - b.from)) {
    const times = seen.get(fn.name) ?? 0;
    seen.set(fn.name, times + 1);
    if (times > 0) {
      fn.name = `${fn.name}#${times + 1}`;
    }
  }

  return measured;
}

/**
 * Names a function as a person would look for it
 *
 * @param   node  Function node
 *
 * @return  Its name, the variable or property holding it, or the call it is passed to
 */
function nameOf(node: ts.FunctionLikeDeclaration): string {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
    return node.name.getText();
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
    return parent.name.getText();
  }
  if (ts.isCallExpression(parent)) {
    return `${(parent.expression.getText().split("\n")[0] ?? "").slice(0, 30)}(cb)`;
  }

  return "(anonymous)";
}
