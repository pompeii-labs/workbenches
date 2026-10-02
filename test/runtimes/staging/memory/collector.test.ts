import { describe, expect, test } from 'bun:test';

import { MemoryOutcomeSink } from '../../../../src/outcomes/memory.js';
import type { RuntimeCommandResult } from '../../../../src/runtimes/contracts.js';
import { MemoryOutcomeCollector } from '../../../../src/runtimes/staging/memory/collector.js';
import { MemoryAssetSnapshot } from '../../../../src/runtimes/staging/memory/snapshot.js';
import { MemoryAssetSource } from '../../../../src/runtimes/staging/memory/source.js';
import { TransferRules } from '../../../../src/runtimes/staging/rules.js';
import { TarArchive, type TarEntry } from '../../../../src/runtimes/staging/tar.js';
import type {
    AssetBinding,
    TransferSandbox,
} from '../../../../src/runtimes/staging/transfer.js';

const rules = new TransferRules('Daytona');
const text = (value: string) => new TextEncoder().encode(value);
const file = (name: string, content: string): TarEntry => ({
    name,
    type: 'file',
    mode: 0o644,
    content: text(content),
});
const pack = (entries: TarEntry[]) => TarArchive.pack(entries).gzip();

const workspaceBinding: AssetBinding = {
    hostPath: '/ws',
    runtimePath: '/workspace',
    access: 'read-write',
    excludedHostPaths: [],
    kind: 'workspace',
};
const outcomeBinding: AssetBinding = {
    hostPath: '/out',
    runtimePath: '/outbox',
    access: 'read-write',
    excludedHostPaths: [],
    kind: 'outcome',
};

const archivePath = '/tmp/workbench-output-0.tar.gz';
const deletedPath = '/tmp/workbench-deleted-0';

/** A sandbox that serves the files a test scripts and records every command. */
class ScriptedSandbox implements TransferSandbox {
    readonly commands: string[] = [];
    readonly downloads: string[] = [];
    exitCode = 0;
    private readonly files = new Map<string, Uint8Array>();
    private readonly reported = new Map<string, number>();

    serve(path: string, content: Uint8Array): this {
        this.files.set(path, content);
        return this;
    }

    /** Reports a size that differs from the content, as a sandbox that lies would. */
    report(path: string, size: number): this {
        this.reported.set(path, size);
        return this;
    }

    async run(command: string): Promise<RuntimeCommandResult> {
        this.commands.push(command);
        return { code: this.exitCode, stdout: '', stderr: this.exitCode ? 'boom' : '' };
    }

    async fileSize(path: string): Promise<number> {
        return this.reported.get(path) ?? this.lookup(path).byteLength;
    }

    async download(path: string): Promise<ReadableStream<Uint8Array>> {
        this.downloads.push(path);
        const content = this.lookup(path);
        // Two chunks, so the collector has to join what it reads.
        const middle = Math.floor(content.byteLength / 2);
        return new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(content.slice(0, middle));
                controller.enqueue(content.slice(middle));
                controller.close();
            },
        });
    }

    private lookup(path: string): Uint8Array {
        const exact = this.files.get(path);
        if (exact) return exact;
        // The outbox archive is named with a random token.
        for (const [key, content] of this.files) {
            if (key.endsWith('*') && path.startsWith(key.slice(0, -1))) return content;
        }
        throw new Error(`The sandbox has no file at ${path}`);
    }
}

function workspace(): MemoryAssetSource {
    return new MemoryAssetSource()
        .file('/ws/keep.txt', 'keep')
        .file('/ws/edit.txt', 'before')
        .file('/ws/gone.txt', 'bye')
        .directory('/out');
}

interface Setup {
    sandbox?: ScriptedSandbox;
    maximum?: number;
    baselines?: Map<number, string>;
    bindings?: AssetBinding[];
    source?: MemoryAssetSource;
}

async function collector(setup: Setup = {}) {
    const sandbox = setup.sandbox ?? new ScriptedSandbox();
    const source = setup.source ?? workspace();
    const snapshots = await Promise.all(
        (setup.bindings ?? [workspaceBinding]).map((binding) =>
            MemoryAssetSnapshot.create(source, rules, binding, 1_048_576)
        )
    );
    return {
        sandbox,
        collector: new MemoryOutcomeCollector(sandbox, rules, {
            snapshots,
            baselines: setup.baselines ?? new Map([[0, 'abc123']]),
            maximumTransferBytes: setup.maximum ?? 1_048_576,
        }),
    };
}

