import { describe, expect, it } from "vitest";
import {
  claimsUnsourcedFigures,
  cutOffAnswer,
  finalAnswer,
  isHookRejection,
  isOnlyAnnouncement,
  isToolTheater,
  joinWithoutRepeats,
  NO_ANSWER,
  NO_DATA,
  NOT_FINISHED,
  sealSources,
  threadSummary,
  trimLeadingNarration,
  turnBlocks,
} from "../../src/chat/guards.js";

describe("guards", () => {
  it("detects a turn that only announced a lookup", () => {
    // Performs assertions.
    expect(isOnlyAnnouncement("Déjame consultar la disponibilidad del personal de hoy.")).toBe(
      true,
    );
    expect(isOnlyAnnouncement("Perdón. Déjame revisar qué tengo para eso.")).toBe(true);
  });

  it("does not mistake a real answer that opens with an announcement", () => {
    // Performs the test.
    const answer = `Voy a revisar. ${"La línea 3 cerró con todo en orden. ".repeat(10)}`;

    // Performs assertions.
    expect(isOnlyAnnouncement(answer)).toBe(false);
    expect(isOnlyAnnouncement("")).toBe(false);
  });

  it("detects tool calls typed as text", () => {
    // Performs assertions.
    expect(isToolTheater('<invoke name="run_capability"><parameter name="x">1</parameter>')).toBe(
      true,
    );
    expect(isToolTheater("<tool_result>evento 0007 a las 08:15</tool_result>")).toBe(true);
    expect(isToolTheater("El pedido 4410 salió a tiempo.")).toBe(false);
  });

  it("flags figures that no tool and no earlier message gave", () => {
    // Performs assertions.
    expect(
      claimsUnsourcedFigures("Hoy se despacharon 1,240 cajas.", "¿cuánto se despachó?", 0),
    ).toBe(true);
  });

  it("accepts figures repeated from the question or the thread", () => {
    // Performs the test.
    const known = "¿qué pasó con el pedido 501229?\nEl pedido 501229 sigue en ruta.";

    // Performs assertions.
    expect(claimsUnsourcedFigures("Sobre el 501229, ¿quieres el detalle?", known, 0)).toBe(false);
  });

  it("leaves figures alone once a tool ran", () => {
    // Performs assertions.
    expect(claimsUnsourcedFigures("Se despacharon 1,240 cajas.", "¿cuánto?", 1)).toBe(false);
  });

  it("trims narration openers but never the only paragraph", () => {
    // Performs assertions.
    expect(
      trimLeadingNarration("Encontré el tema exacto: envíos.\n\nEl envío llega el jueves."),
    ).toBe("El envío llega el jueves.");
    expect(trimLeadingNarration("Déjame buscar eso.")).toBe("Déjame buscar eso.");
  });

  it("keeps one copy of an answer the model wrote twice", () => {
    // Performs the test.
    const first = "Resumen:\n- Ruta norte: 12 entregas\n- Ruta sur: 9 entregas";
    const second = "Resumen:\n- Ruta norte: 12 entregas\n- Ruta sur: 9 entregas\n- Total: 21";

    // Performs assertions.
    expect(joinWithoutRepeats([first, second])).toBe(second);
    expect(joinWithoutRepeats(["Hola.", "Otra cosa distinta."])).toBe(
      "Hola.\n\nOtra cosa distinta.",
    );
  });

  it("drops the draft the source gate rejected and keeps the rewrite", () => {
    // Performs the test.
    const blocks = turnBlocks([
      { toolPending: { id: "t1", name: "orders" } },
      { toolResult: { id: "t1", ok: true } },
      { text: "Hay 40 pedidos." },
      { rejected: true },
      { text: "Hay 38 pedidos." },
    ]);

    // Performs assertions.
    expect(blocks.afterTools).toEqual(["Hay 38 pedidos."]);
  });

  it("falls back to the draft when nothing came after the rejection", () => {
    // Performs the test.
    const blocks = turnBlocks([{ text: "Hay 38 pedidos." }, { rejected: true }]);

    // Performs assertions.
    expect(blocks.afterTools).toEqual(["Hay 38 pedidos."]);
  });

  it("declares the failure of a turn cut at the step cap with nothing after its tools", () => {
    // Performs assertions.
    expect(cutOffAnswer(true, [])).toBe(NOT_FINISHED);
    expect(cutOffAnswer(true, ["Listo, aquí está la tabla."])).toBeNull();
    expect(cutOffAnswer(false, [])).toBeNull();
  });

  it("never delivers an empty answer", () => {
    // Performs assertions.
    expect(finalAnswer("   ")).toBe(NO_ANSWER);
    expect(finalAnswer("Hola")).toBe("Hola");
  });

  it("seals the answer with the tools that ran, or with none", () => {
    // Performs assertions.
    expect(sealSources("Listo.", ["orders_by_route", "orders_by_route"])).toBe(
      "Listo.\n\n_Fuentes consultadas: orders by route._",
    );
    expect(sealSources("Listo.", [])).toBe("Listo.\n\n_Respondido sin consultar fuentes._");
    expect(sealSources(NO_DATA, [])).toBe(NO_DATA);
  });

  it("summarizes the thread keeping what the person wrote whole", () => {
    // Performs the test.
    const long = "x".repeat(300);
    const summary = threadSummary([
      { role: "user", content: long },
      { role: "assistant", content: long },
    ]);

    // Performs assertions.
    expect(summary).toContain(`- persona: ${long}`);
    expect(summary).toContain(`- tú: ${"x".repeat(220)}…`);
    expect(threadSummary([])).toBeNull();
  });

  it("recognizes the feedback of a blocking Stop hook", () => {
    // Performs assertions.
    expect(isHookRejection([{ type: "text", text: "Stop hook feedback: AVISO" }])).toBe(true);
    expect(isHookRejection("¿y la ruta sur?")).toBe(false);
  });
});
