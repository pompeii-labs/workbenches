import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    E2BClient,
    E2BSandbox,
    E2BSandboxInfo,
} from '../../../src/runtimes/e2b/contracts.js';
import { E2BPathPlan } from '../../../src/runtimes/e2b/paths.js';
import { E2BRuntimeProvider } from '../../../src/runtimes/e2b/provider.js';
import { E2BAssetSnapshot } from '../../../src/runtimes/e2b/snapshot.js';
import { DiskAssetSource } from '../../../src/runtimes/staging/disk.js';
import { TransferRules } from '../../../src/runtimes/staging/rules.js';
import type { AssetSource } from '../../../src/runtimes/staging/source.js';
import type { ResolvedWorkbench } from '../../../src/types.js';
import { MemoryAssetSource, readArchive } from './memory.js';

const diskAssetSource = new DiskAssetSource();
const rules = new TransferRules('E2B');

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

function binding(hostPath: string, kind: 'workspace' | 'package' = 'workspace') {
    return {
        hostPath,
        runtimePath: kind === 'workspace' ? '/workspace' : '/workbench',
        access: 'read-write' as const,
        excludedHostPaths: [],
        kind,
    };
}

describe('asset sources', () => {
    test('stages a workspace from memory with the same exclusions as disk', async () => {
        const source = new MemoryAssetSource()
            .file('/virtual/ws/src/app.ts', 'export {}')
            .file('/virtual/ws/.env', 'SECRET=1')
            .file('/virtual/ws/.env.example', 'SECRET=')
            .file('/virtual/ws/node_modules/dep/index.js', 'x')
            .file('/virtual/ws/.ssh/id_rsa', 'key')
            .link('/virtual/ws/alias', 'src/app.ts');
        const snapshot = await E2BAssetSnapshot.create(
            binding('/virtual/ws'),
            1024 * 1024,
            undefined,
            { assets: source, local: diskAssetSource, rules }
        );
        try {
            const archive = await readArchive(
                new Uint8Array(await readFile(snapshot.archive))
            );
            expect(Object.keys(archive).sort()).toEqual([
                '.env.example',
                'alias',
                'src/app.ts',
            ]);
            expect(archive.alias).toEqual({ link: 'src/app.ts' });
            expect(snapshot.excludedPaths.sort()).toEqual([
                '.env',
                '.ssh',
                'node_modules',
            ]);
        } finally {
            await snapshot.cleanup();
        }
    });

    test('matches the disk source for the same tree', async () => {
        const root = await mkdtemp(join(tmpdir(), 'workbench-asset-source-'));
        directories.push(root);
        await mkdir(join(root, 'src'));
        await writeFile(join(root, 'src', 'app.ts'), 'export {}');
        await writeFile(join(root, '.env'), 'SECRET=1');
        const memory = new MemoryAssetSource()
            .file(`${root}/src/app.ts`, 'export {}')
            .file(`${root}/.env`, 'SECRET=1');
        const read = async (source: AssetSource) => {
            const snapshot = await E2BAssetSnapshot.create(
                binding(root),
                1024 * 1024,
                undefined,
                { assets: source, local: diskAssetSource, rules }
            );
            try {
                return {
                    files: await readArchive(
                        new Uint8Array(await readFile(snapshot.archive))
                    ),
                    excluded: snapshot.excludedPaths,
                };
            } finally {
                await snapshot.cleanup();
            }
        };
        expect(await read(memory)).toEqual(await read(diskAssetSource));
    });

    test('enforces the transfer limit before reading file contents', async () => {
        const source = new MemoryAssetSource().file(
            '/virtual/ws/big.bin',
            'x'.repeat(64)
        );
        await expect(
            E2BAssetSnapshot.create(binding('/virtual/ws'), 8, undefined, {
                assets: source,
                local: diskAssetSource,
                rules,
            })
        ).rejects.toThrow('E2B transfer exceeds the 8 B safety limit');
        expect(source.reads).toEqual([]);
    });

    test('verifies staged paths through the source', async () => {
        const workbench = {
            manifestPath: '/virtual/pkg/workbench.yml',
            packageDirectory: '/virtual/pkg',
            repositoryDirectory: '/virtual/ws',
            instructionsPath: '/virtual/pkg/instructions.md',
            skills: [],
            manifest: { runner: 'opencode', env: {} },
        } as unknown as ResolvedWorkbench;
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
            rules
        );
        const source = new MemoryAssetSource().directory('/virtual/ws');
        await expect(plan.verify(source)).rejects.toThrow(
            'Runtime asset does not exist: /virtual/pkg'
        );
        source.directory('/virtual/pkg');
        await expect(plan.verify(source)).resolves.toBeUndefined();
    });

    test('runs the E2B provider over a host that has no disk assets', async () => {
        const source = new MemoryAssetSource()
            .file('/virtual/ws/readme.md', 'hello')
            .file('/virtual/pkg/instructions.md', 'Use the fixture.')
            .file('/virtual/pkg/workbench.yml', 'fixture');
        const client = new RecordingClient();
        const workbench = {
            manifestPath: '/virtual/pkg/workbench.yml',
            packageDirectory: '/virtual/pkg',
            repositoryDirectory: '/virtual/ws',
            instructionsPath: '/virtual/pkg/instructions.md',
            skills: [],
            manifest: {
                spec: 0,
                version: '0.1.0',
                name: 'memory-fixture',
                runner: 'opencode',
                model: { id: 'openai/gpt-5.6-terra' },
                instructions: './instructions.md',
                skills: [],
                tools: [],
                mcps: [],
                env: {},
                runtime: 'e2b',
                image: 'ghcr.io/example/workbench:1.0.0',
            },
        } as unknown as ResolvedWorkbench;
        const runtime = await new E2BRuntimeProvider({
            client,
            assets: source,
            local: diskAssetSource,
        }).prepare({
            workbench,
            workspaceDirectory: '/virtual/ws',
            environment: { OPENAI_API_KEY: 'fixture-key' },
            assets: [
                { path: '/virtual/ws', access: 'read-write' },
                { path: '/virtual/pkg', access: 'read-only' },
            ],
        });
        try {
            await runtime.preflight();
            const uploaded = await Promise.all(
                [...client.uploads.values()].map((bytes) => readArchive(bytes))
            );
            expect(uploaded.map((files) => Object.keys(files).sort())).toEqual([
                ['readme.md'],
                ['instructions.md', 'workbench.yml'],
            ]);
            expect(source.reads).toContain('/virtual/ws/readme.md');
        } finally {
            await runtime.cleanup();
        }
    });
});

