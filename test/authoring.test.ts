import { afterEach, describe, expect, test } from 'bun:test';
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
    AuthoringCli,
    AuthoringOperation,
    type AuthoringSmokeOptions,
    ImprovementEvidence,
    OfficialWorkbenchResolver,
    WorkbenchAuthoring,
} from '../src/authoring/index.js';
import { WorkbenchPackage } from '../src/catalog/index.js';
import type { RegistryPackage } from '../src/registry/index.js';
import { RunDispatcher, RunStore } from '../src/runs/index.js';
import { SessionStore } from '../src/sessions/index.js';
import type { WorkbenchManifest } from '../src/types.js';
import { Workbench } from '../src/workbench/index.js';

const temporaryDirectories: string[] = [];
const smoke = async () => {};

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('native Workbench authoring', () => {
    test('puts the exact invoking CLI ahead of installed wb binaries', async () => {
        const home = await temporaryDirectory('workbench-authoring-cli-home-');
        const exactCli = join(home, "exact creator's cli.ts");
        await writeFile(
            exactCli,
            'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n'
        );
        const environment = await new AuthoringCli(home, [
            process.execPath,
            exactCli,
        ]).environment('author_exact_cli', {
            ...process.env,
            PATH: '/installed/bin',
        });
        const shimDirectory = environment.PATH?.split(delimiter)[0];
        expect(shimDirectory).toBe(join(home, 'authoring', 'author_exact_cli', 'bin'));
        expect(await readFile(join(shimDirectory as string, 'wb'), 'utf8')).toStartWith(
            '#!/bin/sh\nexec '
        );

        const child = Bun.spawn(
            [join(shimDirectory as string, 'wb'), 'validate', "creator's package"],
            {
                stdout: 'pipe',
                stderr: 'pipe',
                env: environment,
            }
        );
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);

        expect(exitCode).toBe(0);
        expect(stderr).toBe('');
        expect(JSON.parse(stdout)).toEqual(['validate', "creator's package"]);
    });

    test('keeps the creator CLI shim out of candidate verification', async () => {
        const home = await temporaryDirectory('workbench-authoring-home-');
        const repository = await temporaryDirectory('workbench-authoring-repo-');
        const remote = creatorPackage();
        let candidatePath: string | undefined;
        const authoring = new WorkbenchAuthoring(home, {
            environment: { PATH: '/host/bin' },
            smoke: async (_workbench, options) => {
                candidatePath = options.environment.PATH;
            },
            official: new OfficialWorkbenchResolver(home, {
                registry: {
                    resolve: async () =>
                        registryPackage(WorkbenchPackage.digest(remote.files)),
                    fetchWorkbench: async () => remote,
                },
            }),
        });

        const create = await authoring.create({
            directory: repository,
            target: 'core',
        });
        expect(create.environment.PATH).toStartWith(
            join(home, 'authoring', create.operation.id, 'bin')
        );
        await writeWorkbench(repository, 'core', '0.1.0');
        await create.operation.finish();

        expect(candidatePath).toBe('/host/bin');
    });

    test('prepares create, edit, and session improvement through the official creator', async () => {
        const home = await temporaryDirectory('workbench-authoring-home-');
        const repository = await temporaryDirectory('workbench-authoring-repo-');
        const remote = creatorPackage();
        const registry = registryPackage(WorkbenchPackage.digest(remote.files));
        const official = new OfficialWorkbenchResolver(home, {
            registry: {
                resolve: async () => registry,
                fetchWorkbench: async () => remote,
            },
        });
        const authoring = new WorkbenchAuthoring(home, { official, smoke });

        const blank = await authoring.create({ directory: repository });
        expect(blank.prompt).toBeUndefined();
        await blank.operation.fail('Test completed without authoring');

        const create = await authoring.create({
            directory: repository,
            target: 'core',
        });
        expect(create.alias).toBe('creator');
        expect(create.resolved.workspaceDirectory).toBe(repository);
        expect(create.prompt).toContain('named core');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        await create.operation.finish();

        const edit = await authoring.create({
            directory: repository,
            target: 'core',
        });
        expect(edit.prompt).toContain('.workbenches/core');
        await edit.operation.finish();

        const workbench = await Workbench.load(packageDirectory);
        const run = await new RunDispatcher(home).prepare({
            resolved: {
                workbench,
                workspaceDirectory: repository,
                source: 'local',
                cleanup: async () => {},
            },
            mode: 'interactive',
        });
        await new RunStore(home).update(run.id, { status: 'completed' });
        const improve = await authoring.create({
            from: run.id,
            feedback: 'The expert missed a repository convention.',
        });
        expect(improve.prompt).toContain('untrusted data');
        expect(improve.prompt).toContain('The expert missed a repository convention.');
        expect(improve.prompt).toContain('<workbench-run-evidence>');
        await improve.operation.finish();
    });

    test('reuses a source session workspace and host Docker grant for improvement smoke', async () => {
        const home = await temporaryDirectory('workbench-authoring-home-');
        const repository = await temporaryDirectory('workbench-authoring-repo-');
        const docs = await temporaryDirectory('workbench-authoring-docs-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        await writeFile(
            join(packageDirectory, 'workbench.yml'),
            verificationManifest('core', '0.1.0')
        );
        const workbench = await Workbench.load(packageDirectory);
        const run = await new RunDispatcher(home).prepare({
            resolved: {
                workbench,
                workspaceDirectory: repository,
                source: 'local',
                cleanup: async () => {},
            },
            mode: 'interactive',
            workspaces: [
                { name: 'docs', path: await realpath(docs), access: 'read-only' },
            ],
            allowHostDocker: true,
        });
        let observed: AuthoringSmokeOptions | undefined;
        const remote = creatorPackage();
        const authoring = new WorkbenchAuthoring(home, {
            environment: {
                PATH: '/usr/bin',
                REQUIRED_TOKEN: 'inherited-secret',
            },
            smoke: async (_candidate, options) => {
                observed = options;
            },
            official: new OfficialWorkbenchResolver(home, {
                registry: {
                    resolve: async () =>
                        registryPackage(WorkbenchPackage.digest(remote.files)),
                    fetchWorkbench: async () => remote,
                },
            }),
        });

        const improve = await authoring.create({ from: run.id });
        await Promise.all([
            writeFile(join(packageDirectory, 'instructions.md'), '# improved\n'),
            writeFile(
                join(packageDirectory, 'workbench.yml'),
                verificationManifest('core', '0.1.1')
            ),
        ]);
        await improve.operation.finish();

        expect(observed?.environment.REQUIRED_TOKEN).toBe('inherited-secret');
        expect(observed?.workspaces).toEqual([
            { name: 'docs', path: await realpath(docs), access: 'read-only' },
        ]);
        expect(observed?.allowHostDocker).toBe(true);
    });

    test('refuses to edit an immutable saved Workbench snapshot', async () => {
        const home = await temporaryDirectory('workbench-authoring-home-');
        const repository = await temporaryDirectory('workbench-authoring-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        const workbench = await Workbench.load(packageDirectory);
        const authoring = new WorkbenchAuthoring(home, {
            smoke,
            resolver: {
                resolve: async () => ({
                    workbench,
                    workspaceDirectory: repository,
                    source: 'saved',
                    cleanup: async () => {},
                }),
            },
        });

        await expect(
            authoring.create({ directory: repository, target: 'core' })
        ).rejects.toThrow('immutable saved Workbench');
    });

    test('keeps target authoring and session improvement in one unambiguous call', async () => {
        const home = await temporaryDirectory('workbench-authoring-home-');
        const repository = await temporaryDirectory('workbench-authoring-repo-');
        const authoring = new WorkbenchAuthoring(home);

        await expect(
            authoring.create({
                directory: repository,
                target: 'core',
                from: 'wb_session',
            })
        ).rejects.toThrow('either a Workbench target or --from');
        await expect(
            authoring.create({
                directory: repository,
                feedback: 'Use the repository convention.',
            })
        ).rejects.toThrow('--feedback requires --from');
    });

    test('opens an invalid local Workbench so the creator can repair it', async () => {
        const home = await temporaryDirectory('workbench-authoring-home-');
        const repository = await temporaryDirectory('workbench-authoring-repo-');
        const packageDirectory = join(repository, '.workbenches', 'broken');
        const invalidManifest = manifest('broken', '0.1.0').replace(
            'model:\n  id: openai/gpt-5.6-terra',
            'model: openai/gpt-5.6-terra'
        );
        await mkdir(packageDirectory, { recursive: true });
        await Promise.all([
            writeFile(join(packageDirectory, 'workbench.yml'), invalidManifest),
            writeFile(join(packageDirectory, 'instructions.md'), '# broken\n'),
        ]);
        const remote = creatorPackage();
        const registry = registryPackage(WorkbenchPackage.digest(remote.files));
        const authoring = new WorkbenchAuthoring(home, {
            smoke,
            official: new OfficialWorkbenchResolver(home, {
                registry: {
                    resolve: async () => registry,
                    fetchWorkbench: async () => remote,
                },
            }),
        });

        const edit = await authoring.create({
            target: `${repository}#broken`,
        });
        expect(edit.prompt).toContain('.workbenches/broken');
        await writeFile(
            join(packageDirectory, 'workbench.yml'),
            manifest('broken', '0.1.1')
        );
        await edit.operation.finish();
    });

    test('verifies and caches the official creator outside the saved catalog', async () => {
        const home = await temporaryDirectory('workbench-official-');
        const workspace = await temporaryDirectory('workbench-authoring-target-');
        const remote = creatorPackage();
        const registry = registryPackage(WorkbenchPackage.digest(remote.files));
        const online = new OfficialWorkbenchResolver(home, {
            registry: {
                resolve: async () => registry,
                fetchWorkbench: async () => remote,
            },
        });

        const first = await online.creator(workspace);

        expect(first.cached).toBe(false);
        expect(first.digest).toBe(registry.digest);
        expect(first.resolved.source).toBe('system');
        expect(first.resolved.workspaceDirectory).toBe(workspace);
        expect(first.resolved.workbench.manifest.name).toBe('workbench-creator');
        expect(first.resolved.workbench.packageDirectory).toContain(
            join('official', 'packages')
        );
        await expect(readFile(join(home, 'catalog.json'), 'utf8')).rejects.toThrow();

        const offline = new OfficialWorkbenchResolver(home, {
            registry: {
                resolve: async () => {
                    throw new Error('offline');
                },
                fetchWorkbench: async () => {
                    throw new Error('not reached');
                },
            },
        });
        const cached = await offline.creator(workspace);
        expect(cached.cached).toBe(true);
        expect(cached.digest).toBe(first.digest);
    });

    test('refuses a modified official creator cache', async () => {
        const home = await temporaryDirectory('workbench-official-');
        const workspace = await temporaryDirectory('workbench-authoring-target-');
        const remote = creatorPackage();
        const registry = registryPackage(WorkbenchPackage.digest(remote.files));
        const online = new OfficialWorkbenchResolver(home, {
            registry: {
                resolve: async () => registry,
                fetchWorkbench: async () => remote,
            },
        });
        const first = await online.creator(workspace);
        await writeFile(
            join(first.resolved.workbench.packageDirectory, 'instructions.md'),
            '# Modified\n'
        );

        const offline = new OfficialWorkbenchResolver(home, {
            registry: {
                resolve: async () => {
                    throw new Error('offline');
                },
                fetchWorkbench: async () => {
                    throw new Error('not reached');
                },
            },
        });
        await expect(offline.creator(workspace)).rejects.toThrow(
            'official Workbench creator is unavailable'
        );
    });

    test('requires an official creator that supports native authoring', async () => {
        const home = await temporaryDirectory('workbench-official-');
        const workspace = await temporaryDirectory('workbench-authoring-target-');
        const remote = creatorPackage();
        const registry = {
            ...registryPackage(WorkbenchPackage.digest(remote.files)),
            version: '0.1.3',
        };
        const resolver = new OfficialWorkbenchResolver(home, {
            registry: {
                resolve: async () => registry,
                fetchWorkbench: async () => remote,
            },
        });

        await expect(resolver.creator(workspace)).rejects.toThrow(
            'requires official creator 0.1.4 or newer'
        );
    });

    test('writes bounded normalized improvement evidence and redacts credentials', async () => {
        const home = await temporaryDirectory('workbench-evidence-');
        const sessionId = 'wb_authorevidence1234567890';
        const sessions = new SessionStore(home);
        const session = await sessions.create({
            id: sessionId,
            workbench: 'lux-ops',
            workbench_version: '1.2.3',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            runtime: 'local',
            reference: './repo#lux-ops',
            workbench_path: '/repo/.workbenches/lux-ops',
            source_workbench_path: '/repo/.workbenches/lux-ops',
            workbench_digest: `sha256:${'a'.repeat(64)}`,
            workspace: '/repo',
            workspaces: [],
            latest_run_id: sessionId,
        });
        await writeFile(
            sessions.transcriptPath(sessionId),
            `${JSON.stringify({
                version: 1,
                items: [
                    { id: '1', kind: 'user', text: 'use API_KEY=secret-value' },
                    {
                        id: '2',
                        kind: 'assistant',
                        text: 'The migration failed.',
                    },
                    {
                        id: '3',
                        kind: 'tool',
                        name: 'bash',
                        title: 'Run migration',
                        status: 'failed',
                        error: 'Bearer abcdefghijklmnop',
                    },
                    {
                        id: '4',
                        kind: 'user',
                        text: { locally: 'tampered' },
                    },
                ],
            })}\n`
        );

        const result = await new ImprovementEvidence(home).write({
            operationId: 'author_evidence',
            session,
            feedback: 'The agent ignored the safe migration workflow.',
        });
        const evidence = await readFile(result.path, 'utf8');

        expect(result.transcriptItems).toBe(3);
        expect(result.content).toBe(evidence);
        expect(evidence).toContain('untrusted run evidence');
        expect(evidence).toContain('The migration failed.');
        expect(evidence).toContain('API_KEY=[REDACTED]');
        expect(evidence).toContain('Bearer [REDACTED]');
        expect(evidence).not.toContain('secret-value');
        expect(evidence).not.toContain('abcdefghijklmnop');

        const bounded = await new ImprovementEvidence(home, 1_000).write({
            operationId: 'author_bounded',
            session,
            feedback: 'x'.repeat(10_000),
        });
        expect(bounded.content.length).toBeLessThanOrEqual(1_000);
        expect(await readFile(bounded.path, 'utf8')).toBe(bounded.content);
    });

    test('builds improvement evidence from canonical run events without a TUI transcript', async () => {
        const home = await temporaryDirectory('workbench-run-evidence-');
        const sessionId = 'wb_canonicalsession1234567890';
        const runId = 'wb_canonicalrun1234567890123';
        const sessions = new SessionStore(home);
        const session = await sessions.create({
            id: sessionId,
            workbench: 'lux-ops',
            workbench_version: '1.2.3',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            runtime: 'local',
            reference: './repo#lux-ops',
            workbench_path: '/repo/.workbenches/lux-ops',
            source_workbench_path: '/repo/.workbenches/lux-ops',
            workbench_digest: `sha256:${'a'.repeat(64)}`,
            workspace: '/repo',
            workspaces: [],
            latest_run_id: runId,
        });
        const runs = new RunStore(home);
        await runs.create({
            id: runId,
            metadata: {
                workbench: 'lux-ops',
                workbench_version: '1.2.3',
                runner: 'opencode',
                model: 'openai/gpt-5.6-terra',
                workspace: '/repo',
                mode: 'detached',
                execution: 'one_shot',
                session_id: sessionId,
            },
            request: {
                workbench_path: '/repo/.workbenches/lux-ops',
                workspace: '/repo',
                task: 'ignored after dispatch',
            },
        });
        await runs.takeRequest(runId);
        const events = [
            {
                type: 'input.delivered' as const,
                data: {
                    id: 'input-1',
                    kind: 'send',
                    text: 'Review the migrations with ghp_abcdefghijklmnopqrstuvwxyz',
                    images: [{ name: 'schema.png', mime_type: 'image/png' }],
                },
            },
            {
                type: 'output.text' as const,
                data: { id: 'output-1', text: 'I found ' },
            },
            {
                type: 'output.text' as const,
                data: { id: 'output-1', text: 'the issue.' },
            },
            {
                type: 'tool.started' as const,
                data: { id: 'tool-1', name: 'read', title: 'Read', target: 'db.lux' },
            },
            {
                type: 'tool.completed' as const,
                data: {
                    id: 'tool-1',
                    name: 'read',
                    title: 'Read',
                    target: 'db.lux',
                    status: 'completed',
                },
            },
        ];
        for (const [index, event] of events.entries()) {
            await runs.appendEvent(runId, {
                protocol: 0,
                run_id: runId,
                sequence: index + 1,
                timestamp: new Date(index).toISOString(),
                runner: 'opencode',
                ...event,
            });
        }
        await runs.update(runId, { status: 'completed' });

        const result = await new ImprovementEvidence(home).write({
            operationId: 'author_canonical_evidence',
            session,
            feedback: '',
        });

        expect(result.transcriptItems).toBe(3);
        expect(result.content).toContain('Review the migrations with [REDACTED]');
        expect(result.content).toContain('Attached images: schema.png');
        expect(result.content).toContain('I found the issue.');
        expect(result.content).toContain('- Tool: Read');
        expect(result.content).toContain('- Target: db.lux');
        expect(result.content).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    });

    test('records changed package files and requires an existing version to advance', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_version',
                kind: 'edit',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await writeFile(join(packageDirectory, 'instructions.md'), '# changed\n');

        await expect(operation.finish()).rejects.toThrow(
            'changed without incrementing its version'
        );
        const record = JSON.parse(
            await readFile(
                join(home, 'authoring', 'author_version', 'operation.json'),
                'utf8'
            )
        ) as Record<string, unknown>;
        expect(record.status).toBe('invalid');
        expect(record.changed_files).toEqual([
            join('.workbenches', 'core', 'instructions.md'),
        ]);
    });

    test('accepts a valid candidate after its package version advances', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_valid',
                kind: 'improve',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await writeFile(join(packageDirectory, 'instructions.md'), '# changed\n');
        await writeFile(
            join(packageDirectory, 'workbench.yml'),
            manifest('core', '0.1.1')
        );

        await operation.finish();
        const record = JSON.parse(
            await readFile(
                join(home, 'authoring', 'author_valid', 'operation.json'),
                'utf8'
            )
        ) as Record<string, unknown>;
        expect(record.status).toBe('completed');
        expect(record.error).toBeUndefined();
    });

    test('does not complete an operation until engine-owned smoke passes', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_smoke',
                kind: 'improve',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            async () => {
                throw new Error('runner executable is unavailable');
            }
        );
        await writeFile(join(packageDirectory, 'instructions.md'), '# changed\n');
        await writeFile(
            join(packageDirectory, 'workbench.yml'),
            manifest('core', '0.1.1')
        );

        await expect(operation.finish()).rejects.toThrow(
            'Workbench core failed smoke: runner executable is unavailable'
        );
        const record = JSON.parse(
            await readFile(
                join(home, 'authoring', 'author_smoke', 'operation.json'),
                'utf8'
            )
        ) as Record<string, unknown>;
        expect(record.status).toBe('invalid');
    });

    test('binds candidate smoke inputs without persisting their values', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-repo-');
        const docs = await temporaryDirectory('workbench-operation-docs-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        await writeFile(
            join(packageDirectory, 'workbench.yml'),
            verificationManifest('core', '0.1.0')
        );
        let observed: AuthoringSmokeOptions | undefined;
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_inputs',
                kind: 'improve',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
                verification: {
                    environment: { PATH: '/usr/bin' },
                    environmentOverrides: {
                        file: { OPTIONAL_TOKEN: 'file-secret' },
                        explicit: new Map([['REQUIRED_TOKEN', 'explicit-secret']]),
                    },
                    workspaceOverrides: new Map([['docs', docs]]),
                    workspaceDirectory: repository,
                    allowHostDocker: true,
                },
            },
            async (_workbench, options) => {
                observed = options;
            }
        );
        await Promise.all([
            writeFile(join(packageDirectory, 'instructions.md'), '# changed\n'),
            writeFile(
                join(packageDirectory, 'workbench.yml'),
                verificationManifest('core', '0.1.1')
            ),
        ]);

        await operation.finish();

        expect(observed?.environment.REQUIRED_TOKEN).toBe('explicit-secret');
        expect(observed?.environment.OPTIONAL_TOKEN).toBe('file-secret');
        expect(observed?.workspaces).toEqual([
            { name: 'docs', path: await realpath(docs), access: 'read-only' },
        ]);
        expect(observed?.allowHostDocker).toBe(true);
        const record = await readFile(
            join(home, 'authoring', 'author_inputs', 'operation.json'),
            'utf8'
        );
        expect(record).not.toContain('explicit-secret');
        expect(record).not.toContain('file-secret');
        expect(record).not.toContain(await realpath(docs));
    });

    test('reloaded checkpoints preserve scope and validation without retaining secrets', async () => {
        const home = await temporaryDirectory('authoring-checkpoint-');
        const repository = await temporaryDirectory('authoring-checkpoint-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        await writeFile(
            join(repository, 'notes.txt'),
            'private-value-not-for-checkpoint'
        );
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_checkpoint',
                kind: 'edit',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await operation.checkpoint();
        const path = join(home, 'authoring', operation.id, 'baseline.json');
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await readFile(path, 'utf8')).not.toContain(
            'private-value-not-for-checkpoint'
        );
        const loaded = await AuthoringOperation.load(home, operation.id, {}, smoke);
        await writeFile(join(packageDirectory, 'instructions.md'), '# changed\n');
        await writeFile(
            join(packageDirectory, 'workbench.yml'),
            manifest('core', '0.1.1')
        );
        expect(await loaded.finish()).toMatchObject({
            status: 'completed',
            packages: ['core'],
        });
        await expect(AuthoringOperation.load(home, '../bad')).rejects.toThrow(
            'Invalid authoring operation ID'
        );
    });

    test('reloaded legacy checkpoints remain scoped to Workbench package output', async () => {
        const home = await temporaryDirectory('authoring-checkpoint-');
        const repository = await temporaryDirectory('authoring-checkpoint-repo-');
        await writeWorkbench(repository, 'core', '0.1.0');
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_scope',
                kind: 'edit',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await operation.checkpoint();
        const baselinePath = join(home, 'authoring', operation.id, 'baseline.json');
        const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Array<{
            path: string;
            digest: string;
        }>;
        await writeFile(
            baselinePath,
            JSON.stringify([
                ...baseline,
                { path: 'README.md', digest: 'legacy-workspace-digest' },
                {
                    path: '.codex/worktrees/unrelated/file.ts',
                    digest: 'legacy-worktree-digest',
                },
            ])
        );
        const loaded = await AuthoringOperation.load(home, operation.id, {}, smoke);
        await writeFile(join(repository, 'unexpected.txt'), 'unrequested change');
        expect(await loaded.finish()).toMatchObject({
            status: 'unchanged',
            changedFiles: [],
        });
    });

    test('rejects an unchanged invalid candidate and empty creation', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-repo-');
        const invalid = join(repository, '.workbenches', 'broken');
        await mkdir(invalid, { recursive: true });
        await writeFile(join(invalid, 'workbench.yml'), 'name: broken\n');
        const edit = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_unchanged_invalid',
                kind: 'edit',
                repository,
                targetSelector: 'broken',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await expect(edit.finish()).rejects.toThrow('Workbench broken is invalid');

        const emptyRepository = await temporaryDirectory(
            'workbench-operation-empty-repo-'
        );
        const create = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_empty_create',
                kind: 'create',
                repository: emptyRepository,
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await expect(create.finish()).rejects.toThrow(
            'Workbench creation did not create a package'
        );
    });

    test('rejects edits outside the requested Workbench package', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-repo-');
        await writeWorkbench(repository, 'core', '0.1.0');
        const sibling = await writeWorkbench(repository, 'sibling', '0.1.0');
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_scope',
                kind: 'edit',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await writeFile(join(sibling, 'instructions.md'), '# changed sibling\n');

        await expect(operation.finish()).rejects.toThrow(
            'outside the requested .workbenches/core package'
        );
    });

    test('does not scan unrelated non-package repository source', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        const readme = join(repository, 'README.md');
        await writeFile(readme, '# Before\n');
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_repository_scope',
                kind: 'edit',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await Promise.all([
            writeFile(readme, '# After\n'),
            writeFile(join(packageDirectory, 'instructions.md'), '# changed\n'),
            writeFile(
                join(packageDirectory, 'workbench.yml'),
                manifest('core', '0.1.1')
            ),
        ]);

        expect(await operation.finish()).toMatchObject({
            status: 'completed',
            changedFiles: [
                join('.workbenches', 'core', 'instructions.md'),
                join('.workbenches', 'core', 'workbench.yml'),
            ],
        });
    });

    test('uses the same package boundary in a Git-backed authoring directory', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-git-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        const readme = join(repository, 'README.md');
        await writeFile(readme, '# Before\n');
        expect(Bun.spawnSync(['git', 'init', '--quiet', repository]).exitCode).toBe(0);
        expect(Bun.spawnSync(['git', '-C', repository, 'add', '.']).exitCode).toBe(0);
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_git_scope',
                kind: 'edit',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await Promise.all([
            writeFile(readme, '# After\n'),
            writeFile(join(packageDirectory, 'instructions.md'), '# changed\n'),
            writeFile(
                join(packageDirectory, 'workbench.yml'),
                manifest('core', '0.1.1')
            ),
        ]);

        expect(await operation.finish()).toMatchObject({
            status: 'completed',
            changedFiles: [
                join('.workbenches', 'core', 'instructions.md'),
                join('.workbenches', 'core', 'workbench.yml'),
            ],
        });
    });

    test('rejects files written directly to the Workbench collection root', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_collection_scope',
                kind: 'edit',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await Promise.all([
            writeFile(join(repository, '.workbenches', 'README.md'), '# unexpected\n'),
            writeFile(join(packageDirectory, 'instructions.md'), '# changed\n'),
            writeFile(
                join(packageDirectory, 'workbench.yml'),
                manifest('core', '0.1.1')
            ),
        ]);

        await expect(operation.finish()).rejects.toThrow(
            'outside the requested .workbenches/core package: .workbenches/README.md'
        );
    });

    test('rejects credential-like files added during authoring', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_credential',
                kind: 'edit',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await writeFile(join(packageDirectory, '.env.local'), 'API_KEY=secret\n');

        await expect(operation.finish()).rejects.toThrow(
            'Credential-like files are not allowed'
        );
        const record = await readFile(
            join(home, 'authoring', 'author_credential', 'operation.json'),
            'utf8'
        );
        expect(record).not.toContain('API_KEY');
        expect(record).not.toContain('secret');
    });

    test('uses the runner credential policy for private-key files', async () => {
        const home = await temporaryDirectory('workbench-operation-home-');
        const repository = await temporaryDirectory('workbench-operation-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        const operation = await AuthoringOperation.prepare(
            home,
            {
                id: 'author_private_key',
                kind: 'edit',
                repository,
                targetSelector: 'core',
                creator: {
                    version: '0.1.4',
                    digest: `sha256:${'b'.repeat(64)}`,
                    registry_version_id: 'version-id',
                    cached: false,
                },
            },
            smoke
        );
        await writeFile(join(packageDirectory, 'identity.pem'), 'private key bytes');

        await expect(operation.finish()).rejects.toThrow(
            'Credential-like files are not allowed'
        );
        const record = await readFile(
            join(home, 'authoring', 'author_private_key', 'operation.json'),
            'utf8'
        );
        expect(record).not.toContain('private key bytes');
    });

    test('pins resumable sessions to the exact local Workbench package digest', async () => {
        const home = await temporaryDirectory('workbench-pinned-home-');
        const repository = await temporaryDirectory('workbench-pinned-repo-');
        const packageDirectory = await writeWorkbench(repository, 'core', '0.1.0');
        const workbench = await Workbench.load(packageDirectory);
        const dispatcher = new RunDispatcher(home);
        const run = await dispatcher.prepare({
            resolved: {
                workbench,
                workspaceDirectory: repository,
                source: 'local',
                cleanup: async () => {},
            },
            mode: 'interactive',
        });
        const session = await new SessionStore(home).read(run.session_id as string);

        expect(session.source_workbench_path).toBe(packageDirectory);
        expect(session.workbench_digest).toMatch(/^sha256:[0-9a-f]{64}$/);

        await writeFile(join(packageDirectory, 'instructions.md'), '# mutated\n');
        const mutated = await Workbench.load(packageDirectory);
        await expect(
            dispatcher.prepare({
                resolved: {
                    workbench: mutated,
                    workspaceDirectory: repository,
                    source: 'local',
                    cleanup: async () => {},
                },
                mode: 'interactive',
                session,
            })
        ).rejects.toThrow('does not match the resolved Workbench package');
    });
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function writeWorkbench(
    repository: string,
    name: string,
    version: string
): Promise<string> {
    const directory = join(repository, '.workbenches', name);
    await mkdir(directory, { recursive: true });
    await Promise.all([
        writeFile(join(directory, 'workbench.yml'), manifest(name, version)),
        writeFile(join(directory, 'instructions.md'), `# ${name}\n`),
    ]);
    return directory;
}

