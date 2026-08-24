import { describe, expect, test } from 'bun:test';
import packageMetadata from '../package.json' with { type: 'json' };
import { WORKBENCH_USER_AGENT } from '../src/user-agent.js';

describe('Workbench user agent', () => {
    test('uses the permanent product identifier and package version', () => {
        expect(WORKBENCH_USER_AGENT).toBe(`workbench/${packageMetadata.version}`);
    });
});
