import { describe, expect, test } from 'bun:test';
import { isOutboxPermission } from '../src/runners/opencode/outbox-permission.js';

describe('OpenCode engine-owned outbox permissions', () => {
    test('allows only directory scopes within the selected outbox', () => {
        for (const outbox of ['/outbox', '/private/workbench/runs/wb_example/outbox']) {
            expect(
                isOutboxPermission('external_directory', [`${outbox}/*`], outbox)
            ).toBe(true);
            expect(
                isOutboxPermission(
                    'external_directory',
                    [`${outbox}/reports/*`, `${outbox}/images/*`],
                    outbox
                )
            ).toBe(true);
        }
    });

    test('does not grant unrelated actions, parent paths, mixed scopes, or ambiguous patterns', () => {
        for (const resources of [
            [],
            ['/outbox'],
            ['/*'],
            ['/outbox-other/*'],
            ['/outbox/../secrets/*'],
            ['/outbox/nested/../../secrets/*'],
            ['outbox/*'],
            ['/outbox/**'],
            ['/outbox/reports?/*'],
            ['/outbox\\..\\secrets/*'],
            ['/outbox/\0/*'],
            ['/outbox/*', '/secrets/*'],
        ]) {
            expect(
                isOutboxPermission('external_directory', resources, '/outbox'),
                JSON.stringify(resources)
            ).toBe(false);
        }
        expect(isOutboxPermission('edit', ['/outbox/*'], '/outbox')).toBe(false);
        expect(isOutboxPermission('bash', ['/outbox/*'], '/outbox')).toBe(false);
        for (const outbox of [undefined, '', '/', 'outbox', '/outbox*', '/outbox?']) {
            expect(
                isOutboxPermission('external_directory', ['/outbox/*'], outbox)
            ).toBe(false);
        }
    });
});