class RecordingClient implements E2BClient {
    readonly uploads = new Map<string, Uint8Array>();

    async prepareTemplate() {
        return {
            name: 'template',
            immutableReference: 'template-fixture',
            action: 'built' as const,
        };
    }

    async createSandbox(): Promise<E2BSandbox> {
        const uploads = this.uploads;
        const done = { code: 0, stdout: '', stderr: '' };
        const info: E2BSandboxInfo = {
            startedAt: new Date(),
            endAt: new Date(),
            cpuCount: 1,
            memoryMB: 512,
        };
        return {
            id: 'sandbox-memory',
            async run(command: string) {
                if (command.startsWith('printf "%s:%s"')) {
                    return { ...done, stdout: '1000:1000' };
                }
                if (command === 'tar --help 2>&1') {
                    return { ...done, stdout: '--null' };
                }
                if (command.startsWith('command -v')) {
                    return { ...done, stdout: '/usr/bin/tool\n' };
                }
                if (command.includes('rev-parse HEAD')) {
                    return { ...done, stdout: `${'a'.repeat(40)}\n` };
                }
                return done;
            },
            async start() {
                throw new Error('not used');
            },
            async startPty() {
                throw new Error('not used');
            },
            async upload(path: string, data: ReadableStream<Uint8Array>) {
                uploads.set(
                    path,
                    new Uint8Array(await new Response(data).arrayBuffer())
                );
            },
            async download() {
                return new Blob([]).stream();
            },
            async fileSize() {
                return 0;
            },
            async info() {
                return info;
            },
            host: (port: number) => `${port}-sandbox.test`,
            async kill() {},
        };
    }

    async listManaged() {
        return [];
    }

    async killSandbox() {}
}
