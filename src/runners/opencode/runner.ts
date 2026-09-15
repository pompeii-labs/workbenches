import { lstat } from 'node:fs/promises';
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
import { OpenCodeSessionAdapter } from './adapter.js';
import { stageOpenCodeSkills } from './assets.js';
import { OpenCodeEventAdapter } from './events.js';
import { buildOpenCodeInvocation, publicInvocation } from './invocation.js';

export class OpenCodeRunner extends Runner {
    readonly name = 'opencode';
    readonly session = new OpenCodeSessionAdapter();

    async prepare(workbench: ResolvedWorkbench): Promise<PreparedRunner> {
        return PreparedOpenCodeRunner.create(workbench, this.session);
    }
}

class PreparedOpenCodeRunner implements PreparedRunner {
    readonly name = 'opencode';
    readonly failureLabel = 'OpenCode';
    readonly assets: RuntimeAsset[];

    readonly #cleanup: () => Promise<void>;
    readonly #nativeConfigFile: string | undefined;
    readonly #stagedDirectory: string | undefined;
    readonly #workbench: ResolvedWorkbench;
    readonly #session: OpenCodeSessionAdapter;

    private constructor(options: {
        workbench: ResolvedWorkbench;
        stagedDirectory?: string;
        nativeConfigFile?: string;
        cleanup: () => Promise<void>;
        session: OpenCodeSessionAdapter;
    }) {
        this.#workbench = options.workbench;
        this.#stagedDirectory = options.stagedDirectory;
        this.#nativeConfigFile = options.nativeConfigFile;
        this.#cleanup = options.cleanup;
        this.#session = options.session;
        this.assets = [
            ...(options.stagedDirectory
                ? [{ path: options.stagedDirectory, access: 'read-write' as const }]
                : []),
            ...(options.nativeConfigFile
                ? [{ path: options.nativeConfigFile, access: 'read-only' as const }]
                : []),
        ];
    }

    static async create(
        workbench: ResolvedWorkbench,
        session = new OpenCodeSessionAdapter()
    ): Promise<PreparedOpenCodeRunner> {
        const staged = await stageOpenCodeSkills(workbench);
        const nativeConfigFile =
            workbench.runnerConfigPath &&
            (await lstat(workbench.runnerConfigPath)).isFile()
                ? workbench.runnerConfigPath
                : undefined;
        return new PreparedOpenCodeRunner({
            workbench,
            ...(staged?.directory ? { stagedDirectory: staged.directory } : {}),
            ...(nativeConfigFile ? { nativeConfigFile } : {}),
            cleanup: staged?.cleanup ?? (async () => {}),
            session,
        });
    }

    build(
        runtime: PreparedRuntime,
        task: string,
        configuration: ResolvedRunnerConfiguration
    ): RunnerInvocation {
        assertRunnerConfiguration(this.#workbench, configuration);
        return buildOpenCodeInvocation(
            runtime.workbench,
            task,
            new ModelRouter().environmentForRoute(
                this.#workbench,
                configuration,
                runtime.environment
            ),
            this.#stagedDirectory ? runtime.pathFor(this.#stagedDirectory) : undefined,
            runtime.workspaceDirectory,
            configuration.model,
            this.#nativeConfigFile ? runtime.pathFor(this.#nativeConfigFile) : undefined
        );
    }

    native(runtime: PreparedRuntime, command: string[]): RunnerInvocation {
        return {
            command,
            cwd: runtime.workspaceDirectory,
            env: {
                ...runtime.environment,
                ...(this.#nativeConfigFile
                    ? { OPENCODE_CONFIG: runtime.pathFor(this.#nativeConfigFile) }
                    : {}),
                ...(this.#stagedDirectory
                    ? {
                          OPENCODE_CONFIG_DIR: runtime.pathFor(this.#stagedDirectory),
                      }
                    : {}),
            },
        };
    }

    publicInvocation(invocation: RunnerInvocation): Record<string, unknown> {
        return publicInvocation(invocation);
    }

    events(): RunnerEventNormalizer {
        return new OpenCodeEventAdapter();
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
                ...(options.authentication
                    ? { authentication: options.authentication }
                    : {}),
                ...(options.session ? { session: options.session } : {}),
            },
            {
                ...(this.#stagedDirectory
                    ? { configDirectory: runtime.pathFor(this.#stagedDirectory) }
                    : {}),
                ...(this.#nativeConfigFile
                    ? { nativeConfigFile: runtime.pathFor(this.#nativeConfigFile) }
                    : {}),
                launch: (buildInvocation) => {
                    const service = runtime.launchService(buildInvocation);
                    const process = service.process;
                    return {
                        process: {
                            exited: process.exited,
                            ...(process.stdout ? { stdout: process.stdout } : {}),
                            ...(process.stderr ? { stderr: process.stderr } : {}),
                            kill: () => runtime.cancel(process),
                        },
                        resolveUrl: service.resolveUrl,
                    };
                },
            }
        );
    }

    cleanup(): Promise<void> {
        return this.#cleanup();
    }
}
