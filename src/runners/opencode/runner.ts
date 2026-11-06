import {
    type ModelCatalogSnapshot,
    ModelRouter,
    type ResolvedRunnerConfiguration,
} from '../../models/index.js';
import type { PreparedRuntime, RuntimeAsset } from '../../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import { isRemoteRuntime } from '../../workbench/runtimes.js';
import { claudeCodeConnection } from '../claude-code/connection.js';
import {
    assertRunnerConfiguration,
    type PreparedRunner,
    type PreparedRunnerSessionOptions,
    Runner,
    type RunnerEventNormalizer,
} from '../runner.js';
import { OpenCodeSessionAdapter, type OpenCodeSessionDependencies } from './adapter.js';
import {
    CLAUDE_AGENT_PROVIDER,
    claudeAgentEnvironment,
    claudeAgentUnavailable,
} from './claudeagent.js';
import { openCodeConnection, openCodeWorkerSignIn } from './connection.js';
import { OpenCodeEventAdapter } from './events.js';
import { buildOpenCodeInvocation, publicInvocation } from './invocation.js';
import type { OpenCodeSkillStaging, StagedOpenCodeSkills } from './skills.js';

export interface OpenCodeRunnerDependencies {
    /**
     * Stages skills, native config, and context. Required: the runner has no
     * storage of its own. The CLI passes one over the local disk; a host passes
     * one over any store that can answer the same calls.
     */
    skills: OpenCodeSkillStaging;
    /** The session driver's own dependencies: `fetch`, the server password, timeouts. */
    session?: Omit<OpenCodeSessionDependencies, 'skills'>;
    /** Reads the model catalog snapshot routes are resolved against, when preparing. */
    catalog: () => ModelCatalogSnapshot;
}

export class OpenCodeRunner extends Runner {
    readonly name = 'opencode';
    readonly displayName = 'OpenCode';
    readonly session: OpenCodeSessionAdapter;
    readonly executable = 'opencode';
    readonly runnerConfig = 'either';
    readonly standardInput = false;
    /** OpenCode keeps its credential file under its data home. */
    readonly credentials = {
        file: 'opencode/auth.json',
        apiKeyEntryType: 'api',
        storeFirst: false,
        environment: (root: string) => ({
            XDG_DATA_HOME: root,
            OPENCODE_DB: `${root}/opencode/opencode.db`,
        }),
    };
    readonly connection = openCodeConnection;
    /** The login lands in the data home, which on a worker is the member's directory. */
    override readonly workerSignIn = openCodeWorkerSignIn;
    private readonly skills: OpenCodeSkillStaging;
    private readonly catalog: () => ModelCatalogSnapshot;

    constructor(dependencies: OpenCodeRunnerDependencies) {
        super();
        this.skills = dependencies.skills;
        this.catalog = dependencies.catalog;
        this.session = new OpenCodeSessionAdapter({
            ...dependencies.session,
            skills: dependencies.skills,
        });
    }

    async prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined> = {}
    ): Promise<PreparedRunner> {
        return PreparedOpenCodeRunner.create(
            workbench,
            this.session,
            this.skills,
            this.catalog(),
            environment.CLAUDE_CODE_OAUTH_TOKEN
        );
    }
}

/** An OpenCode runner with its skills staged, ready to build invocations and start sessions. */
export class PreparedOpenCodeRunner implements PreparedRunner {
    readonly name = 'opencode';
    readonly failureLabel = 'OpenCode';
    readonly assets: RuntimeAsset[];

    readonly #workbench: ResolvedWorkbench;
    readonly #staged: StagedOpenCodeSkills;
    readonly #session: OpenCodeSessionAdapter;
    readonly #router: ModelRouter;
    /** A `claude setup-token` subscription token from the host, only for the Claude Agent route. */
    readonly #claudeToken: string | undefined;

