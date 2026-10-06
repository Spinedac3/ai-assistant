import { measureFunctions, type SourceFile, sourceFiles } from "./source.js";

type Criterion = [weight: number, holds: (file: SourceFile) => boolean, what: string];

export interface Piece {
  name: string;
  candidates: () => SourceFile[];
  // A reason that rules a file out whatever it scores, or null
  disqualifies: (file: SourceFile) => string | null;
  criteria: Criterion[];
}

export interface Ranking {
  piece: string;
  ranking: Array<{ path: string; points: number; most: number; missing: string[] }>;
}

const DRIVER = /from "(mssql|mysql2(\/[^"]*)?|pg|node:child_process|child_process)"/;
const ROUTE = /app\.(get|post|put|patch|delete)\(/g;
const GUARDED_ROUTE = /app\.(get|post|put|patch|delete)\("[^"]+",\s*[a-zA-Z]+,/g;
const BIGGEST_FUNCTION = 80;
// Read once: every piece asks it for each candidate
let testNames: Set<string> | undefined;

/**
 * Tells whether a source file has a test of its own, by name, under tests/
 *
 * @param   file  Source file
 *
 * @return  Whether a unit or an integration test carries its name
 */
function tested(file: SourceFile): boolean {
  const name = `${file.path.split("/").pop()?.replace(/\.ts$/, "")}.test.ts`;
  testNames ??= new Set(sourceFiles("tests").map((test) => test.path.split("/").pop() ?? ""));

  return testNames.has(name);
}

/**
 * Tells whether every function of a file is small enough to read at once
 *
 * @param   file  Source file
 *
 * @return  Whether it is
 */
function small(file: SourceFile): boolean {
  return measureFunctions(file.text, file.path).every((fn) => fn.lines <= BIGGEST_FUNCTION);
}

/**
 * Counts the matches of a pattern in a text
 *
 * @param   text     Text
 * @param   pattern  Global pattern
 *
 * @return  How many
 */
function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

export const PIECES: Piece[] = [
  {
    name: "Native tool",
    candidates: () => sourceFiles("src/tools/native"),
    disqualifies: (file) => (DRIVER.test(file.text) ? "talks to a driver or a subprocess" : null),
    criteria: [
      [3, tested, "has its own test"],
      [2, (file) => /additionalProperties: false/.test(file.text), "refuses unknown input"],
      [2, (file) => /export const [A-Z_]+ = "[a-z_]+"/.test(file.text), "exports its name"],
      [
        1,
        (file) => /ok: false,\s*error: "/.test(file.text),
        "answers a failure as ok, error and message, not a throw",
      ],
      [1, small, "no function too long to read at once"],
    ],
  },
  {
    name: "Route module",
    candidates: () => sourceFiles("src/routes").filter((file) => count(file.text, ROUTE) > 1),
    disqualifies: (file) => (DRIVER.test(file.text) ? "talks to a driver or a subprocess" : null),
    criteria: [
      [3, tested, "has its own integration test"],
      [
        3,
        (file) => count(file.text, GUARDED_ROUTE) === count(file.text, ROUTE),
        "every route names its permission",
      ],
      [2, (file) => /safeParse\(request\.body\)/.test(file.text), "reads a body through a schema"],
      [
        1,
        (file) => /ok: false, error: "/.test(file.text),
        "answers errors as ok, error and message",
      ],
      [1, small, "no handler too long to read at once"],
    ],
  },
  {
    name: "Model call",
    candidates: () =>
      sourceFiles("src").filter((file) => /export function \w+Prompt\(/.test(file.text)),
    disqualifies: (file) => (DRIVER.test(file.text) ? "talks to a driver or a subprocess" : null),
    criteria: [
      [3, tested, "has its own test"],
      [3, (file) => /\bpromptData\(/.test(file.text), "passes data to the model as data"],
      [2, (file) => /\b(jsonIn|answerText)\(/.test(file.text), "reads the answer as untrusted"],
      [1, small, "no function too long to read at once"],
    ],
  },
];

/**
 * Scores every candidate of every piece, best first
 *
 * @param   pieces  Pieces to score
 *
 * @return  The ranking of each piece; a file ruled out does not appear
 */
export function rank(pieces: Piece[] = PIECES): Ranking[] {
  return pieces.map((piece) => {
    const most = piece.criteria.reduce((sum, [weight]) => sum + weight, 0);
    const ranking = piece
      .candidates()
      .filter((file) => piece.disqualifies(file) === null)
      .map((file) => {
        const held = piece.criteria.map(([weight, holds, what]) => ({
          weight,
          what,
          holds: holds(file),
        }));
        return {
          path: file.path,
          points: held.reduce(
            (sum, criterion) => sum + (criterion.holds ? criterion.weight : 0),
            0,
          ),
          most,
          missing: held.filter((criterion) => !criterion.holds).map((criterion) => criterion.what),
        };
      })
      .sort((a, b) => b.points - a.points || a.path.localeCompare(b.path));

    return { piece: piece.name, ranking };
  });
}
