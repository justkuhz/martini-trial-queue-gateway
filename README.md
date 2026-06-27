# Project Notes

Selected implementation stack (short decision note):

```txt
Language: TypeScript
HTTP: Fastify
Queue: BullMQ (Redis)
DB: Postgres
ORM: Drizzle (leaner/faster than Prisma for this scope)
Infra: Docker Compose
```

Local base URL configuration for the trial:

```txt
BASE_URL=http://localhost:3000
PORT=3000
```

Bootstrap run commands:

```bash
cp .env.example .env
docker compose up -d
npm run db:generate
npm run db:migrate
npm run dev:api
npm run dev:worker
```

What each command does:

- `cp .env.example .env`: creates your local env file from the template.
- `docker compose up -d`: MAKE SURE DOCKER DAEMON IS RUNNING. starts Postgres and Redis in the background.
- `npm run db:generate`: generates Drizzle migration files from current schema definitions.
- `npm run db:migrate`: applies generated migrations to Postgres.
- `npm run dev:api`: starts the Fastify API server in watch mode.
- `npm run dev:worker`: starts the BullMQ worker in watch mode.

Data models:

- `requests`: one row per `request_id`; stores model id, input/output payloads, public status (`IN_QUEUE | IN_PROGRESS | COMPLETED`), internal status (`queued | running | succeeded | failed | timeout | cancelled`), cancellation flag, metrics, and lifecycle timestamps.
- `request_logs`: append-only logs per request used by the status endpoint when `?logs=1` is provided.
- `request_attempts`: one row per execution attempt; stores `gateway_request_id`, attempt number, attempt status, and error details for retry/debug visibility.
- `error_type` and status enums are normalized in schema to keep worker transitions and API behavior consistent.
- `expires_at` is stored on completed requests for future retention cleanup jobs.
