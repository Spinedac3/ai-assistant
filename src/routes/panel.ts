import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface PanelRoutesOptions {
  // Folder of the built panel
  dir: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// Everything the panel loads is its own; styles are inline because the component library injects
// them at runtime
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

/**
 * Reads a file of the panel when the path stays inside its folder
 *
 * @param   root      Folder of the panel
 * @param   relative  Path asked for
 *
 * @return  The file, or null when there is none
 */
async function fileOf(root: string, relative: string): Promise<Buffer | null> {
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep)) {
    return null;
  }
  try {
    return (await stat(path)).isFile() ? await readFile(path) : null;
  } catch {
    return null;
  }
}

/**
 * Registers the web panel under /panel: its files, and its page for any route of its own
 *
 * @param   app      Fastify instance
 * @param   options  Folder of the build
 */
export default async function panelRoutes(
  app: FastifyInstance,
  options: PanelRoutesOptions,
): Promise<void> {
  const root = resolve(options.dir);

  const page = async (reply: FastifyReply) => {
    const index = await fileOf(root, "index.html");
    if (!index) {
      return reply
        .code(404)
        .headers(SECURITY_HEADERS)
        .type("text/plain; charset=utf-8")
        .send("El panel no está construido");
    }
    // Always the newest page, which names the files of the newest build
    return reply
      .headers({ ...SECURITY_HEADERS, "Cache-Control": "no-store" })
      .type("text/html; charset=utf-8")
      .send(index);
  };

  app.get("/panel", async (_request, reply) => reply.redirect("/panel/"));

  app.get("/panel/*", async (request, reply) => {
    const relative = (request.params as { "*": string })["*"];
    const file = relative ? await fileOf(root, relative) : null;
    if (file) {
      // Built files carry their hash in the name, so they never change
      const immutable = relative.startsWith("assets/");
      return reply
        .headers({
          ...SECURITY_HEADERS,
          "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        })
        .type(TYPES[extname(relative).toLowerCase()] ?? "application/octet-stream")
        .send(file);
    }
    // A missing file is a 404; any other path is a route of the panel itself
    if (extname(relative) !== "") {
      return reply.code(404).headers(SECURITY_HEADERS).send({ ok: false, error: "not_found" });
    }

    return page(reply);
  });
}
