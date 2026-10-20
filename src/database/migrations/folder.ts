import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Migration } from './index.js';

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/**
 * Reads every `NNNN_name.sql` file beside this module in version order. It runs
 * as a Bun macro at transpile time, so the source tree, the test suite, and the
 * compiled binary embed the same list. A misnamed file or a numbering that is
 * not exactly 1..n fails the build instead of shipping a broken history.
 */
export function readMigrationFolder(): Migration[] {
    const folder = import.meta.dir;
    const files = readdirSync(folder)
        .filter((file) => file.endsWith('.sql'))
        .sort();
    return files.map((file, index) => {
        const match = FILE_NAME.exec(file);
        const digits = match?.[1];
        const name = match?.[2];
        if (digits === undefined || name === undefined) {
            refuse(
                `Migration ${file} must be named NNNN_name.sql with a four digit number and a lowercase snake case name`
            );
        }
        const version = Number(digits);
        if (version < index + 1) {
            refuse(
                `Migration ${file} repeats version ${version}; numbers must run from 1 without gaps or repeats`
            );
        }
        if (version > index + 1) {
            refuse(
                `Migration ${file} skips version ${index + 1}; numbers must run from 1 without gaps or repeats`
            );
        }
        return { version, name, sql: readFileSync(join(folder, file), 'utf8') };
    });
}

function refuse(message: string): never {
    // Bun replaces an error thrown from a macro with a generic coercion error,
    // so the reason is written out before the build is stopped.
    console.error(`error: ${message}`);
    throw new Error(message);
}