describe('MemoryOutcomeCollector', () => {
    test('collects added, modified, and deleted files and cleans up the sandbox', async () => {
        const sandbox = new ScriptedSandbox()
            .serve(
                archivePath,
                await pack([file('edit.txt', 'after'), file('new.txt', 'fresh')])
            )
            .serve(deletedPath, text('gone.txt\0'));
        const { collector: subject } = await collector({ sandbox });
        const result = await subject.collect(new MemoryOutcomeSink());
        expect(result.application_state).toBe('pending');
        expect(
            result.changesets[0]?.entries.map(
                (entry) => `${entry.operation}:${entry.path}`
            )
        ).toEqual(['modify:edit.txt', 'delete:gone.txt', 'add:new.txt']);
        expect(result.changesets[0]?.stats).toMatchObject({
            additions: 1,
            modifications: 1,
            deletions: 1,
        });
        expect(sandbox.commands[0]).toContain('--no-renames');
        expect(sandbox.commands.at(-1)).toContain(`rm -f '${archivePath}'`);
    });

    test('names protected paths it did not stage as warnings', async () => {
        const source = workspace().file('/ws/.env', 'SECRET=1');
        const sandbox = new ScriptedSandbox()
            .serve(archivePath, await pack([file('.env', 'SECRET=2')]))
            .serve(deletedPath, new Uint8Array());
        const { collector: subject } = await collector({ sandbox, source });
        const result = await subject.collect(new MemoryOutcomeSink());
        expect(result.changesets).toEqual([]);
        expect(result.warnings[0]?.code).toBe('workspace_paths_excluded');
        expect(result.warnings[0]?.message).toContain('not sent to Daytona: ".env"');
    });

    test('skips assets that are not writable workspaces', async () => {
        const sandbox = new ScriptedSandbox();
        const { collector: subject } = await collector({
            sandbox,
            bindings: [{ ...workspaceBinding, access: 'read-only' }],
        });
        const result = await subject.collect(new MemoryOutcomeSink());
        expect(result.changesets).toEqual([]);
        expect(sandbox.commands).toEqual([]);
    });

    test('needs the Git baseline recorded at staging', async () => {
        const { collector: subject } = await collector({ baselines: new Map() });
        await expect(subject.collect(new MemoryOutcomeSink())).rejects.toThrow(
            'Daytona workspace baseline is unavailable: /ws'
        );
    });

    test('reports a failed collection command', async () => {
        const sandbox = new ScriptedSandbox();
        sandbox.exitCode = 1;
        const { collector: subject } = await collector({ sandbox });
        await expect(subject.collect(new MemoryOutcomeSink())).rejects.toThrow(
            'Failed to collect Daytona workspace changes: /ws: boom'
        );
    });

    test('refuses a deletion that leaves the workspace', async () => {
        const sandbox = new ScriptedSandbox()
            .serve(archivePath, await pack([]))
            .serve(deletedPath, text('../escape\0'));
        const { collector: subject } = await collector({ sandbox });
        await expect(subject.collect(new MemoryOutcomeSink())).rejects.toThrow(
            'Unsafe Daytona archive path: ../escape'
        );
    });

    test('refuses an archive larger than the transfer limit before downloading it', async () => {
        const sandbox = new ScriptedSandbox()
            .serve(archivePath, await pack([file('new.txt', 'x'.repeat(200))]))
            .serve(deletedPath, new Uint8Array());
        const { collector: subject } = await collector({ sandbox, maximum: 64 });
        await expect(subject.collect(new MemoryOutcomeSink())).rejects.toThrow(
            'Daytona output exceeds the 64 B transfer safety limit'
        );
        expect(sandbox.downloads).toEqual([]);
    });

    test('stops a download that passes the limit the sandbox reported it under', async () => {
        const archive = await pack([file('new.txt', 'x'.repeat(200))]);
        const sandbox = new ScriptedSandbox()
            .serve(archivePath, archive)
            .report(archivePath, 1)
            .serve(deletedPath, new Uint8Array());
        const { collector: subject } = await collector({ sandbox, maximum: 64 });
        await expect(subject.collect(new MemoryOutcomeSink())).rejects.toThrow(
            'Daytona output exceeds the 64 B transfer safety limit'
        );
    });

    test('counts the deletion list against the transfer limit', async () => {
        const sandbox = new ScriptedSandbox()
            .serve(archivePath, await pack([]))
            .serve(deletedPath, text(`${'x'.repeat(80)}\0`));
        const { collector: subject } = await collector({ sandbox, maximum: 60 });
        await expect(subject.collect(new MemoryOutcomeSink())).rejects.toThrow(
            'Daytona output exceeds the 60 B transfer safety limit'
        );
    });
});

describe('MemoryOutcomeCollector output', () => {
    test('returns the files and summary the runner left in its outbox', async () => {
        const sandbox = new ScriptedSandbox().serve(
            '/tmp/workbench-artifacts-*',
            await pack([
                file('report.txt', 'done'),
                file(
                    'outcome.json',
                    JSON.stringify({ version: 1, summary: 'All done' })
                ),
            ])
        );
        const { collector: subject } = await collector({
            sandbox,
            bindings: [outcomeBinding],
        });
        const sink = new MemoryOutcomeSink();
        const output = await subject.collectOutput(sink);
        expect(output.summary).toBe('All done');
        expect(output.artifacts.map((artifact) => artifact.path)).toEqual([
            'report.txt',
        ]);
        const [artifact] = output.artifacts;
        expect(artifact && sink.get(artifact.content)).toEqual(text('done'));
        expect(sandbox.commands.at(-1)).toContain('rm -f');
    });

    test('refuses a symlink in the outbox and an outbox over the limit', async () => {
        const link: TarEntry = {
            name: 'out',
            type: 'symlink',
            mode: 0o777,
            content: new Uint8Array(),
            link: 'report.txt',
        };
        const linked = new ScriptedSandbox().serve(
            '/tmp/workbench-artifacts-*',
            await pack([file('report.txt', 'done'), link])
        );
        const { collector: withLink } = await collector({
            sandbox: linked,
            bindings: [outcomeBinding],
        });
        await expect(withLink.collectOutput(new MemoryOutcomeSink())).rejects.toThrow(
            'Outcome artifacts cannot be symlinks: out'
        );
        const large = new ScriptedSandbox().serve(
            '/tmp/workbench-artifacts-*',
            await pack([file('report.txt', 'x'.repeat(200))])
        );
        const { collector: oversized } = await collector({
            sandbox: large,
            bindings: [outcomeBinding],
            maximum: 64,
        });
        await expect(oversized.collectOutput(new MemoryOutcomeSink())).rejects.toThrow(
            'Daytona output exceeds the 64 B transfer safety limit'
        );
    });
});
