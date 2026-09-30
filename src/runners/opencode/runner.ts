import { ModelRouter, type ResolvedRunnerConfiguration } from '../../models/index.js';
import type { PreparedRuntime, RuntimeAsset } from '../../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import type { RunnerFiles } from '../files.js';
import {
    assertRunnerConfiguration,
    type PreparedRunner,
    type PreparedRunnerSessionOptions,
    Runner,
    type RunnerEventNormalizer,
} from '../runner.js';
import { type RunnerContextFiles, remapRunnerContext } from '../runtime-context.js';
import { OpenCodeSessionAdapter, type OpenCodeSessionDependencies } from './adapter.js';
import { OpenCodeEventAdapter } from './events.js';
import { buildOpenCodeInvocation, publicInvocation } from './invocation.js';
import { type StagedOpenCodeSkills, stageOpenCodeSkillsWith } from './staging.js';

/** Stages a Workbench's skills, native config, and context through `files`. */
export type OpenCodeSkillStaging = (
    workbench: ResolvedWorkbench,
    files: RunnerFiles
) => Promise<StagedOpenCodeSkills>;

export interface OpenCodeRunnerDependencies {
    /**
     * Where skills, native config, and context are staged. Required: the runner
     * has no storage of its own. The CLI passes the local disk; a host passes any
     * store that can answer the same calls.
     */
    files: RunnerFiles;
    /** Replaces how skills are staged. Defaults to `stageOpenCodeSkillsWith`. */
    stageSkills?: OpenCodeSkillStaging;
    /** The session driver's own dependencies: `fetch`, the server password, timeouts. */
    session?: Omit<OpenCodeSessionDependencies, 'files'>;
}

export class OpenCodeRunner extends Runner {
    readonly name = 'opencode';
    readonly session: OpenCodeSessionAdapter;
    private readonly files: RunnerFiles;
    private readonly stageSkills: OpenCodeSkillStaging;

    constructor(dependencies: OpenCodeRunnerDependencies) {
        super();
        this.files = dependencies.files;
        this.stageSkills =
            dependencies.stageSkills ??
            ((workbench, files) => stageOpenCodeSkillsWith(files, workbench));
        this.session = new OpenCodeSessionAdapter({
            ...dependencies.session,
            files: dependencies.files,
        });
    }

    async prepare(workbench: ResolvedWorkbench): Promise<PreparedRunner> {
        return PreparedOpenCodeRunner.create(
            workbench,
            this.session,
            this.files,
            this.stageSkills
        );
    }
}

/** An OpenCode runner with its skills staged, ready to build invocations and start sessions. */
export class PreparedOpenCodeRunner implements PreparedRunner {
    readonly name = 'opencode';
    readonly failureLabel = 'OpenCode';
    readonly assets: RuntimeAsset[];

    readonly #cleanup: () => Promise<void>;
    readonly #nativeConfigFile: string | undefined;
    readonly #stagedDirectory: string | undefined;
    readonly #workbench: ResolvedWorkbench;
    readonly #session: OpenCodeSessionAdapter;
    readonly #context: RunnerContextFiles;

    private constructor(options: {
        workbench: ResolvedWorkbench;
        stagedDirectory?: string;
        nativeConfigFile?: string;
        cleanup: () => Promise<void>;
        session: OpenCodeSessionAdapter;
        context: RunnerContextFiles;
    }) {
        this.#workbench = options.workbench;
        this.#stagedDirectory = options.stagedDirectory;
        this.#nativeConfigFile = options.nativeConfigFile;
        this.#cleanup = options.cleanup;
        this.#session = options.session;
        this.#context = options.context;
        this.assets = [
            ...(options.stagedDirectory
                ? [{ path: options.stagedDirectory, access: 'read-write' as const }]
                : []),
        ];
    }

    static async create(
        workbench: ResolvedWorkbench,
        session: OpenCodeSessionAdapter,
        files: RunnerFiles,
        stageSkills: OpenCodeSkillStaging = (source, storage) =>
            stageOpenCodeSkillsWith(storage, source)
    ): Promise<PreparedOpenCodeRunner> {
        const staged = await stageSkills(workbench, files);
        const nativeConfigFile = staged.nativeConfigFile;
        return new PreparedOpenCodeRunner({
            workbench,
            ...(staged?.directory ? { stagedDirectory: staged.directory } : {}),
            ...(nativeConfigFile ? { nativeConfigFile } : {}),
            cleanup: staged?.cleanup ?? (async () => {}),
            session,
            context: staged.context,
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
            this.#nativeConfigFile
                ? runtime.pathFor(this.#nativeConfigFile)
                : undefined,
            remapRunnerContext(this.#context, (path) => runtime.pathFor(path))
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
                // Cloud proxy setup and cold native session loading share this
                // bounded readiness budget, not the ten-second local deadline.
                ...(runtime.name === 'e2b' || runtime.name === 'daytona'
                    ? { startupTimeoutMs: 60_000 }
                    : {}),
                context: remapRunnerContext(this.#context, (path) =>
                    runtime.pathFor(path)
                ),
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
