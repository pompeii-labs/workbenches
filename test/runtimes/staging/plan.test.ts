import { describe, expect, test } from 'bun:test';

import { TransferPlan } from '../../../src/runtimes/staging/plan.js';
import { TransferRules } from '../../../src/runtimes/staging/rules.js';
import { MemoryAssetSource } from './memory.js';

describe('transfer plan', () => {
    test('names the provider it was built for in its messages', async () => {
        const source = new MemoryAssetSource().link('/virtual/ws/out', '../secret');
        const plan = new TransferPlan(source, new TransferRules('Daytona'));
        await expect(
            plan.describeEntries('/virtual/ws', ['out'], '/virtual/ws')
        ).rejects.toThrow('Escaping symlink is not allowed in Daytona transfer');
        await expect(
            plan.describeEntries('/virtual/ws', ['../out'], '/virtual/ws')
        ).rejects.toThrow('Unsafe Daytona archive path');
    });

    test('walks a tree through the source and records protected paths', async () => {
        const source = new MemoryAssetSource()
            .file('/virtual/ws/src/app.ts', 'export {}')
            .file('/virtual/ws/.env', 'SECRET=1');
        const excluded: string[] = [];
        const paths = await new TransferPlan(source, new TransferRules('E2B')).walk(
            '/virtual/ws',
            {
                protectWorkspace: true,
                excludedPaths: excluded,
            }
        );
        expect(paths).toEqual(['src/app.ts']);
        expect(excluded).toEqual(['.env']);
    });
});
