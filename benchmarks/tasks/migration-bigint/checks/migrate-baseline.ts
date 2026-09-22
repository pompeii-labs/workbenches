// Fixed copy of the fixture's original scripts/migrate.ts, used by gates to
// apply ONLY the baseline migration (0001_init.sql) before the submitted
// migration runs. Gates must never depend on scripts/migrate.ts from the
// project directory for this step, because the submission under test is free
// to edit that file. This copy is fixed and never overlaid by a submission.
// The submitted migration itself is still applied with the project's own
// migrate.ts, since a submission may legitimately need to change how
// migrations run (for example, to allow CONCURRENTLY outside a transaction).
//
// It lives outside the project; gates copy it into the project's scripts/
// directory (like write-load.ts is copied into the project root) so bun
// resolves the project's own `pg` dependency, and so the relative
// `../migrations` lookup below still points at the project's migrations
// directory.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const dir = join(import.meta.dir, '..', 'migrations');

// Splits a SQL file into top-level statements on ';', respecting single-quoted
// strings and $tag$ dollar-quoted bodies (used by trigger functions).
function splitStatements(sql: string): string[] {
    const out: string[] = [];
    let cur = '';
    let i = 0;
    let inString = false;
    let dollarTag: string | null = null;
    while (i < sql.length) {
        const ch = sql[i];
        if (dollarTag) {
            if (sql.startsWith(dollarTag, i)) {
                cur += dollarTag;
                i += dollarTag.length;
                dollarTag = null;
                continue;
            }
            cur += ch;
            i++;
            continue;
        }
        if (inString) {
            cur += ch;
            if (ch === "'" && sql[i + 1] === "'") {
                cur += sql[i + 1];
                i += 2;
                continue;
            }
            if (ch === "'") inString = false;
            i++;
            continue;
        }
        const dollarMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
        if (dollarMatch) {
            dollarTag = dollarMatch[0];
            cur += dollarTag;
            i += dollarTag.length;
            continue;
        }
        if (ch === "'") {
            inString = true;
            cur += ch;
            i++;
            continue;
        }
        if (ch === ';') {
            const stmt = cur.trim();
            if (stmt) out.push(stmt);
            cur = '';
            i++;
            continue;
        }
        cur += ch;
        i++;
    }
    const rest = cur.trim();
    if (rest) out.push(rest);
    return out;
}

async function main() {
    const client = new Client({
        connectionString:
            process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app',
    });
    await client.connect();
    await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
    );
    const applied = new Set(
        (await client.query('SELECT name FROM schema_migrations')).rows.map(
            (r) => r.name
        )
    );
    const files = readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(join(dir, file), 'utf8');
        const statements = splitStatements(sql);
        console.log(`applying ${file} (${statements.length} statement(s))`);
        for (const stmt of statements) {
            const started = performance.now();
            await client.query(stmt);
            const ms = Math.round(performance.now() - started);
            console.log(`  [${ms}ms] ${stmt.split('\n')[0]!.slice(0, 80)}`);
        }
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
    await client.end();
    console.log('migrate: done');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
