import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PIECES, type Ranking, rank } from "./support/pieces.js";
import { ROOT } from "./support/source.js";

interface PiecesVerdict {
  missing: string[];
  extra: string[];
  dethroned: string[];
}

/**
 * Reads the exemplar the guide names for each piece, from its rows `| Piece | \`path\` | ... |`
 *
 * @param   guide  The guide's text
 *
 * @return  Each piece with its exemplar
 */
function exemplarsIn(guide: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of guide.matchAll(/^\| ([^|`]+?) \| `(src\/[^`]+)` \|/gm)) {
    found.set(match[1]?.trim() ?? "", match[2] ?? "");
  }

  return found;
}

/**
 * Compares the guide with the measured ranking: an exemplar that scores less than the best has
 * rotted, or a better one appeared; a tie at the top keeps it
 *
 * @param   named     Exemplars the guide names
 * @param   measured  Ranking of each piece
 * @param   pieces    Names of the pieces measured
 *
 * @return  What the guide gets wrong
 */
function piecesVerdict(
  named: Map<string, string>,
  measured: Ranking[],
  pieces: string[],
): PiecesVerdict {
  return {
    missing: pieces.filter((piece) => !named.has(piece)),
    extra: [...named.keys()].filter((piece) => !pieces.includes(piece)),
    dethroned: measured.flatMap(({ piece, ranking }) => {
      const best = ranking[0];
      const exemplar = ranking.find((entry) => entry.path === named.get(piece));
      if (!best) {
        return [`${piece}: ningún candidato pasa`];
      }
      if (exemplar?.points === best.points) {
        return [];
      }
      const top = ranking
        .slice(0, 3)
        .map((entry) => `${entry.points}/${entry.most} ${entry.path}`)
        .join(" · ");
      const lost = exemplar ? ` (le falta: ${exemplar.missing.join(", ")})` : "";
      return [`${piece}: la guía nombra '${named.get(piece)}'${lost}; el mejor es ${top}`];
    }),
  };
}

describe("pieces", () => {
  const named = exemplarsIn(readFileSync(join(ROOT, "CLAUDE.md"), "utf8"));
  const found = piecesVerdict(
    named,
    rank(),
    PIECES.map((piece) => piece.name),
  );

  it("names one exemplar for every piece measured, and no other", () => {
    // Performs assertions.
    expect(found.missing).toEqual([]);
    expect(found.extra).toEqual([]);
  });

  it("names, for each piece, a file that still scores best", () => {
    // Performs assertions.
    expect(
      found.dethroned,
      "Actualiza el ejemplar en CLAUDE.md o devuélvele lo que perdió",
    ).toEqual([]);
  });
});

describe("pieces, fed a guide that is wrong", () => {
  const guide = [
    "| Piece | Exemplar | Why |",
    "|---|---|---|",
    "| Native tool | `src/tools/native/a.ts` | tested |",
    "| Route module | `src/routes/b.ts` | guarded |",
  ].join("\n");
  const measured: Ranking[] = [
    {
      piece: "Native tool",
      ranking: [
        { path: "src/tools/native/c.ts", points: 9, most: 9, missing: [] },
        { path: "src/tools/native/a.ts", points: 9, most: 9, missing: [] },
      ],
    },
    {
      piece: "Route module",
      ranking: [
        { path: "src/routes/d.ts", points: 10, most: 10, missing: [] },
        { path: "src/routes/b.ts", points: 7, most: 10, missing: ["has its own test"] },
      ],
    },
  ];

  it("reads the exemplars of the table", () => {
    // Performs assertions.
    expect([...exemplarsIn(guide)]).toEqual([
      ["Native tool", "src/tools/native/a.ts"],
      ["Route module", "src/routes/b.ts"],
    ]);
  });

  it("names a dethroned exemplar with what it lacks, and keeps one tied at the top", () => {
    // Performs the test.
    const found = piecesVerdict(exemplarsIn(guide), measured, ["Native tool", "Route module"]);

    // Performs assertions.
    expect(found.dethroned).toEqual([
      "Route module: la guía nombra 'src/routes/b.ts' (le falta: has its own test); el mejor es 10/10 src/routes/d.ts · 7/10 src/routes/b.ts",
    ]);
  });

  it("names a piece the guide forgot, one it has too many of, and one with no candidate", () => {
    // Performs the test.
    const forgot = piecesVerdict(exemplarsIn(guide), measured, [
      "Native tool",
      "Route module",
      "Model call",
    ]);
    const extra = piecesVerdict(exemplarsIn(guide), measured, ["Native tool"]);
    const empty = piecesVerdict(
      exemplarsIn(guide),
      [{ piece: "Native tool", ranking: [] }],
      ["Native tool", "Route module"],
    );

    // Performs assertions.
    expect(forgot.missing).toEqual(["Model call"]);
    expect(extra.extra).toEqual(["Route module"]);
    expect(empty.dethroned).toEqual(["Native tool: ningún candidato pasa"]);
  });
});
