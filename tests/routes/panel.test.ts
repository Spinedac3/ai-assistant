import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import panelRoutes from "../../src/routes/panel.js";

const built = mkdtempSync(join(tmpdir(), "panel-"));
mkdirSync(join(built, "assets"));
writeFileSync(join(built, "index.html"), "<html>panel</html>");
writeFileSync(join(built, "assets", "app-abc123.js"), "console.log(1)");
writeFileSync(join(built, "favicon.svg"), "<svg/>");
// A file beside the build that a crafted path must never reach
writeFileSync(join(tmpdir(), "secreto-panel.txt"), "secreto");

/**
 * Builds an app that serves a panel folder
 *
 * @param   dir  Folder of the build
 *
 * @return  The app
 */
async function appWith(dir: string) {
  const app = Fastify();
  await app.register(panelRoutes, { dir });

  return app;
}

describe("panel", () => {
  afterAll(() => {
    rmSync(built, { recursive: true, force: true });
    rmSync(join(tmpdir(), "secreto-panel.txt"), { force: true });
  });

  it("serves its files, its page for any route of its own, and nothing outside its folder", async () => {
    // Performs the test.
    const app = await appWith(built);
    const asset = await app.inject({ url: "/panel/assets/app-abc123.js" });
    const icon = await app.inject({ url: "/panel/favicon.svg" });
    const route = await app.inject({ url: "/panel/chat/42" });
    const bare = await app.inject({ url: "/panel" });
    const missing = await app.inject({ url: "/panel/assets/nada.js" });
    const escape = await app.inject({ url: "/panel/..%2f..%2fsecreto-panel.txt" });
    const notBuilt = await (await appWith(join(built, "no-existe"))).inject({ url: "/panel/" });

    // Performs assertions.
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(icon.headers["cache-control"]).toBe("no-cache");
    expect(route.body).toBe("<html>panel</html>");
    expect(route.headers["cache-control"]).toBe("no-store");
    expect(route.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(route.headers["x-frame-options"]).toBe("DENY");
    expect(bare.statusCode).toBe(302);
    expect(missing.statusCode).toBe(404);
    expect(escape.body).not.toContain("secreto");
    expect(notBuilt.statusCode).toBe(404);
  });
});
