import {
    type ModelCatalogSnapshot,
    ModelRouter,
    type ResolvedRunnerConfiguration,
} from '../../models/index.js';
import { join } from '../../platform/paths.js';
import type { PreparedRuntime, RuntimeAsset } from '../../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import {
    assertRunnerConfiguration,
    type PreparedRunner,
    type PreparedRunnerSessionOptions,
    Runner,
    type RunnerEventNormalizer,
} from '../runner.js';
import {
    normalizeRunnerInput,
    type RunnerSession,
    type RunnerSessionStartOptions,
} from '../session.js';
import type { ClaudeCodeConfigStaging, StagedClaudeCodeConfig } from './config.js';
import { claudeCodeConnection } from './connection.js';
import { ClaudeCodeCost, runtimeCostStore } from './cost.js';
import { ClaudeCodeEventAdapter } from './events.js';
import {
    buildClaudeCodeInvocation,
    inSessionConfig,
    withInput,
    withoutClaudeVariables,
} from './invocation.js';
import { type ClaudeCodeSpawn, executeOnHost } from './process.js';
import { type ClaudeCodeRoute, claudeCodeRoute } from './routes.js';
import {
    ClaudeCodeSessionAdapter,
    defaultSpawn,
    type PreparedClaudeCodeSession,
    userMessage,
} from './session.js';

export interface ClaudeCodeRunnerDependencies {
    /** Stages the config directory. The CLI passes one over the local disk. */
    config: ClaudeCodeConfigStaging;
    /** Reads the model catalog snapshot routes are resolved against, when preparing. */
    catalog: () => ModelCatalogSnapshot;
    /** The host platform. Subprocess scrubbing needs macOS on the local runtime. */
    platform?: NodeJS.Platform;
}

export class ClaudeCodeRunner extends Runner {
    readonly name = 'claude-code';
    readonly displayName = 'Claude Code';
    readonly session: ClaudeCodeSessionAdapter;
    readonly executable = 'claude';
    /** A `runner_config` is one JSON file of permission rules and a turn limit. */
    readonly runnerConfig = 'file';
    /** A Claude Code session takes its input over piped standard input. */
    readonly standardInput = true;
    readonly connection = claudeCodeConnection;
    /** A `claude setup-token` subscription token, taken from the person's own environment on any runtime. */
    override readonly nativeCredentialVariables = ['CLAUDE_CODE_OAUTH_TOKEN'];

    constructor(private readonly dependencies: ClaudeCodeRunnerDependencies) {
        super();
        // A session started without a runtime runs on this host.
        this.session = new ClaudeCodeSessionAdapter({
            prepare: async (options) => {
                const runner = await PreparedClaudeCodeRunner.create(
                    options.workbench,
                    options.environment,
                    this.session,
                    dependencies
                );
                try {
                    return {
                        session: await runner.hostSession(options),
                        cleanup: () => runner.cleanup(),
                    };
                } catch (error) {
                    await runner.cleanup();
                    throw error;
                }
            },
        });
    }

    prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<PreparedRunner> {
        return PreparedClaudeCodeRunner.create(
            workbench,
            environment,
            this.session,
            this.dependencies
        );
    }
}

/** Where a session runs: a prepared runtime, or this host. */
type ClaudeCodeTarget = Pick<
    PreparedRuntime,
    | 'name'
    | 'workbench'
    | 'workspaceDirectory'
    | 'environment'
    | 'workspaces'
    | 'pathFor'
    | 'execute'
>;

/** The config directory inside a session's state that keeps the native session. */
const SESSION_CONFIG = 'claude-code';

/** The runner-owned file in the config directory that records the cumulative cost. */
const COST_FILE = 'workbench-cost.json';

/** A Claude Code runner with its config staged, ready to build invocations and start sessions. */
export class PreparedClaudeCodeRunner implements PreparedRunner {
    readonly name = 'claude-code';
    readonly failureLabel = 'Claude Code';
    readonly assets: RuntimeAsset[];

