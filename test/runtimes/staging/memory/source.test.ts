import { describe, expect, test } from 'bun:test';

import { E2BPathPlan } from '../../../../src/runtimes/e2b/paths.js';
import { MemoryAssetSource } from '../../../../src/runtimes/staging/memory/source.js';
import { TransferRules } from '../../../../src/runtimes/staging/rules.js';
import type { ResolvedWorkbench } from '../../../../src/types.js';

describe('memory source stat', () => {
    test('follows a symlinked workspace root through path verification', async () => {
        const source = new MemoryAssetSource()
            .file('/virtual/real/readme.md', 'hello')
            .link('/virtual/ws', '/virtual/real');
        expect((await source.stat('/virtual/ws'))?.kind).toBe('directory');
        expect((await source.lstat('/virtual/ws'))?.kind).toBe('symlink');
        const workbench = {
            manifestPath: '/virtual/pkg/workbench.yml',
            packageDirectory: '/virtual/pkg',
            repositoryDirectory: '/virtual/ws',
            instructionsPath: '/virtual/pkg/instructions.md',
            skills: [],
            manifest: { runner: 'opencode', env: {} },
        } as unknown as ResolvedWorkbench;
        source.directory('/virtual/pkg');
        const plan = new E2BPathPlan(
            {
                workbench,
                workspaceDirectory: '/virtual/ws',
                environment: {},
                assets: [
                    { path: '/virtual/ws', access: 'read-write' },
                    { path: '/virtual/pkg', access: 'read-only' },
                ],
            },
            new TransferRules('E2B')
        );
        await expect(plan.verify(source)).resolves.toBeUndefined();
    });

    test('follows relative link chains and stops at a cycle', async () => {
        const source = new MemoryAssetSource()
            .file('/virtual/a/target.txt', 'x')
            .link('/virtual/b/one', '../a/target.txt')
            .link('/virtual/b/two', 'one')
            .link('/virtual/b/loop', 'loop2')
            .link('/virtual/b/loop2', 'loop');
        expect((await source.stat('/virtual/b/two'))?.kind).toBe('file');
        expect(await source.stat('/virtual/b/loop')).toBeUndefined();
        expect(await source.stat('/virtual/missing')).toBeUndefined();
    });
});
