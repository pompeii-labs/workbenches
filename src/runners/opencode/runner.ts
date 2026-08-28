import { lstat } from 'node:fs/promises';
import { ModelRouter, type ResolvedRunnerConfiguration } from '../../models/index.js';
import type { PreparedRuntime, RuntimeAsset } from '../../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import {
    assertRunnerConfiguration,
    type PreparedRunner,
    Runner,
    type RunnerEventNormalizer,
} from '../runner.js';
import { stageOpenCodeSkills } from './assets.js';
import { OpenCodeEventAdapter } from './events.js';
import { buildOpenCodeInvocation, publicInvocation } from './invocation.js';
import { OpenCodeSessionAdapter } from './session.js';

export class OpenCodeRunner extends Runner {
    readonly name = 'opencode';
    readonly session = new OpenCodeSessionAdapter();

    async prepare(workbench: ResolvedWorkbench): Promise<PreparedRunner> {
        return PreparedOpenCodeRunner.create(workbench);
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

    private constructor(options: {
        workbench: ResolvedWorkbench;
        stagedDirectory?: string;
        nativeConfigFile?: string;
        cleanup: () => Promise<void>;
    }) {
        this.#workbench = options.workbench;
        this.#stagedDirectory = options.stagedDirectory;
        this.#nativeConfigFile = options.nativeConfigFile;
        this.#cleanup = options.cleanup;
        this.assets = [
            ...(options.stagedDirectory
                ? [{ path: options.stagedDirectory, access: 'read-write' as const }]
                : []),
            ...(options.nativeConfigFile
                ? [{ path: options.nativeConfigFile, access: 'read-only' as const }]
                : []),
        ];
    }

    static async create(workbench: ResolvedWorkbench): Promise<PreparedOpenCodeRunner> {
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

    cleanup(): Promise<void> {
        return this.#cleanup();
    }
}
