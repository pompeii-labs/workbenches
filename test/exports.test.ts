import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { WorkbenchEvent } from '@pompeii-labs/workbench/events';
import { WORKBENCH_EVENT_TYPES } from '@pompeii-labs/workbench/events';
import { WorkbenchManifestParser } from '@pompeii-labs/workbench/manifest';
import {
    ModelCatalog,
    ModelRouter,
    routeConfiguration,
} from '@pompeii-labs/workbench/models';
import { MemoryOutcomeStore, type OutcomeSink } from '@pompeii-labs/workbench/outcomes';
import { OutcomeStore } from '@pompeii-labs/workbench/outcomes/disk';
import { RequirementsPreflight } from '@pompeii-labs/workbench/requirements';
import type { RunnerFiles } from '@pompeii-labs/workbench/runners/files';
import { diskRunnerFiles } from '@pompeii-labs/workbench/runners/files/disk';
import { MemoryRunnerFiles } from '@pompeii-labs/workbench/runners/files/memory';
import { OpenCodeSessionAdapter } from '@pompeii-labs/workbench/runners/opencode/adapter';
import { OpenCodeEventAdapter } from '@pompeii-labs/workbench/runners/opencode/events';
import {
    OpenCodeRunner,
    PreparedOpenCodeRunner,
} from '@pompeii-labs/workbench/runners/opencode/runner';
import { OpenCodeServer } from '@pompeii-labs/workbench/runners/opencode/server';
import { OpenCodeServerSession } from '@pompeii-labs/workbench/runners/opencode/session';
import { stageOpenCodeSkillsWith } from '@pompeii-labs/workbench/runners/opencode/staging';
import { RuntimeRegistry } from '@pompeii-labs/workbench/runtimes';
import type { AssetSource } from '@pompeii-labs/workbench/runtimes/assets';
import { diskAssetSource } from '@pompeii-labs/workbench/runtimes/assets/disk';
import type { PreparedRuntime } from '@pompeii-labs/workbench/runtimes/contracts';
import {
    DaytonaApiClient,
    type DaytonaClient,
    DaytonaRuntimeProvider,
} from '@pompeii-labs/workbench/runtimes/daytona';
import { diskDaytonaDependencies } from '@pompeii-labs/workbench/runtimes/daytona/disk';
import { E2BRuntimeProvider, E2BSdkClient } from '@pompeii-labs/workbench/runtimes/e2b';
import type { E2BClient } from '@pompeii-labs/workbench/runtimes/e2b/contracts';
import {
    MemoryAssetSource,
    memoryTransfer,
    type RemoteTransfer,
} from '@pompeii-labs/workbench/runtimes/staging';
import { diskTransfer } from '@pompeii-labs/workbench/runtimes/staging/disk';
import type { ResolvedWorkbench } from '@pompeii-labs/workbench/types';

const root = join(import.meta.dir, '..');

describe('package exports', () => {
    test('loads the embeddable modules by subpath', () => {
        expect(WORKBENCH_EVENT_TYPES).toContain('run.started');
        expect(typeof WorkbenchManifestParser).toBe('function');
        expect(typeof RequirementsPreflight).toBe('function');
        expect(typeof OpenCodeSessionAdapter).toBe('function');
        expect(typeof OpenCodeEventAdapter).toBe('function');
        expect(typeof OpenCodeServer).toBe('function');
        expect(typeof OpenCodeServerSession).toBe('function');
        expect(typeof stageOpenCodeSkillsWith).toBe('function');
        expect(typeof RuntimeRegistry.standard).toBe('function');
        expect(typeof DaytonaRuntimeProvider).toBe('function');
        expect(typeof DaytonaApiClient).toBe('function');
        expect(typeof E2BRuntimeProvider).toBe('function');
        expect(typeof E2BSdkClient).toBe('function');
        expect(typeof diskRunnerFiles.readFile).toBe('function');
        expect(typeof diskAssetSource.read).toBe('function');
    });

    test('loads the storage-free modules and their disk counterparts', () => {
        expect(typeof ModelCatalog.activate).toBe('function');
        expect(typeof ModelRouter).toBe('function');
        expect(typeof routeConfiguration).toBe('function');
        expect(typeof MemoryOutcomeStore).toBe('function');
        expect(typeof OutcomeStore).toBe('function');
        expect(typeof OpenCodeRunner).toBe('function');
        expect(typeof PreparedOpenCodeRunner.create).toBe('function');
        expect(typeof MemoryRunnerFiles).toBe('function');
        expect(typeof MemoryAssetSource).toBe('function');
        expect(typeof memoryTransfer.pack).toBe('function');
        expect(typeof diskTransfer.pack).toBe('function');
        expect(typeof diskDaytonaDependencies.assets?.read).toBe('function');
        expect(typeof new DaytonaRuntimeProvider().adopt).toBe('function');
    });

    test('types the new injected interfaces from their subpaths', () => {
        const sink: OutcomeSink = new MemoryOutcomeStore();
        const transfer: RemoteTransfer = memoryTransfer;
        const values = [sink, transfer];
        expect(values).toHaveLength(2);
    });

    test('types the injected interfaces from their subpaths', () => {
        // These only need to typecheck. They would fail `tsc` if a subpath
        // stopped resolving or an interface drifted.
        const files: RunnerFiles = diskRunnerFiles;
        const assets: AssetSource = diskAssetSource;
        const daytona: DaytonaClient | undefined = undefined;
        const e2b: E2BClient | undefined = undefined;
        const runtime: PreparedRuntime | undefined = undefined;
        const workbench: ResolvedWorkbench | undefined = undefined;
        const event: WorkbenchEvent | undefined = undefined;
        const values = [files, assets, daytona, e2b, runtime, workbench, event];
        expect(values).toHaveLength(7);
    });

    test('points every subpath at a file that exists', async () => {
        const manifest = JSON.parse(
            await readFile(join(root, 'package.json'), 'utf8')
        ) as { exports: Record<string, string> };
        const missing: string[] = [];
        for (const [subpath, target] of Object.entries(manifest.exports)) {
            if (!(await Bun.file(join(root, target)).exists())) {
                missing.push(`${subpath} -> ${target}`);
            }
        }
        expect(missing).toEqual([]);
    });

    test('keeps the root export on the public entry point', async () => {
        const manifest = JSON.parse(
            await readFile(join(root, 'package.json'), 'utf8')
        ) as { exports: Record<string, string> };
        expect(manifest.exports['.']).toBe('./src/index.ts');
    });
});
