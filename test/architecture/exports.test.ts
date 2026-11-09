import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import type { WorkbenchEvent } from '@pompeii-labs/workbench/events';
import { WORKBENCH_EVENT_TYPES } from '@pompeii-labs/workbench/events';
import { WorkbenchManifestParser } from '@pompeii-labs/workbench/manifest';
import { ActiveModelCatalog, ModelRouter } from '@pompeii-labs/workbench/models';
import { MemoryOutcomeSink, type OutcomeSink } from '@pompeii-labs/workbench/outcomes';
import { OutcomeStore } from '@pompeii-labs/workbench/outcomes/disk';
import { RequirementsPreflight } from '@pompeii-labs/workbench/requirements';
import type { RunnerFiles } from '@pompeii-labs/workbench/runners/files';
import { DiskRunnerFiles } from '@pompeii-labs/workbench/runners/files/disk';
import { MemoryRunnerFiles } from '@pompeii-labs/workbench/runners/files/memory';
import { OpenCodeSessionAdapter } from '@pompeii-labs/workbench/runners/opencode/adapter';
import { OpenCodeEventAdapter } from '@pompeii-labs/workbench/runners/opencode/events';
import {
    type OpenCodeProgress,
    TurnProgress,
} from '@pompeii-labs/workbench/runners/opencode/progress';
import {
    OpenCodeRunner,
    PreparedOpenCodeRunner,
} from '@pompeii-labs/workbench/runners/opencode/runner';
import { OpenCodeServer } from '@pompeii-labs/workbench/runners/opencode/server';
import { OpenCodeServerSession } from '@pompeii-labs/workbench/runners/opencode/session';
import { OpenCodeSkillStaging } from '@pompeii-labs/workbench/runners/opencode/skills';
import type {
    RunnerPermissionRequest,
    RunnerQuestionRequest,
    RunnerSessionHost,
} from '@pompeii-labs/workbench/runners/session';
import { RuntimeRegistry } from '@pompeii-labs/workbench/runtimes';
import type { AssetSource } from '@pompeii-labs/workbench/runtimes/assets';
import { DiskAssetSource } from '@pompeii-labs/workbench/runtimes/assets/disk';
import type { PreparedRuntime } from '@pompeii-labs/workbench/runtimes/contracts';
import {
    DaytonaApi,
    type DaytonaClient,
    DaytonaConnector,
    DaytonaRuntimeProvider,
} from '@pompeii-labs/workbench/runtimes/daytona';
import { E2BRuntimeProvider, E2BSdkClient } from '@pompeii-labs/workbench/runtimes/e2b';
import type { E2BClient } from '@pompeii-labs/workbench/runtimes/e2b/contracts';
import { DiskTransfer } from '@pompeii-labs/workbench/runtimes/remote/disk';
import {
    MemoryAssetSource,
    MemoryTransfer,
    type RemoteTransfer,
    TransferRules,
} from '@pompeii-labs/workbench/runtimes/staging';
import type { ResolvedWorkbench } from '@pompeii-labs/workbench/types';

import { packageManifest, runtimeExports } from './package-exports.js';

const root = join(import.meta.dir, '..', '..');

