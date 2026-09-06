import { ModelRouter, type ResolvedRunnerConfiguration } from '../../models/index.js';
import type { PreparedRuntime, RuntimeAsset } from '../../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import {
    assertRunnerConfiguration,
    type PreparedRunner,
    type PreparedRunnerSessionOptions,
    Runner,
    type RunnerEventNormalizer,
} from '../runner.js';
import { stagePiConfig } from './assets.js';
import { PiEventAdapter } from './events.js';
import {
    buildPiInvocation,
    piCredentialCommand,
    publicPiInvocation,
} from './invocation.js';
import { PiSessionAdapter, type SpawnedPi } from './session.js';

export class PiRunner extends Runner {
    readonly name = 'pi';
    readonly session = new PiSessionAdapter();

    async prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<PreparedRunner> {
        return PreparedPiRunner.create(workbench, environment, this.session);
    }
}

class PreparedPiRunner implements PreparedRunner {
    readonly name = 'pi';
    readonly failureLabel = 'Pi';
    readonly assets: RuntimeAsset[];

    readonly #cleanup: () => Promise<void>;
    readonly #stagedDirectory: string;
    readonly #workbench: ResolvedWorkbench;
    readonly #session: PiSessionAdapter;

    private constructor(options: {
        workbench: ResolvedWorkbench;
        stagedDirectory: string;
        cleanup: () => Promise<void>;
        session: PiSessionAdapter;
    }) {
        this.#workbench = options.workbench;
        this.#stagedDirectory = options.stagedDirectory;
        this.#cleanup = options.cleanup;
        this.#session = options.session;
        this.assets = [{ path: options.stagedDirectory, access: 'read-write' }];
    }

    static async create(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>,
        session = new PiSessionAdapter()
    ): Promise<PreparedPiRunner> {
        const staged = await stagePiConfig(workbench, environment, {
            linkNativeCredentials: workbench.manifest.runtime === 'local',
        });
        return new PreparedPiRunner({
            workbench,
            stagedDirectory: staged.directory,
            cleanup: staged.cleanup,
            session,
        });
    }

    build(
        runtime: PreparedRuntime,
        task: string,
        configuration: ResolvedRunnerConfiguration
    ): RunnerInvocation {
        assertRunnerConfiguration(this.#workbench, configuration);
        return buildPiInvocation(
            runtime.workbench,
            task,
            new ModelRouter().environmentForRoute(
                this.#workbench,
                configuration,
                runtime.environment
            ),
            runtime.workspaceDirectory,
            configuration.model,
            runtime.pathFor(this.#stagedDirectory)
        );
    }

    native(runtime: PreparedRuntime, command: string[]): RunnerInvocation {
        const environment = { ...runtime.environment };
        if (runtime.name === 'local') {
            return {
                command,
                cwd: runtime.workspaceDirectory,
                env: environment,
            };
        }
        return {
            command: piCredentialCommand(
                command,
                environment,
                runtime.pathFor(this.#stagedDirectory)
            ),
            cwd: runtime.workspaceDirectory,
            env: environment,
        };
    }

    publicInvocation(invocation: RunnerInvocation): Record<string, unknown> {
        return publicPiInvocation(invocation);
    }

    events(): RunnerEventNormalizer {
        return new PiEventAdapter();
    }

    startSession(runtime: PreparedRuntime, options: PreparedRunnerSessionOptions) {
        assertRunnerConfiguration(this.#workbench, options.configuration);
        return this.#session.startPrepared(
            {
                workbench: runtime.workbench,
                workspaceDirectory: runtime.workspaceDirectory,
                environment: new ModelRouter().environmentForRoute(
                    this.#workbench,
                    options.configuration,
                    runtime.environment
                ),
                configuration: options.configuration,
                host: options.host,
                ...(options.session ? { session: options.session } : {}),
            },
            {
                configDirectory: runtime.pathFor(this.#stagedDirectory),
                spawn: (command, spawnOptions): SpawnedPi => {
                    const process = runtime.launchSession(
                        {
                            command,
                            cwd: spawnOptions.cwd,
                            env: spawnOptions.env,
                        },
                        { stdin: 'pipe' }
                    );
                    const input = process.stdin;
                    if (!input) {
                        runtime.cancel(process);
                        throw new Error('Runtime did not expose Pi session input');
                    }
                    return {
                        exited: process.exited,
                        stdin: {
                            write: (value) => input.write(value),
                            ...(input.flush ? { flush: () => input.flush?.() } : {}),
                            ...(input.end ? { end: () => void input.end?.() } : {}),
                        },
                        ...(process.stdout ? { stdout: process.stdout } : {}),
                        ...(process.stderr ? { stderr: process.stderr } : {}),
                        kill: () => runtime.cancel(process),
                    };
                },
            }
        );
    }

    cleanup(): Promise<void> {
        return this.#cleanup();
    }
}
