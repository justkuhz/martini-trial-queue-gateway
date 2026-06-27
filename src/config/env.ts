const DEFAULT_PORT = 3000;
const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/martini_queue";
const DEFAULT_REDIS_URL = "redis://localhost:6379";
const DEFAULT_QUEUE_NAME = "model-requests";

function parsePort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_PORT;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_PORT;
  }

  return parsed;
}

export const env = {
  port: parsePort(process.env.PORT),
  baseUrl: process.env.BASE_URL ?? DEFAULT_BASE_URL,
  databaseUrl: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  redisUrl: process.env.REDIS_URL ?? DEFAULT_REDIS_URL,
  queueName: process.env.QUEUE_NAME ?? DEFAULT_QUEUE_NAME,
};
