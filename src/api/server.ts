import "dotenv/config";

import Fastify, { type FastifyInstance } from "fastify";

import { env } from "../config/env";
import { checkDbConnectivity } from "../db/client";
import { checkQueueConnectivity } from "../queue/enqueue";
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

  app.get("/readyz", async (_request, reply) => {
    try {
      await Promise.all([checkDbConnectivity(), checkQueueConnectivity()]);
      return reply.send({
        ok: true,
        dependencies: {
          db: "up",
          queue: "up",
        },
      });
    } catch (error) {
      return reply.code(503).send({
        ok: false,
        error: error instanceof Error ? error.message : "Dependency check failed",
      });
    }
  });

  app.register(queueRoutes);
  return app;
}

async function start(): Promise<void> {
  const app = buildServer();
  // Fail fast at startup so runtime traffic never hits a half-ready service.
  await Promise.all([checkDbConnectivity(), checkQueueConnectivity()]);
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

