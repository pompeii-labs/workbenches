// Generic concurrent write load generator used by gates to measure write
// availability while a migration runs. Hammers INSERT statements against a
// target table and reports, on SIGTERM (or after a max duration), the number
// of attempts, failures, and the longest gap between two successful writes
// (the write "stall").
//
// Usage: bun run write-load.ts --sql "INSERT INTO orders (user_id, amount_cents) VALUES (1, 100)" --out /path/result.json [--max-seconds 60]
import { Client } from "pg";
import { writeFileSync } from "node:fs";

function arg(name: string, fallback?: string) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const sql = arg("sql");
const out = arg("out");
const maxSeconds = Number(arg("max-seconds", "120"));
if (!sql || !out) {
    console.error("usage: write-load.ts --sql <insert> --out <path> [--max-seconds N]");
    process.exit(2);
}

const client = new Client({
    connectionString: process.env.DATABASE_URL ?? "postgres://app:app@localhost:5432/app",
    statement_timeout: 5000,
});

let attempts = 0;
let failures = 0;
let lastSuccessAt = performance.now();
let maxGapMs = 0;
const errors: string[] = [];
let stopped = false;

function summarize() {
    return {
        attempts,
        failures,
        maxGapMs: Math.round(maxGapMs),
        errors: errors.slice(0, 5),
    };
}

function flush() {
    if (stopped) return;
    stopped = true;
    writeFileSync(out!, JSON.stringify(summarize(), null, 2));
}

process.on("SIGTERM", () => {
    flush();
    process.exit(0);
});
process.on("SIGINT", () => {
    flush();
    process.exit(0);
});

async function main() {
    await client.connect();
    const deadline = performance.now() + maxSeconds * 1000;
    while (!stopped && performance.now() < deadline) {
        attempts++;
        try {
            await client.query(sql!);
            const now = performance.now();
            const gap = now - lastSuccessAt;
            if (gap > maxGapMs) maxGapMs = gap;
            lastSuccessAt = now;
        } catch (err: any) {
            failures++;
            if (errors.length < 5) errors.push(String(err?.message ?? err));
        }
    }
    flush();
    await client.end().catch(() => {});
}

main();