    readonly #workbench: ResolvedWorkbench;
    readonly #staged: StagedClaudeCodeConfig;
    readonly #staging: ClaudeCodeConfigStaging;
    readonly #session: ClaudeCodeSessionAdapter;
    readonly #router: ModelRouter;
    /** The host environment, the only source of a subscription token. */
    readonly #host: Record<string, string | undefined>;
    readonly #platform: NodeJS.Platform;
    #repositoryRead = false;
    /** How the route of the last built invocation is paid, for its event normalizer. */
    #billing: ClaudeCodeRoute['billing'] = 'metered';

    private constructor(options: {
        workbench: ResolvedWorkbench;
        staged: StagedClaudeCodeConfig;
        staging: ClaudeCodeConfigStaging;
        session: ClaudeCodeSessionAdapter;
        catalog: ModelCatalogSnapshot;
        host: Record<string, string | undefined>;
        platform: NodeJS.Platform;
    }) {
        this.#workbench = options.workbench;
        this.#staged = options.staged;
        this.#staging = options.staging;
        this.#session = options.session;
        this.#router = new ModelRouter(options.catalog);
        this.#host = options.host;
        this.#platform = options.platform;
        this.assets = [{ path: options.staged.configDirectory, access: 'read-write' }];
    }

    static async create(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>,
        session: ClaudeCodeSessionAdapter,
        dependencies: ClaudeCodeRunnerDependencies
    ): Promise<PreparedClaudeCodeRunner> {
        return new PreparedClaudeCodeRunner({
            workbench,
            staged: await dependencies.config.stage({ workbench, environment }),
            staging: dependencies.config,
            session,
            catalog: dependencies.catalog(),
            host: environment,
            platform: dependencies.platform ?? process.platform,
        });
    }

    /**
     * Workbench runs Claude Code as a session. This is the same launch for a
     * new native session that nobody answers, with the task as its only input:
     * one stream-json line on standard input, like a session prompt.
     */
    build(
        runtime: PreparedRuntime,
        task: string,
        configuration: ResolvedRunnerConfiguration
    ): RunnerInvocation {
        assertRunnerConfiguration(this.#workbench, configuration);
        const configDirectory = runtime.pathFor(this.#staged.configDirectory);
        const route = this.#route(runtime, configuration, configDirectory);
        this.#billing = route.billing;
        const invocation = this.#invocation(runtime, configuration, {
            configDirectory,
            route,
            answersPrompts: false,
            session: { id: crypto.randomUUID(), resume: false },
        });
        const line = JSON.stringify(
            userMessage(crypto.randomUUID(), normalizeRunnerInput(task))
        );
        return this.#withContext(runtime, withInput(invocation, line));
    }

