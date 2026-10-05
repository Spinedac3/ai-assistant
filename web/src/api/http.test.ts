import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./http";
import { getSession, setSession } from "./session";

const user = {
  id: 1,
  email: "ana@example.com",
  displayName: "Ana",
  role: "user",
  scopes: ["chat.use"],
};

/**
 * Makes fetch answer once with a JSON body
 *
 * @param   status   Status code
 * @param   body     Body
 * @param   headers  Headers
 *
 * @return  The mock, to read what was sent
 */
function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  const mock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers }),
  );
  vi.stubGlobal("fetch", mock);

  return mock;
}

describe("api client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setSession(null);
  });

  it("sends the session, keeps the token the server renews and returns the data", async () => {
    // Performs the test.
    setSession({ token: "viejo", user });
    const sent = answer(200, { ok: true, data: { n: 1 } }, { "x-renewed-token": "nuevo" });
    const data = await api<{ n: number }>("/chat/conversations", {
      method: "POST",
      body: { a: 1 },
    });
    const init = sent.mock.calls[0]?.[1] ?? {};

    // Performs assertions.
    expect(data).toEqual({ n: 1 });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer viejo");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe('{"a":1}');
    expect(getSession()?.token).toBe("nuevo");
    expect(JSON.parse(localStorage.getItem("assistant.session") ?? "{}").token).toBe("nuevo");
  });

  it("ends the session the server no longer accepts, and passes on its own message", async () => {
    // Performs the test.
    setSession({ token: "vencido", user });
    answer(401, { ok: false, error: "token_revoked", message: "La sesión terminó" });
    const failure = await api("/auth/me").catch((error: unknown) => error);

    // Performs assertions.
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 401,
      code: "token_revoked",
      message: "La sesión terminó",
    });
    expect(getSession()).toBeNull();
  });

  it("gives a plain message when the server sends nothing readable", async () => {
    // Performs the test.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 502 })),
    );
    const failure = await api("/docs").catch((error: unknown) => error);

    // Performs assertions.
    expect(failure).toMatchObject({ status: 502, code: "unknown" });
    expect((failure as Error).message).toContain("vuelve a intentarlo");
  });
});
