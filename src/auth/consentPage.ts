/**
 * Builds the headers of the consent page: no scripts, no frames, no caching
 *
 * @param   redirectUri  Validated client redirect
 *
 * @return  The headers
 */
export function consentHeaders(redirectUri: string): Record<string, string> {
  // Browsers apply form-action to the redirect that follows the post, so the client origin is
  // allowed too; it comes from a registered redirect, never from free input
  const clientOrigin = new URL(redirectUri).origin;

  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${clientOrigin}; frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

export interface ConsentRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  resource?: string;
  // Echo of the cookie set with the page; a cross-site post carries the field but not the cookie
  csrf: string;
}

/**
 * Escapes text for HTML content and attribute values
 *
 * @param   value  Untrusted text
 *
 * @return  The escaped text
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders the page where a person signs in and lets an MCP client act on their behalf
 *
 * @param   assistantName  Name shown to the person
 * @param   request        Validated authorization request
 * @param   error          Message after a failed attempt, if any
 *
 * @return  The HTML page
 */
export function consentPage(
  assistantName: string,
  request: ConsentRequest,
  error?: string,
): string {
  const hidden = Object.entries({
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    code_challenge: request.codeChallenge,
    state: request.state,
    resource: request.resource,
    csrf: request.csrf,
  })
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(String(value))}">`,
    )
    .join("\n      ");

  const host = new URL(request.redirectUri).host;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Conectar con ${escapeHtml(assistantName)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f5f5f4; color: #1c1917; margin: 0; }
    main { max-width: 26rem; margin: 3rem auto; background: #fff; padding: 2rem; border-radius: 0.75rem; }
    h1 { font-size: 1.25rem; margin-top: 0; }
    label { display: block; margin-top: 1rem; font-size: 0.9rem; }
    input[type=email], input[type=password] { width: 100%; padding: 0.6rem; margin-top: 0.3rem; box-sizing: border-box; }
    .actions { display: flex; flex-direction: row-reverse; gap: 0.75rem; margin-top: 1.5rem; }
    button { flex: 1; padding: 0.7rem; border-radius: 0.5rem; border: 1px solid #a8a29e; cursor: pointer; }
    button[value=approve] { background: #1c1917; color: #fff; }
    .error { color: #b91c1c; }
    .small { color: #57534e; font-size: 0.85rem; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(request.clientName)} quiere usar ${escapeHtml(assistantName)} en tu nombre</h1>
    <p class="small">Podrá consultar con tus mismos permisos. Volverás a <strong>${escapeHtml(host)}</strong>.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label>Correo <input type="email" name="email" autocomplete="username"></label>
      <label>Contraseña <input type="password" name="password" autocomplete="current-password"></label>
      <div class="actions">
        <button type="submit" name="decision" value="approve">Permitir</button>
        <button type="submit" name="decision" value="deny">Rechazar</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}
