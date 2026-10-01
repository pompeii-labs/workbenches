import { describe, expect, test } from 'bun:test';
import { arch } from 'node:os';

import { NodeHost } from '../../src/workbench/host.js';

describe('node host', () => {
    test('describes this machine each time it is asked', () => {
        const facts = new NodeHost().describe();
        expect(facts.arch).toBe(arch());
        expect(facts.cpus).toBeGreaterThan(0);
        expect(facts.memoryBytes).toBeGreaterThan(0);
        expect(['macos', 'linux', 'windows']).toContain(facts.os);
    });
});
