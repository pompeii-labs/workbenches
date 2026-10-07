import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelConnection } from '../src/commands/connection.js';
import { CliPresenter } from '../src/commands/presenter.js';
import { ConnectionInspector } from '../src/connections/inspector.js';
import { ConnectionSetup } from '../src/connections/setup.js';
import { ConnectionStore } from '../src/connections/store.js';
import type { ConnectionTarget } from '../src/connections/targets.js';
import { RunnerRegistry } from '../src/runners/registry.js';
import type { PreparedRunner } from '../src/runners/runner.js';
import type {
    PreparedRuntime,
    RuntimePrepareRequest,
    RuntimeProvider,
} from '../src/runtimes/contracts.js';
import { RuntimeRegistry } from '../src/runtimes/registry.js';
import { RuntimeSmoke } from '../src/runtimes/smoke.js';
import { SmokeReport } from '../src/runtimes/smokereport.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { WorkbenchInspection } from '../src/workbench/inspection.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('Claude Code parity with OpenCode', () => {
    test('uses identical route precedence through the real inspector', async () => {
        const fixture = await parityFixture();
        const cases: Array<{
            name: string;
            environment: Record<string, string | undefined>;
            options?: { connection: string; discoverConnections: boolean };
            saved?: string;
            native?: boolean;
            expected: string;
        }> = [
            {
                name: 'explicit override',
                environment: {
                    ANTHROPIC_API_KEY: 'anthropic',
                    OPENROUTER_API_KEY: 'openrouter',
                },
                options: { connection: 'openrouter', discoverConnections: true },
                expected: 'openrouter',
            },
            {
                name: 'saved default',
                environment: {
                    ANTHROPIC_API_KEY: 'anthropic',
                    OPENROUTER_API_KEY: 'openrouter',
                },
                saved: 'openrouter',
                expected: 'openrouter',
            },
            {
                name: 'environment key',
                environment: { OPENROUTER_API_KEY: 'openrouter' },
                expected: 'openrouter',
            },
            {
                name: 'native store',
                environment: {},
                native: true,
                expected: 'anthropic',
            },
            {
                name: 'manifest route order',
                environment: {
                    ANTHROPIC_API_KEY: 'anthropic',
                    OPENROUTER_API_KEY: 'openrouter',
                },
                expected: 'anthropic',
            },
        ];

        for (const candidate of cases) {
            const results = await Promise.all(
                fixture.runners.map(async ({ workbench, runner }) => {
                    const store = new ConnectionStore(
                        join(fixture.home, workbench.manifest.runner)
                    );
                    if (candidate.saved) {
                        await store.save(ConnectionStore.context(workbench), {
                            provider: candidate.saved,
                            nativeProvider: candidate.saved,
                            authenticationMethod: 'api',
                        });
                    } else {
                        await store.forget(
                            ConnectionStore.context(workbench),
                            'openrouter'
                        );
                    }
                    return new ConnectionInspector({
                        workbench,
                        runner,
                        runtime: runtime(
                            workbench,
                            candidate.environment,
                            candidate.native
                        ),
                        store,
                    }).inspect(candidate.options ?? {});
                })
            );
            expect(
                results.map((result) => result.configuration?.provider),
                candidate.name
            ).toEqual([candidate.expected, candidate.expected, candidate.expected]);
            expect(
                results.map((result) =>
                    Object.keys(result)
                        .filter((key) => key !== 'method')
                        .toSorted()
                )
            ).toEqual([
                Object.keys(required(results[0]))
                    .filter((key) => key !== 'method')
                    .toSorted(),
                Object.keys(required(results[0]))
                    .filter((key) => key !== 'method')
                    .toSorted(),
                Object.keys(required(results[0]))
                    .filter((key) => key !== 'method')
                    .toSorted(),
            ]);
        }

        await fixture.cleanup();
    });

    test('uses the same view and smoke JSON shapes and generic credential copy', async () => {
        const fixture = await parityFixture();
        const statuses = await Promise.all(
            fixture.runners.map(({ workbench, runner }) =>
                new ConnectionInspector({
                    workbench,
                    runner,
                    runtime: runtime(workbench, { OPENROUTER_API_KEY: 'configured' }),
                }).inspect()
            )
        );
        const views = fixture.runners.map(({ workbench }, index) =>
            WorkbenchInspection.describe({
                workbench,
                origin: {
                    kind: 'local',
                    source: fixture.packageDirectory,
                    selector: 'core',
                },
                authentication: required(statuses[index]),
            }).toJSON()
        );
        const smokes = fixture.runners.map(({ workbench }, index) =>
            SmokeReport.completed(workbench, {
                runner: { name: workbench.manifest.runner, path: '/runner' },
                tools: [],
                authentication: required(statuses[index]),
                workspaces: [],
                disabledMcps: [],
                enabledMcps: [],
                optionalEnvironment: [],
                warnings: [],
            }).toJSON()
        );

        expect(Object.keys(views[1] ?? {}).toSorted()).toEqual(
            Object.keys(views[0] ?? {}).toSorted()
        );
        expect(Object.keys(smokes[1] ?? {}).toSorted()).toEqual(
            Object.keys(smokes[0] ?? {}).toSorted()
        );
        expect(statuses.map((status) => status.warning)).toEqual([
            'OPENROUTER_API_KEY is used and billed. To stop using it, unset OPENROUTER_API_KEY.',
            'OPENROUTER_API_KEY is used and billed. To stop using it, unset OPENROUTER_API_KEY.',
            'OPENROUTER_API_KEY is used and billed. To stop using it, unset OPENROUTER_API_KEY.',
        ]);

        await fixture.cleanup();
    });

    test('runs every runner through local connect setup and remove', async () => {
        const fixture = await parityFixture();
        const methods = ['native', 'native', 'oauth'] as const;
        const harnesses = ['opencode', 'pi', 'claude-code'] as const;
        for (const [index, { workbench }] of fixture.runners.entries()) {
            const method = methods[index];
            const harness = harnesses[index];
            if (!method || !harness) throw new Error('missing parity method');
            const target: ConnectionTarget = {
                runtime: 'local',
                harness,
                provider: 'anthropic',
                method: {
                    id: method === 'oauth' ? 'subscription' : 'native',
                    label:
                        method === 'oauth'
                            ? 'Claude subscription'
                            : 'Anthropic sign-in',
                    nativeProvider: 'anthropic',
                    authenticationMethod: method,
                },
            };
            const store = new ConnectionStore(fixture.home);
            const setup = new ConnectionSetup({
                home: fixture.home,
                target,
                environment: {},
                store,
                workbench: {
                    workbench,
                    reference: fixture.packageDirectory,
                    workspaceDirectory: fixture.packageDirectory,
                },
                check: () => ({
                    open: () =>
                        Promise.reject(new Error('local connect must not sign in')),
                    inspect: async () => ({
                        model: workbench.manifest.model.id,
                        ready: true,
                        authenticatedProviders: ['anthropic'],
                        connections: [
                            {
                                provider: 'anthropic',
                                nativeProvider: 'anthropic',
                                nativeModel: 'claude-sonnet-4-5',
                                authenticationMethod: method,
                            },
                        ],
                        routes: [],
                        connectCommand: 'wb connect fixture --runtime local',
                    }),
                }),
            });
            const connection = new ModelConnection({
                home: fixture.home,
                target,
                workbench: {
                    workbench,
                    reference: fixture.packageDirectory,
                    workspaceDirectory: fixture.packageDirectory,
                },
                output: new CliPresenter({
                    interactive: false,
                    stdout: () => {},
                    stderr: () => {},
                }),
                environment: {},
                interactive: false,
                setup,
            });

            await connection.connect({ stdin: false });
            expect(
                await store.find({ runner: target.harness, runtime: 'local' })
            ).toMatchObject({
                provider: 'anthropic',
                authenticationMethod: method,
            });
            await connection.remove([target.method]);
            expect(
                await store.find({ runner: target.harness, runtime: 'local' })
            ).toBeUndefined();
        }
        await fixture.cleanup();
    });

    test('uses the real runtime smoke and view description paths for every runner', async () => {
        const fixture = await parityFixture();
        const registry = new RuntimeRegistry([new ParityRuntimeProvider()]);
        const reports = [];
        for (const { workbench } of fixture.runners) {
            const smoke = await new RuntimeSmoke({
                workbench,
                environment: { OPENROUTER_API_KEY: 'configured' },
                registry,
            }).check();
            reports.push(
                WorkbenchInspection.describe({
                    workbench,
                    origin: {
                        kind: 'local',
                        source: fixture.packageDirectory,
                        selector: 'core',
                    },
                    authentication: smoke.authentication,
                }).toJSON()
            );
        }
        expect(reports.map((report) => Object.keys(report).toSorted())).toEqual([
            Object.keys(required(reports[0])).toSorted(),
            Object.keys(required(reports[0])).toSorted(),
            Object.keys(required(reports[0])).toSorted(),
        ]);
        await fixture.cleanup();
    });

    test('declares every intentional authentication difference on the runner', () => {
        const registry = RunnerRegistry.standard();
        const openCode = registry.authentication('opencode');
        const claudeCode = registry.authentication('claude-code');

        expect(openCode.nativeCredentialStore('e2b')).toBeTrue();
        expect(claudeCode.nativeCredentialStore('e2b')).toBeFalse();
        expect(openCode.subprocessEnvironmentScrubbing).toBeUndefined();
        expect(claudeCode.subprocessEnvironmentScrubbing).toEqual({
            macos: true,
            linuxProbe: ['bwrap', '--ro-bind', '/', '/', 'true'],
        });
        expect(
            claudeCode.supportsNativeAuthentication('local', 'anthropic', 'oauth')
        ).toBeTrue();
        expect(
            claudeCode.supportsNativeAuthentication('e2b', 'anthropic', 'oauth')
        ).toBeFalse();
    });

    test('selects a saved subscription without warning about an unused API key', async () => {
        const fixture = await parityFixture();
        const claude = fixture.runners.find(
            ({ workbench }) => workbench.manifest.runner === 'claude-code'
        );
        if (!claude) throw new Error('missing Claude Code parity fixture');
        const store = new ConnectionStore(fixture.home);
        await store.save(ConnectionStore.context(claude.workbench), {
            provider: 'anthropic',
            nativeProvider: 'anthropic',
            authenticationMethod: 'oauth',
            method: 'subscription',
        });

        const status = await new ConnectionInspector({
            workbench: claude.workbench,
            runner: claude.runner,
            runtime: runtime(
                claude.workbench,
                { ANTHROPIC_API_KEY: 'unused-key' },
                true
            ),
            store,
        }).inspect();

        expect(status.method).toBe('oauth');
        expect(status.warning).toBeUndefined();
        await fixture.cleanup();
    });
});