    private constructor(options: {
        workbench: ResolvedWorkbench;
        staged: StagedOpenCodeSkills;
        session: OpenCodeSessionAdapter;
        catalog: ModelCatalogSnapshot;
        claudeToken: string | undefined;
    }) {
        this.#router = new ModelRouter(options.catalog);
        this.#claudeToken = options.claudeToken;
        this.#workbench = options.workbench;
        this.#staged = options.staged;
        this.#session = options.session;
        this.assets = [{ path: options.staged.directory, access: 'read-write' }];
    }

    static async create(
        workbench: ResolvedWorkbench,
        session: OpenCodeSessionAdapter,
        skills: OpenCodeSkillStaging,
        catalog: ModelCatalogSnapshot,
        claudeToken?: string
    ): Promise<PreparedOpenCodeRunner> {
        return new PreparedOpenCodeRunner({
            workbench,
            staged: await skills.stage(workbench),
            session,
            catalog,
            claudeToken,
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
            this.#routeEnvironment(runtime, configuration),
            runtime.pathFor(this.#staged.directory),
            runtime.workspaceDirectory,
            configuration.model,
            this.#staged.nativeConfigFile
                ? runtime.pathFor(this.#staged.nativeConfigFile)
                : undefined,
            this.#staged.context.remap((path) => runtime.pathFor(path))
        );
    }

    native(runtime: PreparedRuntime, command: string[]): RunnerInvocation {
        // Claude Code's own probe reads the login the Claude Agent route uses.
        const environment = sameCommand(command, claudeCodeConnection.probe.command)
            ? claudeAgentEnvironment(runtime.environment, runtime, this.#claudeToken)
            : runtime.environment;
        return {
            command,
            cwd: runtime.workspaceDirectory,
            env: {
                ...environment,
                ...(this.#staged.nativeConfigFile
                    ? {
                          OPENCODE_CONFIG: runtime.pathFor(
                              this.#staged.nativeConfigFile
                          ),
                      }
                    : {}),
                OPENCODE_CONFIG_DIR: runtime.pathFor(this.#staged.directory),
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
                ...(options.progress ? { progress: options.progress } : {}),
                workbench: runtime.workbench,
                workspaceDirectory: runtime.workspaceDirectory,
                environment: this.#routeEnvironment(runtime, options.configuration),
                configuration: options.configuration,
                host: options.host,
                ...(options.authentication
                    ? { authentication: options.authentication }
                    : {}),
                ...(options.session ? { session: options.session } : {}),
            },
            {
                // Cloud proxy setup and cold native session loading share this
                nativeDatabase: runtime.name === 'local',
                ...(runtime.name !== 'local' && runtime.credentials
                    ? { credentials: runtime.credentials }
                    : {}),
                // bounded readiness budget, not the ten-second local deadline.
                ...(isRemoteRuntime(runtime.name) ? { startupTimeoutMs: 60_000 } : {}),
                context: this.#staged.context.remap((path) => runtime.pathFor(path)),
                configDirectory: runtime.pathFor(this.#staged.directory),
                ...(this.#staged.nativeConfigFile
                    ? {
                          nativeConfigFile: runtime.pathFor(
                              this.#staged.nativeConfigFile
                          ),
                      }
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
        return this.#staged.cleanup();
    }

    /**
     * The selected route's environment. The Claude Agent route reaches Claude
     * Code's login instead of a provider key, where a runtime has one.
     */
    #routeEnvironment(
        runtime: PreparedRuntime,
        configuration: ResolvedRunnerConfiguration
    ): Record<string, string | undefined> {
        const environment = this.#router.environmentForRoute(
            this.#workbench,
            configuration,
            runtime.environment
        );
        if (configuration.nativeProvider !== CLAUDE_AGENT_PROVIDER) return environment;
        const unavailable = claudeAgentUnavailable(runtime.name);
        if (unavailable) throw new Error(unavailable);
        return claudeAgentEnvironment(environment, runtime, this.#claudeToken);
    }
}

function sameCommand(left: readonly string[], right: readonly string[]): boolean {
    return (
        left.length === right.length &&
        left.every((part, index) => part === right[index])
    );
}
