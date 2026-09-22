import { Pool, type QueryResultRow } from 'pg';

const pool = new Pool({
    connectionString:
        process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/app',
    max: 10,
});

export function query<T extends QueryResultRow = any>(text: string, params?: any[]) {
    return pool.query<T>(text, params);
}

export { pool };