function manifest(name: string, version: string): string {
    return [
        'spec: 0',
        `version: ${version}`,
        `name: ${name}`,
        'runner: opencode',
        'model:',
        '  id: openai/gpt-5.6-terra',
        'instructions: ./instructions.md',
        'skills: []',
        'tools: []',
        'mcps: []',
        'env: {}',
        'runtime: local',
        '',
    ].join('\n');
}

function verificationManifest(name: string, version: string): string {
    return [
        'spec: 0',
        `version: ${version}`,
        `name: ${name}`,
        'runner: opencode',
        'model:',
        '  id: openai/gpt-5.6-terra',
        'instructions: ./instructions.md',
        'skills: []',
        'tools: []',
        'mcps: []',
        'env:',
        '  REQUIRED_TOKEN:',
        '    required: true',
        '  OPTIONAL_TOKEN:',
        '    required: false',
        'workspaces:',
        '  docs:',
        '    required: true',
        '    access: read-only',
        'runtime: docker',
        'image: ghcr.io/example/core:0.1.0',
        'docker:',
        '  engine:',
        '    mode: host',
        '',
    ].join('\n');
}

function creatorPackage() {
    const manifestSource = manifest('workbench-creator', '0.1.4');
    return {
        selector: 'creator',
        manifest: Bun.YAML.parse(manifestSource) as WorkbenchManifest,
        source: 'https://github.com/pompeii-labs/workbenches',
        revision: 'a'.repeat(40),
        files: [
            {
                path: 'instructions.md',
                bytes: new TextEncoder().encode('# Creator\n'),
                executable: false,
            },
            {
                path: 'workbench.yml',
                bytes: new TextEncoder().encode(manifestSource),
                executable: false,
            },
        ],
    };
}

function registryPackage(digest: string): RegistryPackage {
    return {
        reference: { publisher: 'pompeii-labs', workbench: 'creator' },
        registryUrl: 'https://api.workbenches.dev',
        versionId: 'version-id',
        version: '0.1.4',
        digest,
        source: 'https://github.com/pompeii-labs/workbenches',
        selector: 'creator',
        revision: 'a'.repeat(40),
        artifactUrl: 'https://api.workbenches.dev/v1/artifacts/version-id',
    };
}