async function parityFixture(): Promise<{
    home: string;
    packageDirectory: string;
    runners: Array<{ workbench: ResolvedWorkbench; runner: PreparedRunner }>;
    cleanup(): Promise<void>;
}> {
    const root = await mkdtemp(join(tmpdir(), 'workbench-claude-parity-'));
    temporaryDirectories.push(root);
    const packageDirectory = join(root, 'package');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'instructions.md'), '# Instructions\n');
    const registry = RunnerRegistry.standard();
    const runners = await Promise.all(
        ['opencode', 'pi', 'claude-code'].map(async (name) => {
            const workbench = resolvedWorkbench(name, packageDirectory);
            return {
                workbench,
                runner: await registry.prepare(workbench, {}),
            };
        })
    );
    return {
        home: join(root, 'home'),
        packageDirectory,
        runners,
        cleanup: async () => {
            await Promise.all(runners.map(({ runner }) => runner.cleanup()));
        },
    };
}

class ParityRuntimeProvider implements RuntimeProvider {
    readonly name = 'local';
    readonly placement = 'host' as const;

    prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        return Promise.resolve(runtime(request.workbench, request.environment));
    }
}

function resolvedWorkbench(
    runner: string,
    packageDirectory: string
): ResolvedWorkbench {
    return {
        manifestPath: join(packageDirectory, 'workbench.yml'),
        packageDirectory,
        repositoryDirectory: packageDirectory,
        instructionsPath: join(packageDirectory, 'instructions.md'),
        skills: [],
        manifest: {
            spec: 1,
            name: 'fixture',
            version: '1.0.0',
            runner,
            instructions: 'instructions.md',
            model: { id: 'anthropic/claude-sonnet-4-5' },
            runtimes: { local: {} },
            tools: [],
            skills: [],
            env: {},
            mcps: [],
        },
    };
}

