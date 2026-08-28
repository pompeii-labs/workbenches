import { ModelRouter, type ResolvedRunnerConfiguration } from '../../models/index.js';
import type { PreparedRuntime, RuntimeAsset } from '../../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import {
    assertRunnerConfiguration,
    type PreparedRunner,
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
import { PiSessionAdapter } from './session.js';

export class PiRunner extends Runner {
    readonly name = 'pi';
    readonly session = new PiSessionAdapter();

    async prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<PreparedRunner> {
        return PreparedPiRunner.create(workbench, environment);
    }
}

class PreparedPiRunner implements PreparedRunner {
    readonly name = 'pi';
    readonly failureLabel = 'Pi';
    readonly assets: RuntimeAsset[];

    readonly #cleanup: () => Promise<void>;
    readonly #stagedDirectory: string;
    readonly #workbench: ResolvedWorkbench;

    private constructor(options: {
        workbench: ResolvedWorkbench;
        stagedDirectory: string;
        cleanup: () => Promise<void>;
    }) {
        this.#workbench = options.workbench;
        this.#stagedDirectory = options.stagedDirectory;
        this.#cleanup = options.cleanup;
        this.assets = [{ path: options.stagedDirectory, access: 'read-write' }];
    }

    static async create(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<PreparedPiRunner> {
        const staged = await stagePiConfig(workbench, environment, {
            linkNativeCredentials: workbench.manifest.runtime === 'local',
        });
        return new PreparedPiRunner({
            workbench,
            stagedDirectory: staged.directory,
            cleanup: staged.cleanup,
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

    cleanup(): Promise<void> {
        return this.#cleanup();
    }
}
