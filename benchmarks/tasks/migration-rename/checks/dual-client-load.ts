// Drives two SQL clients directly against the users table: an "old" client
// that only knows the fullname column, and a "new" client that only knows
// display_name. Used to check that a rename does not break either version
// mid-rollout, and that a write through one name is visible through the
// other. Reports on SIGTERM (or after a max duration).
import { Client } from "pg";
import { writeFileSync } from "node:fs";

function arg(name: string, fallback?: string) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}
const out = arg("out")!;
const maxSeconds = Number(arg("max-seconds", "60"));
const mode = arg("mode", "both")!; // old | new | both

const url = process.env.DATABASE_URL ?? "postgres://app:app@localhost:5432/app";
const oldClient = new Client({ connectionString: url, statement_timeout: 5000 });
const newClient = new Client({ connectionString: url, statement_timeout: 5000 });

let attempts = 0;
let errors = 0;
let crossVisibilityFailures = 0;
const sample: string[] = [];
let stopped = false;

function flush() {
    if (stopped) return;
    stopped = true;
    writeFileSync(
        out,
        JSON.stringify({ attempts, errors, crossVisibilityFailures, sample: sample.slice(0, 5) }, null, 2)
    );
}
process.on("SIGTERM", () => flush() /* keep running until main loop notices */);
process.on("SIGINT", () => flush());

async function oldRound(n: number) {
    const mark = `Old-${n}`;
    const email = `old-${n}-${Date.now()}@example.com`;
    try {
        const r = await oldClient.query(
            "INSERT INTO users (fullname, email) VALUES ($1, $2) RETURNING id",
            [mark, email]
        );
        const id = r.rows[0].id;
        const back = await oldClient.query("SELECT fullname FROM users WHERE id = $1", [id]);
        if (back.rows[0]?.fullname !== mark) {
            errors++;
            sample.push(`old write not visible via fullname for id=${id}`);
            return;
        }
        if (mode === "both") {
            const viaNew = await newClient.query("SELECT display_name FROM users WHERE id = $1", [id]);
            if (viaNew.rows[0]?.display_name !== mark) {
                crossVisibilityFailures++;
                sample.push(`old write (${mark}) not visible via display_name for id=${id}: got ${viaNew.rows[0]?.display_name}`);
            }
        }
    } catch (err: any) {
        errors++;
        sample.push(`old client error: ${err?.message ?? err}`);
    }
}

async function newRound(n: number) {
    const mark = `New-${n}`;
    const email = `new-${n}-${Date.now()}@example.com`;
    try {
        const r = await newClient.query(
            "INSERT INTO users (display_name, email) VALUES ($1, $2) RETURNING id",
            [mark, email]
        );
        const id = r.rows[0].id;
        const back = await newClient.query("SELECT display_name FROM users WHERE id = $1", [id]);
        if (back.rows[0]?.display_name !== mark) {
            errors++;
            sample.push(`new write not visible via display_name for id=${id}`);
            return;
        }
        if (mode === "both") {
            const viaOld = await oldClient.query("SELECT fullname FROM users WHERE id = $1", [id]);
            if (viaOld.rows[0]?.fullname !== mark) {
                crossVisibilityFailures++;
                sample.push(`new write (${mark}) not visible via fullname for id=${id}: got ${viaOld.rows[0]?.fullname}`);
            }
        }
    } catch (err: any) {
        errors++;
        sample.push(`new client error: ${err?.message ?? err}`);
    }
}

async function main() {
    if (mode !== "new") await oldClient.connect();
    if (mode !== "old") await newClient.connect();
    const deadline = performance.now() + maxSeconds * 1000;
    let n = 0;
    while (!stopped && performance.now() < deadline) {
        n++;
        const rounds: Promise<void>[] = [];
        if (mode !== "new") {
            attempts += 1;
            rounds.push(oldRound(n));
        }
        if (mode !== "old") {
            attempts += 1;
            rounds.push(newRound(n));
        }
        await Promise.all(rounds);
    }
    flush();
    await oldClient.end().catch(() => {});
    await newClient.end().catch(() => {});
}
main();
