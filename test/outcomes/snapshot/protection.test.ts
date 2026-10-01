import { describe, expect, test } from 'bun:test';

import { SnapshotProtection } from '../../../src/outcomes/snapshot/protection.js';

const protection = new SnapshotProtection();

describe('snapshot protection', () => {
    test('keeps version control, credentials, keys, and dependency trees out of changes', () => {
        for (const path of [
            '.git/config',
            'a/.ssh/id_rsa',
            'node_modules/dep/index.js',
            '.env',
            '.env.local',
            'deploy/key.PEM',
            'credentials',
            '.npmrc',
        ]) {
            expect(protection.isProtected(path)).toBeTrue();
        }
    });

    test('lets ordinary files and example environment files through', () => {
        for (const path of [
            'src/app.ts',
            '.env.example',
            '.env.sample',
            'README.md',
            '.workbench/note.txt',
        ]) {
            expect(protection.isProtected(path)).toBeFalse();
        }
    });
});
