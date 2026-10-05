/**
 * Builds the headers of the reset page: only its own script, no frames, no caching
 *
 * @param   nonce  Per-response value that lets the page's script run
 *
 * @return  The headers
 */
export function resetHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

/**
 * Escapes text for HTML content
 *
 * @param   value  Text
 *
 * @return  The escaped text
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Builds the page a reset link opens: it reads the token from the fragment, so the token never
 * reaches a server log, and posts it with the new password
 *
 * @param   assistantName  Name shown in the title
 * @param   nonce          Value the CSP allows for the script
 *
 * @return  The HTML
 */
export function resetPage(assistantName: string, nonce: string): string {
  const name = escapeHtml(assistantName);

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nueva contraseña · ${name}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 26rem; margin: 3rem auto; padding: 0 1rem; color: #1a202c; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input { width: 100%; padding: .6rem; margin-top: .3rem; box-sizing: border-box; border: 1px solid #cbd5e0; border-radius: .4rem; }
  button { margin-top: 1.5rem; padding: .7rem 1.2rem; border: 0; border-radius: .4rem; background: #2b6cb0; color: #fff; font-weight: 600; }
  #message { margin-top: 1rem; }
</style>
</head>
<body>
<h1>Nueva contraseña para ${name}</h1>
<form id="reset">
  <label for="password">Contraseña nueva</label>
  <input id="password" type="password" autocomplete="new-password" required minlength="12">
  <label for="repeat">Repítela</label>
  <input id="repeat" type="password" autocomplete="new-password" required>
  <button type="submit">Guardar</button>
</form>
<p id="message" role="status"></p>
<script nonce="${nonce}">
  const token = new URLSearchParams(location.hash.slice(1)).get("token") || "";
  history.replaceState(null, "", location.pathname);
  const form = document.getElementById("reset");
  const message = document.getElementById("message");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.getElementById("password").value;
    if (password !== document.getElementById("repeat").value) {
      message.textContent = "Las dos contraseñas no coinciden.";
      return;
    }
    const response = await fetch("/auth/password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const body = await response.json().catch(() => ({}));
    if (body.ok) {
      form.remove();
      message.textContent = "Listo. Ya puedes entrar con tu contraseña nueva.";
    } else {
      message.textContent = body.message || "No se pudo guardar; vuelve a intentarlo.";
    }
  });
</script>
</body>
</html>`;
}
