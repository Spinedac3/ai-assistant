import { getSession, renewToken, setSession } from "./session";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

const FALLBACK = "Algo falló al hablar con el servidor; vuelve a intentarlo";

/**
 * Calls the server with the session: takes the token it renews, and ends the session when the
 * server no longer accepts it
 *
 * @param   path  Path of the API
 * @param   init  Request options
 *
 * @return  The raw response
 */
export async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const session = getSession();
  const headers = new Headers(init.headers);
  if (session) {
    headers.set("authorization", `Bearer ${session.token}`);
  }
  const response = await fetch(path, { ...init, headers });

  const renewed = response.headers.get("x-renewed-token");
  if (renewed) {
    renewToken(renewed);
  }
  if (response.status === 401 && session) {
    setSession(null);
  }

  return response;
}

/**
 * Calls a JSON endpoint and returns its data, or throws with the server's own message
 *
 * @param   path  Path of the API
 * @param   init  Request options; a plain object body is sent as JSON
 *
 * @return  The data of the answer
 *
 * @throws  ApiError
 */
export async function api<T>(
  path: string,
  init: Omit<RequestInit, "body"> & { body?: unknown } = {},
): Promise<T> {
  const { body, ...rest } = init;
  const json = body !== undefined && !(body instanceof FormData);
  const response = await request(path, {
    ...rest,
    headers: { ...(json ? { "content-type": "application/json" } : {}), ...rest.headers },
    body: json ? JSON.stringify(body) : (body as BodyInit | undefined),
  });
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    data?: T;
    error?: string;
    message?: string;
  } | null;

  if (!response.ok || !payload?.ok) {
    throw new ApiError(payload?.message ?? FALLBACK, response.status, payload?.error ?? "unknown");
  }

  return payload.data as T;
}
