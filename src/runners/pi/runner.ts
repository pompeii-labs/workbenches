import { ModelRouter, type ResolvedRunnerConfiguration } from '../../models/index.js';
import type { PreparedRuntime, RuntimeAsset } from '../../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import { selectedRuntime } from '../../workbench/runtimes.js';
import {
    assertRunnerConfiguration,
    type PreparedRunner,
    type PreparedRunnerSessionOptions,
    Runner,
    type RunnerEventNormalizer,
} from '../runner.js';
import type { PiConfigStaging, StagedPiConfig } from './config.js';
import { PiEventAdapter } from './events.js';
import {
    buildPiInvocation,
    piCredentialCommand,
    publicPiInvocation,
} from './invocation.js';
import { PiSessionAdapter, type SpawnedPi } from './session.js';

export class PiRunner extends Runner {
    readonly name = 'pi';
    readonly session: PiSessionAdapter;

    constructor(private readonly config: PiConfigStaging) {
        super();
        this.session = new PiSessionAdapter({ config });
    }

    async prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<PreparedRunner> {
        return PreparedPiRunner.create(
            workbench,
            environment,
            this.session,
            this.config
        );
    }
}

class PreparedPiRunner implements PreparedRunner {
    readonly name = 'pi';
    readonly failureLabel = 'Pi';
    readonly assets: RuntimeAsset[];

    readonly #workbench: ResolvedWorkbench;
    readonly #staged: StagedPiConfig;
    readonly #session: PiSessionAdapter;

    private constructor(options: {
        workbench: ResolvedWorkbench;
        staged: StagedPiConfig;
        session: PiSessionAdapter;
    }) {
        this.#workbench = options.workbench;
        this.#staged = options.staged;
        this.#session = options.session;
        this.assets = [{ path: options.staged.directory, access: 'read-write' }];
    }

    static async create(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>,
        session: PiSessionAdapter,
        config: PiConfigStaging
    ): Promise<PreparedPiRunner> {
        return new PreparedPiRunner({
            workbench,
            staged: await config.stage(workbench, environment, {
                linkNativeCredentials: selectedRuntime(workbench).name === 'local',
            }),
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
            runtime.pathFor(this.#staged.directory),
            this.#staged.context.remap((path) => runtime.pathFor(path))
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
                runtime.pathFor(this.#staged.directory)
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
                context: this.#staged.context.remap((path) => runtime.pathFor(path)),
                configDirectory: runtime.pathFor(this.#staged.directory),
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
        return this.#staged.cleanup();
    }
}
