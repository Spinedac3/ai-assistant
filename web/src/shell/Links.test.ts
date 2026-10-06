import { describe, expect, it } from "vitest";
import { isPanelExport } from "./Links";

describe("links", () => {
  it("downloads with the session only the panel's own unsigned Excel links", () => {
    // Performs the test.
    const at = (href: string) => isPanelExport(new URL(href, window.location.href));
    const id = "af061476-2cbf-432b-92fa-0e0f5a246f6f";

    // Performs assertions.
    expect(at(`/exports/${id}`)).toBe(true);
    expect(at(`/exports/${id}?exp=1&sig=abc`)).toBe(false);
    expect(at(`https://otro.example.com/exports/${id}`)).toBe(false);
    expect(at(`/exports/${id}/preview`)).toBe(false);
    expect(at("/exports/../admin")).toBe(false);
  });
});
