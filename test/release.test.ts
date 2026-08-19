import { describe, expect, test } from 'bun:test';

import { resolveReleaseTarget, verifyReleaseTag } from '../scripts/release-support.js';

describe('release contract', () => {
    test('maps every supported native build target to a stable artifact name', () => {
        expect(resolveReleaseTarget('darwin', 'arm64').name).toBe(
            'workbench-darwin-arm64'
        );
        expect(resolveReleaseTarget('darwin', 'x64').name).toBe('workbench-darwin-x64');
        expect(resolveReleaseTarget('linux', 'arm64').name).toBe(
            'workbench-linux-arm64'
        );
        expect(resolveReleaseTarget('linux', 'x64').name).toBe('workbench-linux-x64');
    });

    test('rejects unsupported operating systems and architectures', () => {
        expect(() => resolveReleaseTarget('win32', 'x64')).toThrow(
            'Unsupported release operating system'
        );
        expect(() => resolveReleaseTarget('linux', 'ia32')).toThrow(
            'Unsupported release architecture'
        );
    });

    test('requires an exact non-development package version tag', () => {
        expect(() => verifyReleaseTag('v0.1.0-alpha.1', '0.1.0-alpha.1')).not.toThrow();
        expect(() => verifyReleaseTag('v0.1.0', '0.1.1')).toThrow(
            'does not match package version'
        );
        expect(() => verifyReleaseTag('v0.0.0', '0.0.0')).toThrow(
            'development-only version'
        );
    });
});
