// Fixed copy of the fixture's original scripts/seed.ts, used by gates to seed
// the BASELINE schema before the submitted migration runs. Gates must never
// depend on scripts/seed.ts from the project directory, because the
// submission under test is free to edit that file (for example, to insert a
// column added by its own migration), which would make baseline seeding fail
// against the schema that still lacks that column. This copy is fixed and
// never overlaid by a submission.
//
// It lives outside the project; gates copy it in (like write-load.ts and
// measure-db-latency.ts) so bun resolves the project's own `pg` dependency.
import { Client } from 'pg';

const USERS = Number(process.env.SEED_USERS ?? 50_000);
const ORDERS = Number(process.env.SEED_ORDERS ?? 10_000_000);
const EVENTS = Number(process.env.SEED_EVENTS ?? 10_000_000);

async function main() {
    const client = new Client({
        connectionString:
            process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app',
    });
    await client.connect();

    const started = performance.now();

    await client.query(
        `INSERT INTO users (fullname, email)
         SELECT 'User ' || g, 'user' || g || '@example.com'
         FROM generate_series(1, $1) AS g`,
        [USERS]
    );

    await client.query(
        `INSERT INTO orders (user_id, amount_cents, created_at)
         SELECT (random() * ($1 - 1) + 1)::int, (random() * 20000)::int + 100,
                now() - (random() * interval '365 days')
         FROM generate_series(1, $2) AS g`,
        [USERS, ORDERS]
    );

    await client.query(
        `INSERT INTO events (user_id, kind, created_at)
         SELECT (random() * ($1 - 1) + 1)::int,
                (ARRAY['login','logout','purchase','view'])[floor(random() * 4 + 1)],
                now() - (random() * interval '365 days')
         FROM generate_series(1, $2) AS g`,
        [USERS, EVENTS]
    );

    await client.query('ANALYZE users, orders, events');

    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
        `seed: ${USERS} users, ${ORDERS} orders, ${EVENTS} events in ${seconds}s`
    );

    await client.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
