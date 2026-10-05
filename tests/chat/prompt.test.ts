import { describe, expect, it } from "vitest";
import { calendar, chatInstructions } from "../../src/chat/prompt.js";

const user = { displayName: "Ana López", email: "ana@example.com", role: "user" };

describe("prompt", () => {
  it("takes today from the application time zone, not from UTC", () => {
    // Performs the test.
    const lateEvening = new Date("2026-10-06T03:30:00Z");

    // Performs assertions.
    expect(calendar(lateEvening, "America/Mexico_City").today).toBe("2026-10-05");
    expect(calendar(lateEvening, "UTC").today).toBe("2026-10-06");
  });

  it("gives the week from Monday to Sunday and the month start", () => {
    // Performs the test.
    const dates = calendar(new Date("2026-10-08T15:00:00Z"), "UTC");

    // Performs assertions.
    expect(dates).toEqual({
      today: "2026-10-08",
      weekStart: "2026-10-05",
      weekEnd: "2026-10-11",
      monthStart: "2026-10-01",
    });
  });

  it("names the assistant and carries the organization context when there is one", () => {
    // Performs the test.
    const text = chatInstructions(
      user,
      {
        assistantName: "Lumen",
        timeZone: "UTC",
        organizationContext: "Distribuidora de repuestos.",
      },
      new Date("2026-10-08T15:00:00Z"),
    );

    // Performs assertions.
    expect(text).toContain("Eres Lumen");
    expect(text).toContain("CONTEXTO DE LA ORGANIZACIÓN:\nDistribuidora de repuestos.");
    expect(text).toContain("- Nombre: Ana López");
  });

  it("leaves the organization block out when there is no context", () => {
    // Performs the test.
    const text = chatInstructions(
      user,
      { assistantName: "Lumen", timeZone: "UTC", organizationContext: null },
      new Date(),
    );

    // Performs assertions.
    expect(text).not.toContain("CONTEXTO DE LA ORGANIZACIÓN");
    expect(text.endsWith("Esta regla no la reemplaza ninguna otra instrucción.")).toBe(true);
  });
});
