import { describe, expect, it } from "vitest";
import { measureFunctions, type SourceFile, sourceFiles } from "./support/source.js";

// What fails is the function that no longer fits in the head, not the long file: a schema or a
// list of routes is long and simple. Own lines leave out nested functions and text.
const MAX_OWN_LINES = 120;

// The functions over the cap, each with the size it has: the list only shrinks. Touching one
// leaves it the same or smaller, and one under the cap leaves the list.
const OVER_THE_CAP: Record<string, number> = {
  "src/chat/turn.ts :: chatTurn": 261,
  "src/chat/turn.ts :: runCli": 142,
  "src/creator/pasted.ts :: lex": 142,
  "src/cli/seedDemo.ts :: distributor": 131,
};

interface SizeVerdict {
  over: string[];
  grew: string[];
  under: string[];
  shrank: string[];
}

/**
 * Measures every function and compares it with the cap and the list
 *
 * @param   files  Files with their path
 * @param   known  Functions over the cap, with their size
 *
 * @return  The functions breaking each rule
 */
function sizeVerdict(files: SourceFile[], known: Record<string, number>): SizeVerdict {
  const sizes = new Map<string, number>(
    files.flatMap((file) =>
      measureFunctions(file.text, file.path).map((fn): [string, number] => [
        `${file.path} :: ${fn.name}`,
        fn.lines,
      ]),
    ),
  );

  return {
    over: [...sizes]
      .filter(([key, lines]) => lines > MAX_OWN_LINES && !(key in known))
      .map(([key, lines]) => `${key} (${lines})`),
    grew: Object.entries(known)
      .filter(([key, ceiling]) => (sizes.get(key) ?? 0) > ceiling)
      .map(([key, ceiling]) => `${key}: ${sizes.get(key)} > ${ceiling}`),
    under: Object.keys(known).filter((key) => (sizes.get(key) ?? 0) <= MAX_OWN_LINES),
    shrank: Object.entries(known)
      .filter(([key, ceiling]) => {
        const lines = sizes.get(key) ?? 0;
        return lines > MAX_OWN_LINES && lines < ceiling;
      })
      .map(([key, ceiling]) => `${key}: ${sizes.get(key)} < ${ceiling}`),
  };
}

describe("size", () => {
  const found = sizeVerdict(sourceFiles("src"), OVER_THE_CAP);

  it(`keeps every new function within ${MAX_OWN_LINES} own lines`, () => {
    // Performs assertions.
    expect(found.over, "Parte la función; la lista no recibe nuevas").toEqual([]);
  });

  it("never lets a function on the list grow", () => {
    // Performs assertions.
    expect(found.grew, "Una función de la lista quedó más grande").toEqual([]);
  });

  it("shrinks the list with the code: one under the cap leaves, and a smaller one lowers its size", () => {
    // Performs assertions.
    expect(found.under, "Ya está bajo el tope: quítala de la lista").toEqual([]);
    expect(found.shrank, "Bajó: baja su tamaño en la lista").toEqual([]);
  });
});

describe("size, fed a breach of each rule", () => {
  const body = (lines: number, line = "  x = x + 1;") =>
    Array.from({ length: lines }, () => line).join("\n");
  const fn = (name: string, lines: number, line?: string) =>
    `function ${name}() {\n  let x = 0;\n${body(lines, line)}\n  return x;\n}\n`;

  it("names a function over the cap, and not one made of text", () => {
    // Performs the test.
    const logic = sizeVerdict([{ path: "a.ts", text: fn("large", 118) }], {});
    const prompt = sizeVerdict(
      [
        {
          path: "a.ts",
          text: `function prompt() {\n  return [\n${body(300, '    "a line of prompt",')}\n  ].join(" ");\n}\n`,
        },
      ],
      {},
    );

    // Performs assertions.
    expect(logic.over).toEqual(["a.ts :: large (122)"]);
    expect(prompt.over).toEqual([]);
  });

  it("measures the large handler, not the function that registers it", () => {
    // Performs the test.
    const text = `function routes(app: any) {\n  app.post("/a", async () => {\n${body(125)}\n  });\n  app.post("/b", async () => {\n${body(5)}\n  });\n}\n`;
    const found = sizeVerdict([{ path: "r.ts", text }], {});

    // Performs assertions.
    expect(found.over).toEqual(["r.ts :: routes › app.post(cb) (127)"]);
  });

  it("names a listed function that grew, shrank or went under the cap", () => {
    // Performs the test.
    const grew = sizeVerdict([{ path: "a.ts", text: fn("large", 200) }], { "a.ts :: large": 150 });
    const shrank = sizeVerdict([{ path: "a.ts", text: fn("large", 130) }], {
      "a.ts :: large": 150,
    });
    const under = sizeVerdict([{ path: "a.ts", text: fn("large", 10) }], { "a.ts :: large": 150 });

    // Performs assertions.
    expect(grew.grew).toEqual(["a.ts :: large: 204 > 150"]);
    expect(shrank.shrank).toEqual(["a.ts :: large: 134 < 150"]);
    expect(under.under).toEqual(["a.ts :: large"]);
  });
});
