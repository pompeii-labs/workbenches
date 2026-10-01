import { describe, expect, test } from 'bun:test';

import { WorkspaceProtection } from '../../../src/runtimes/staging/protection.js';

const protection = new WorkspaceProtection();
const bytes = (text: string) => new TextEncoder().encode(text);

describe('workspace protection', () => {
    test('keeps credentials, version control, and dependency trees on the host', () => {
        for (const path of [
            '.git/config',
            'a/.ssh/id_rsa',
            'node_modules/dep/index.js',
            '.env',
            '.env.local',
            'deploy/key.pem',
            'credentials',
            'runtime.secrets.json',
            '.workbench-state/current.json',
            '.npmrc',
        ]) {
            expect(protection.protectedWorkspacePath(path)).toBeTrue();
        }
        for (const path of ['src/app.ts', '.env.example', '.env.sample', 'README.md']) {
            expect(protection.protectedWorkspacePath(path)).toBeFalse();
        }
    });

    test('recognizes project npm config apart from user config', () => {
        expect(protection.projectNpmrcPath('.npmrc')).toBeTrue();
        expect(protection.projectNpmrcPath('packages/app/.npmrc')).toBeTrue();
        expect(protection.projectNpmrcPath('.git/.npmrc')).toBeFalse();
        expect(protection.projectNpmrcPath('src/app.ts')).toBeFalse();
    });

    test('lets only known boolean npm settings cross', () => {
        expect(protection.safeProjectNpmrc(bytes(''))).toBeTrue();
        expect(
            protection.safeProjectNpmrc(bytes('engine-strict=true\nfund = false\n'))
        ).toBeTrue();
        for (const unsafe of [
            '//registry.npmjs.org/:_authToken=abc',
            'registry=https://example.com',
            'engine-strict=yes',
            'unknown-setting=true',
            'save-exact=$VALUE',
        ]) {
            expect(protection.safeProjectNpmrc(bytes(unsafe))).toBeFalse();
        }
        expect(protection.safeProjectNpmrc(new Uint8Array([0xff, 0xfe]))).toBeFalse();
        expect(
            protection.safeProjectNpmrc(bytes('fund=true\n'.repeat(8_000)))
        ).toBeFalse();
    });
});