    /** A native command against the staged config, such as the credential probe. */
    native(runtime: PreparedRuntime, command: string[]): RunnerInvocation {
        const configDirectory = runtime.pathFor(this.#staged.configDirectory);
        const token = this.#host.CLAUDE_CODE_OAUTH_TOKEN?.trim();
        return {
            command,
            cwd: runtime.workspaceDirectory,
            env: {
                ...withoutClaudeVariables(runtime.environment),
                CLAUDE_CONFIG_DIR: configDirectory,
                // Only the host can hold the person's login.
                CLAUDE_SECURESTORAGE_CONFIG_DIR:
                    runtime.name === 'local' ? '' : configDirectory,
                ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
            },
        };
    }

    publicInvocation(invocation: RunnerInvocation): Record<string, unknown> {
        return {
            command: invocation.command,
            cwd: invocation.cwd,
            claude_config_directory: invocation.env.CLAUDE_CONFIG_DIR ?? null,
        };
    }

    events(): RunnerEventNormalizer {
        return new ClaudeCodeEventAdapter({
            cost: ClaudeCodeCost.fresh(this.#billing),
        });
    }

    async startSession(
        runtime: PreparedRuntime,
        options: PreparedRunnerSessionOptions
    ): Promise<RunnerSession> {
        assertRunnerConfiguration(this.#workbench, options.configuration);
        const start = this.#startOptions(runtime, options);
        const prepared = await this.#prepareSession(runtime, start, (invocation) => {
            const process = runtime.launchSession(invocation, { stdin: 'pipe' });
            const input = process.stdin;
            if (!input) {
                runtime.cancel(process);
                throw new Error('Runtime did not expose Claude Code session input');
            }
            return {
                exited: process.exited,
                stdin: {
                    write: (value) => input.write(value),
                    ...(input.flush ? { flush: () => input.flush?.() } : {}),
                    ...(input.end ? { end: () => input.end?.() } : {}),
                },
                ...(process.stdout ? { stdout: process.stdout } : {}),
                ...(process.stderr ? { stderr: process.stderr } : {}),
                kill: () => runtime.cancel(process),
            };
        });
        return this.#session.startPrepared(start, prepared);
    }

    /** A session on this host, for an adapter started without a runtime. */
    hostSession(
        options: RunnerSessionStartOptions
    ): Promise<PreparedClaudeCodeSession> {
        assertRunnerConfiguration(this.#workbench, options.configuration);
        const host: ClaudeCodeTarget = {
            name: 'local',
            workbench: options.workbench,
            workspaceDirectory: options.workspaceDirectory,
            environment: options.environment,
            workspaces: [],
            pathFor: (path) => path,
            execute: executeOnHost,
        };
        return this.#prepareSession(host, options, (invocation) =>
            defaultSpawn(invocation.command, {
                cwd: invocation.cwd,
                env: invocation.env,
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
            })
        );
    }

    cleanup(): Promise<void> {
        return this.#staged.cleanup();
    }

    #startOptions(
        runtime: PreparedRuntime,
        options: PreparedRunnerSessionOptions
    ): RunnerSessionStartOptions {
        return {
            workbench: runtime.workbench,
            workspaceDirectory: runtime.workspaceDirectory,
            environment: this.#router.environmentForRoute(
                this.#workbench,
                options.configuration,
                runtime.environment
            ),
            configuration: options.configuration,
            host: options.host,
            ...(options.session ? { session: options.session } : {}),
        };
    }

    /**
     * Resolves the route, settings, cost, and launch of one session. With a
     * Workbench session, the config directory lives in its state, so the native
     * transcripts and cumulative cost survive for a resumed process.
     */
    async #prepareSession(
        target: ClaudeCodeTarget,
        options: RunnerSessionStartOptions,
        launch: (invocation: RunnerInvocation) => ReturnType<ClaudeCodeSpawn>
    ): Promise<PreparedClaudeCodeSession> {
        const staged = this.#staged;
        const configDirectory = options.session
            ? join(options.session.directory, SESSION_CONFIG)
            : target.pathFor(staged.configDirectory);
        const route = this.#route(target, options.configuration, configDirectory);
        await this.#readRepository(target);
        const access = this.#access(target);
        for (const message of [...staged.warnings, ...access.warnings]) {
            await options.host.emit({
                type: 'runner.event',
                data: { native_type: 'warning', message },
            });
        }
        const cost = options.session
            ? await ClaudeCodeCost.open(
                  route.billing,
                  runtimeCostStore(target, join(configDirectory, COST_FILE))
              )
            : ClaudeCodeCost.fresh(route.billing);
        const skills = target.pathFor(staged.skillsDirectory);
        return {
            paths: this.#paths(target, configDirectory),
            settings: access.settings,
            additionalDirectories: access.directories,
            routeEnvironment: route.environment,
            secureStorageDirectory: route.secureStorageDirectory,
            scrubSubprocessEnvironment: this.#scrubs(target),
            answersPrompts: true,
            maxTurns: staged.maxTurns,
            cost,
            spawn: (command, spawnOptions) =>
                launch(
                    this.#withContext(
                        target,
                        options.session
                            ? inSessionConfig(
                                  {
                                      command,
                                      cwd: spawnOptions.cwd,
                                      env: spawnOptions.env,
                                  },
                                  skills
                              )
                            : { command, cwd: spawnOptions.cwd, env: spawnOptions.env }
                    )
                ),
        };
    }

    #invocation(
        target: ClaudeCodeTarget,
        configuration: ResolvedRunnerConfiguration,
        options: {
            configDirectory: string;
            route: ClaudeCodeRoute;
            answersPrompts: boolean;
            session: { id: string; resume: boolean };
        }
    ): RunnerInvocation {
        const access = this.#access(target);
        return buildClaudeCodeInvocation({
            workspaceDirectory: target.workspaceDirectory,
            environment: this.#router.environmentForRoute(
                this.#workbench,
                configuration,
                target.environment
            ),
            routeEnvironment: options.route.environment,
            model: configuration.nativeModel,
            paths: this.#paths(target, options.configDirectory),
            settings: access.settings,
            additionalDirectories: access.directories,
            answersPrompts: options.answersPrompts,
            session: options.session,
            maxTurns: this.#staged.maxTurns,
            secureStorageDirectory: options.route.secureStorageDirectory,
            scrubSubprocessEnvironment: this.#scrubs(target),
        });
    }

    #route(
        target: Pick<ClaudeCodeTarget, 'name' | 'environment'>,
        configuration: ResolvedRunnerConfiguration,
        configDirectory: string
    ): ClaudeCodeRoute {
        return claudeCodeRoute({
            provider: configuration.provider,
            runtime: target.name,
            environment: this.#router.environmentForRoute(
                this.#workbench,
                configuration,
                target.environment
            ),
            keys: this.#router.catalog.providers[configuration.provider]?.env ?? [],
            oauthToken: this.#host.CLAUDE_CODE_OAUTH_TOKEN,
            authenticationMethod: configuration.authenticationMethod,
            configDirectory,
        });
    }

    /**
     * The outbox and named workspaces lie outside the working directory, so a
     * launch adds them as directories and grants them by file rules. Their
     * paths are known only once the runtime is prepared.
     */
    #access(target: ClaudeCodeTarget): {
        settings: string;
        directories: string[];
        warnings: string[];
    } {
        const outbox = target.environment.WORKBENCH_OUTPUT_DIR;
        const settings = this.#staged.settings({
            outbox,
            workspaces: target.workspaces,
        });
        return {
            settings: settings.text,
            directories: [
                ...(outbox ? [outbox] : []),
                ...target.workspaces.map((binding) => binding.path),
            ],
            warnings: settings.warnings,
        };
    }

    #paths(target: ClaudeCodeTarget, configDirectory: string) {
        return {
            configDirectory,
            mcpConfigPath: target.pathFor(this.#staged.mcpConfigPath),
            systemPromptPath: target.pathFor(this.#staged.systemPromptPath),
        };
    }

    /** Subprocess scrubbing needs bubblewrap on Linux, so it is on only for local macOS. */
    #scrubs(target: ClaudeCodeTarget): boolean {
        return target.name === 'local' && this.#platform === 'darwin';
    }

    /**
     * Repository `CLAUDE.md` files are read from the host. Only the local
     * runtime's workspace is a host path the runner knows; other runtimes skip
     * them, as the capability table documents.
     */
    async #readRepository(target: ClaudeCodeTarget): Promise<void> {
        if (this.#repositoryRead || target.name !== 'local') return;
        this.#repositoryRead = true;
        await this.#staging.addRepositoryInstructions(
            this.#staged,
            target.workspaceDirectory
        );
    }

    /** Writes the system prompt with fresh runtime facts at every launch. */
    #withContext(
        target: ClaudeCodeTarget,
        invocation: RunnerInvocation
    ): RunnerInvocation {
        return this.#staged.context
            .remap((path) => target.pathFor(path))
            .apply(invocation, target.workbench);
    }
}