function runtime(
    workbench: ResolvedWorkbench,
    environment: Record<string, string | undefined>,
    native = false
): PreparedRuntime {
    return {
        name: 'local',
        nativeAuthentication: 'persistent',
        workbench,
        workspaceDirectory: workbench.repositoryDirectory,
        environment: { ...environment },
        workspaces: [],
        pathFor: (path) => path,
        preflight: () =>
            Promise.resolve({
                runner: { name: workbench.manifest.runner, path: '/runner' },
                tools: [],
                workspaces: [],
                enabledMcps: [],
                disabledMcps: [],
                optionalEnvironment: [],
            }),
        execute: (invocation) => {
            if (invocation.command[0] === 'opencode') {
                return Promise.resolve({
                    code: 0,
                    stdout: native ? '● Anthropic oauth\n' : '',
                    stderr: '',
                });
            }
            if (invocation.command[0] === 'pi') {
                return Promise.resolve({
                    code: 0,
                    stdout: native
                        ? 'provider model context\nanthropic claude-sonnet-4-5 1M\n'
                        : '',
                    stderr: '',
                });
            }
            return Promise.resolve({
                code: native ? 0 : 1,
                stdout: native
                    ? JSON.stringify({
                          loggedIn: true,
                          authMethod: 'claude.ai',
                          subscriptionType: 'max',
                      })
                    : '',
                stderr: '',
            });
        },
        interact: () => Promise.resolve(0),
        launch: () => ({ exited: Promise.resolve(0) }),
        launchSession: () => ({ exited: Promise.resolve(0) }),
        launchService: () => ({
            process: { exited: Promise.resolve(0) },
            resolveUrl: async (url) => url,
        }),
        cancel: () => {},
        cleanup: async () => {},
    };
}

function required<T>(value: T | undefined): T {
    if (!value) throw new Error('missing parity result');
    return value;
}
