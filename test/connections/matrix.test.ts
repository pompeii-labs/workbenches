import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelConnection } from '../../src/commands/connection.js';
import { CliPresenter } from '../../src/commands/presenter.js';
import {
    HostCredentialFiles,
    RunnerCredentialStore,
} from '../../src/connections/credentials.js';
import { NativeCredentialFile } from '../../src/connections/nativecredentials.js';
import { ConnectionSetup } from '../../src/connections/setup.js';
import type { ConnectionTarget } from '../../src/connections/targets.js';
import type { PreparedRunner } from '../../src/runners/runner.js';
import type { PreparedRuntime } from '../../src/runtimes/contracts.js';
import type { ResolvedWorkbench } from '../../src/types.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

for (const runtime of ['docker', 'e2b', 'daytona'] as const) {
    for (const harness of ['opencode', 'pi', 'claude-code']) {
        test(`connect saves, verifies and removes OpenRouter for ${harness} on ${runtime}`, async () => {
            const home = await mkdtemp(join(tmpdir(), 'workbench-connect-matrix-'));
            directories.push(home);
            const target: ConnectionTarget = {
                runtime,
                harness,
                provider: 'openrouter',
                method: {
                    id: 'api-key',
                    label: 'OpenRouter API key',
                    nativeProvider: 'openrouter',
                    authenticationMethod: 'api',
                },
            };
            const file = NativeCredentialFile.for(harness);
            const files = new HostCredentialFiles(home);
            const preparedRuntime = {
                credentials: files,
            } as unknown as PreparedRuntime;
            const setup = new ConnectionSetup({
                home,
                target,
                environment: {},
                workbench: {
                    workbench: {} as ResolvedWorkbench,
                    reference: 'fixture',
                    workspaceDirectory: home,
                },
                check: () => ({
                    open: (work) => work(preparedRuntime, {} as PreparedRunner),
                    inspect: async (options = {}) => {
                        await options.before?.(preparedRuntime);
                        const saved = await file.find(files, 'openrouter');
                        return {
                            model: 'anthropic/claude-sonnet-4-5',
                            ready: Boolean(saved),
                            authenticatedProviders: saved ? ['openrouter'] : [],
                            connections: saved
                                ? [
                                      {
                                          provider: 'openrouter',
                                          nativeProvider: 'openrouter',
                                          nativeModel: 'fixture',
                                          authenticationMethod: 'api',
                                      },
                                  ]
                                : [],
                            routes: [],
                            connectCommand: 'wb connect fixture',
                        };
                    },
                }),
            });
            const connection = new ModelConnection({
                home,
                target,
                environment: {},
                interactive: false,
                setup,
                output: new CliPresenter({
                    interactive: false,
                    stdout: () => {},
                    stderr: () => {},
                }),
                readKey: async () => 'fixture-openrouter-key\n',
            });
            await connection.connect({ stdin: true });
            expect(await setup.verify()).toMatchObject({ ready: true, saved: true });
            const stored =
                runtime === 'docker'
                    ? files
                    : new HostCredentialFiles(
                          new RunnerCredentialStore(home).binding(runtime, harness)
                              .directory
                      );
            expect((await file.find(stored, 'openrouter'))?.value.key).toBe(
                'fixture-openrouter-key'
            );
            await connection.remove([target.method]);
            expect(await file.find(stored, 'openrouter')).toBeUndefined();
            expect(await setup.verify()).toMatchObject({ ready: false, saved: false });
        });
    }
}
