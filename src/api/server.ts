import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { env } from "../config/env";
import { queueRoutes } from "./routes/queue";

export const serverConfig = {
  host: "0.0.0.0",
  port: env.port,
  baseUrl: env.baseUrl,
} as const;

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({
    ok: true,
    base_url: env.baseUrl,
  }));

  app.register(queueRoutes);
  return app;
}

async function start(): Promise<void> {
  const app = buildServer();
  await app.listen({
    host: serverConfig.host,
    port: serverConfig.port,
  });
}

if (require.main === module) {
  start().catch((error: unknown) => {
    // Keep startup failures visible in local development.
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}