describe('package exports', () => {
    test('loads the embeddable modules by subpath', () => {
        expect(WORKBENCH_EVENT_TYPES).toContain('run.started');
        expect(typeof WorkbenchManifestParser).toBe('function');
        expect(typeof RequirementsPreflight).toBe('function');
        expect(typeof OpenCodeSessionAdapter).toBe('function');
        expect(typeof OpenCodeEventAdapter).toBe('function');
        expect(typeof OpenCodeServer).toBe('function');
        expect(typeof OpenCodeServerSession).toBe('function');
        expect(typeof TurnProgress).toBe('function');
        expect(typeof OpenCodeSkillStaging).toBe('function');
        expect(typeof RuntimeRegistry.standard).toBe('function');
        expect(typeof E2BRuntimeProvider).toBe('function');
        expect(typeof E2BSdkClient).toBe('function');
        expect(typeof DaytonaRuntimeProvider).toBe('function');
        expect(typeof DaytonaApi).toBe('function');
        expect(typeof DiskRunnerFiles).toBe('function');
        expect(typeof DiskAssetSource).toBe('function');
    });

    test('loads the storage-free modules and their disk counterparts', () => {
        expect(typeof ActiveModelCatalog.activate).toBe('function');
        expect(typeof ModelRouter).toBe('function');
        expect(typeof ModelRouter.prototype.configure).toBe('function');
        expect(typeof MemoryOutcomeSink).toBe('function');
        expect(typeof OutcomeStore).toBe('function');
        expect(typeof OpenCodeRunner).toBe('function');
        expect(typeof PreparedOpenCodeRunner.create).toBe('function');
        expect(typeof MemoryRunnerFiles).toBe('function');
        expect(typeof MemoryAssetSource).toBe('function');
        expect(typeof MemoryTransfer).toBe('function');
        expect(typeof DiskTransfer).toBe('function');
    });

    test('types the new injected interfaces from their subpaths', () => {
        const sink: OutcomeSink = new MemoryOutcomeSink();
        const transfer: RemoteTransfer = new MemoryTransfer(
            new MemoryAssetSource(),
            new TransferRules('Remote')
        );
        // A host names the progress it saves and restores.
        const progress: OpenCodeProgress = {
            sessionId: 'ses_1',
            text: {},
            startedTools: [],
            completedTools: [],
            finishedSteps: [],
        };
        const values = [sink, transfer, progress];
        expect(values).toHaveLength(3);
    });

    test('builds the Daytona provider from injected dependencies alone', () => {
        const source = new MemoryAssetSource();
        const provider = new DaytonaRuntimeProvider({
            transfer: new MemoryTransfer(source, new TransferRules('Daytona')),
            assets: source,
            keys: { key: () => 'fixture-key' },
            connector: new DaytonaConnector(fetch),
            clock: { now: () => new Date(), sleep: async () => {} },
        });
        const client: DaytonaClient | undefined = undefined;
        expect(provider.name).toBe('daytona');
        expect(client).toBeUndefined();
    });

    test('types the injected interfaces from their subpaths', () => {
        // These only need to typecheck. They would fail `tsc` if a subpath
        // stopped resolving or an interface drifted.
        const files: RunnerFiles = new DiskRunnerFiles();
        const assets: AssetSource = new DiskAssetSource();
        const e2b: E2BClient | undefined = undefined;
        const runtime: PreparedRuntime | undefined = undefined;
        const workbench: ResolvedWorkbench | undefined = undefined;
        const event: WorkbenchEvent | undefined = undefined;
        const values = [files, assets, e2b, runtime, workbench, event];
        expect(values).toHaveLength(6);
    });

    test('exports the session host types', () => {
        const host: RunnerSessionHost | undefined = undefined;
        const permission: RunnerPermissionRequest | undefined = undefined;
        const question: RunnerQuestionRequest | undefined = undefined;
        expect([host, permission, question]).toHaveLength(3);
    });

    test('points every subpath at a file that exists', async () => {
        const missing: string[] = [];
        for (const [subpath, target] of Object.entries(runtimeExports)) {
            if (!(await Bun.file(join(root, target)).exists())) {
                missing.push(`${subpath} -> ${target}`);
            }
        }
        expect(missing).toEqual([]);
    });

    test('keeps the root export on the public entry point', () => {
        expect(runtimeExports['.']).toBe('./src/index.ts');
    });

    test('gives every source subpath the declarations built from it', () => {
        // A host's tsc reads the declarations and never type-checks engine
        // source under its own settings. Bun ignores `types` and runs the source.
        const mismatched: string[] = [];
        for (const [subpath, entry] of Object.entries(packageManifest.exports)) {
            if (typeof entry === 'string') {
                if (entry.endsWith('.ts')) mismatched.push(`${subpath} has no types`);
                continue;
            }
            const expected = entry.default
                .replace(/^\.\/src\//, './dist/types/')
                .replace(/\.ts$/, '.d.ts');
            if (entry.types !== expected)
                mismatched.push(`${subpath} -> ${entry.types}`);
            if (entry.source !== entry.default) mismatched.push(`${subpath} source`);
            if (Object.keys(entry)[0] !== 'source') mismatched.push(`${subpath} order`);
        }
        expect(mismatched).toEqual([]);
        expect(packageManifest.files).toContain('dist/types');
    });
});
