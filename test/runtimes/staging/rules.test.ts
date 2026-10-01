import { describe, expect, test } from 'bun:test';

import { TransferRules } from '../../../src/runtimes/staging/rules.js';

const rules = new TransferRules('E2B');

describe('transfer rules', () => {
    test('normalizes archive paths and tests nested assets', () => {
        expect(rules.normalizeArchivePath('./src/app.ts')).toBe('src/app.ts');
        expect(rules.normalizeArchivePath('src/./lib/./app.ts')).toBe('src/lib/app.ts');
        expect(rules.normalizeArchivePath('./dir/')).toBe('dir/');
        expect(rules.excludedByNestedAsset('pkg/a.ts', ['pkg'])).toBeTrue();
        expect(rules.excludedByNestedAsset('pkgs/a.ts', ['pkg'])).toBeFalse();
    });

    test('contains treats a path as inside itself and its descendants only', () => {
        expect(rules.contains('/ws', '/ws')).toBeTrue();
        expect(rules.contains('/ws', '/ws/src/a.ts')).toBeTrue();
        expect(rules.contains('/ws', '/ws-other')).toBeFalse();
        expect(rules.contains('/ws/src', '/ws')).toBeFalse();
    });

    test('names the provider when it refuses a path', () => {
        for (const unsafe of [
            '',
            '.',
            '/etc/passwd',
            '../out',
            'a//b',
            'a/../b',
            'a/./b',
        ]) {
            expect(() => rules.validateRelativePath(unsafe)).toThrow(
                `Unsafe E2B archive path: ${unsafe}`
            );
        }
        expect(() => rules.validateRelativePath('src/app.ts')).not.toThrow();
    });

    test('refuses absolute and escaping links', () => {
        expect(() =>
            rules.validateSymlink({
                parent: '/ws',
                link: '/etc/passwd',
                displayPath: '/ws/link',
            })
        ).toThrow('Absolute symlink is not allowed in E2B transfer: /ws/link');
        expect(() =>
            rules.validateSymlink({
                parent: '/ws/src',
                link: '../../out',
                displayPath: '/ws/src/link',
                root: '/ws',
            })
        ).toThrow('Escaping symlink is not allowed in E2B transfer: /ws/src/link');
        expect(() =>
            rules.validateSymlink({
                parent: '/ws/src',
                link: '../lib',
                displayPath: '/ws/src/link',
                root: '/ws',
            })
        ).not.toThrow();
    });
});
