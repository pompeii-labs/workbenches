---
name: lux-jobs
description: "Use when work must happen outside a request or survive failures: sending email or webhooks, calling a flaky third-party API, retries with backoff, background workers, or queues."
---

# Background jobs on Lux

Lux speaks RESP, so queues live in the same engine as your tables. No Redis, no separate queue service, no cron sweepers, no in-memory retry loops: those are lost on restart.

## Connect over RESP

Workers use the direct protocol URL, not `LUX_URL`:

```sh
lux env export local      # LUX_DIRECT_URL=lux://:<secret>@localhost:6379
```

- `LUX_DIRECT_URL` carries the secret. Server/worker env only, never browser env or logs.
- Redis clients (ioredis, BullMQ) expect `redis://`: `url.replace(/^luxs:\/\//, "rediss://").replace(/^lux:\/\//, "redis://")`.
- Use `ioredis` for direct connections and table reads/writes via `createClient(LUX_URL, LUX_SECRET_KEY)` as usual.

## Jobs with retries: BullMQ on Lux

```ts
// queue.ts (imported by the API and the worker)
import { Queue } from "bullmq";
import IORedis, { type RedisOptions } from "ioredis";

const url = process.env.LUX_DIRECT_URL!.replace(/^luxs:\/\//, "rediss://").replace(/^lux:\/\//, "redis://");
export const createConnection = (options: RedisOptions = {}) => new IORedis(url, options);

export const webhooks = new Queue<{ eventId: string }>("webhooks", {
    connection: createConnection(),
    defaultJobOptions: {
        attempts: 12,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { age: 7 * 24 * 3600 },
        removeOnFail: false,          // keep failures so they can be inspected/retried
    },
});
```

```ts
// API: write the row, then enqueue. The row id as jobId makes enqueueing idempotent.
await webhooks.add("deliver", { eventId: row.id }, { jobId: row.id });
```

```ts
// worker.ts: its own process, started with a package script such as "worker": "bun run src/worker.ts"
import { Worker } from "bullmq";
const worker = new Worker("webhooks", async (job) => {
    // Load current state from Lux by id; skip if it no longer exists. Throw to retry.
}, { connection: createConnection({ maxRetriesPerRequest: null }), concurrency: 5 });
worker.on("failed", (job, error) => console.warn(job?.id, job?.attemptsMade, error.message));
process.on("SIGTERM", async () => { await worker.close(); process.exit(0); });
```

- Enqueue small ids and load current data in the worker, so edits/deletions made before the job runs are respected.
- Don't call the slow/unreliable service inside the request; respond once the row and job are written. Return an error (and undo the write) if enqueueing itself fails.
- Timing: delayed jobs fire within about a second; the first retry after a failure can start several seconds late; a job whose worker died mid-run is retried after its lock expires (`lockDuration`, 30s default). Close workers on SIGTERM so restarts don't leave stalled jobs.
- Add the worker's start command to the project's README/package.json scripts so it's discoverable.

## Simple event streams: raw commands

For fan-out or logs without retry policies, use streams directly with ioredis:

```ts
await redis.xgroup("CREATE", "events", "mailer", "$", "MKSTREAM");   // BUSYGROUP if it exists: ignore
await redis.xadd("events", "*", "event_id", id);
const batch = await redis.xreadgroup("GROUP", "mailer", consumer, "COUNT", 10, "BLOCK", 5000, "STREAMS", "events", ">");
await redis.xack("events", "mailer", entryId);
await redis.xautoclaim("events", "mailer", consumer, 60_000, "0-0", "COUNT", 10); // reclaim after a crash
```

Unacknowledged entries stay pending (`XPENDING`), so a crashed consumer loses nothing. Streams give no backoff/attempt limits; use BullMQ when you need retries.

## Where queue bugs actually show up

Invisible on the happy path. They appear when the external dependency fails, or a process restarts mid-job: work vanishes, or runs twice. Those two conditions are what separate a durable queue from an in-memory one, so test both.
