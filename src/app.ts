import Fastify, { type FastifyInstance } from "fastify";

/**
 * Builds the HTTP application without binding a port
 *
 * @return  The configured Fastify instance
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
