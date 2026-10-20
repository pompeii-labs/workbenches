import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { migrations } from '../../../src/database/migrations/index.js';

const folder = join(import.meta.dir, '..', '..', '..', 'src', 'database', 'migrations');

describe('migration files', () => {
    const files = readdirSync(folder)
        .filter((file) => file.endsWith('.sql'))
        .sort();

    test('are named NNNN_title.sql', () => {
        for (const file of files) expect(file).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    });

    test('are numbered from 1 without gaps or duplicates', () => {
        expect(files.map((file) => Number(file.slice(0, 4)))).toEqual(
            files.map((_, index) => index + 1)
        );
    });

    test('are all in the registry with the same text', () => {
        expect(
            migrations.map(
                (migration) =>
                    `${String(migration.version).padStart(4, '0')}_${migration.name}.sql`
            )
        ).toEqual(files);
        for (const migration of migrations) {
            const file = `${String(migration.version).padStart(4, '0')}_${migration.name}.sql`;
            expect(migration.sql).toBe(readFileSync(join(folder, file), 'utf8'));
        }
    });

    test('keep the shipped history', () => {
        expect(
            migrations.slice(0, 3).map(({ version, name }) => ({ version, name }))
        ).toEqual([
            { version: 1, name: 'initial' },
            { version: 2, name: 'projects' },
            { version: 3, name: 'run_task' },
        ]);
    });
});
