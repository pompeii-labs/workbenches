import { describe, expect, test } from 'bun:test';

import {
    managedMetadata,
    runLabels,
    runMetadata,
    scopeMetadata,
} from '../../../src/runtimes/remote/labels.js';

const run = { id: `wb_${'a'.repeat(32)}`, scope: 'b'.repeat(24) };

describe('runLabels', () => {
    test('labels a sandbox with its run and scope', () => {
        expect(runLabels(run, 'Remote')).toEqual({
            [managedMetadata]: 'true',
            [runMetadata]: run.id,
            [scopeMetadata]: run.scope,
        });
    });

    test('names the provider when the run or scope is malformed', () => {
        expect(() => runLabels({ ...run, id: 'run' }, 'Remote')).toThrow(
            'Invalid Workbench run ID for Remote: run'
        );
        expect(() => runLabels({ ...run, scope: 'x' }, 'Remote')).toThrow(
            'Invalid Workbench Remote scope: x'
        );
    });
});
