import { join } from 'node:path';

import {
    type ModelCatalogSnapshot,
    type ModelRoute,
    ModelRouter,
    type ResolvedRunnerConfiguration,
} from '../../models/index.js';
import type { PreparedRuntime, RuntimeAsset } from '../../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import {
    assertRunnerConfiguration,
    type PreparedRunner,
    type PreparedRunnerSessionOptions,
    Runner,
    type RunnerEventNormalizer,
    type RunnerPrepareOptions,
} from '../runner.js';
import {
    CLAUDE_CODE_AUTHENTICATION,
    inspectClaudeCodeAuthentication,
} from './authentication.js';
import type { ClaudeCodeConfigStaging, StagedClaudeCodeConfig } from './config.js';
import { ClaudeCodeEventAdapter } from './events.js';
import { buildClaudeCodeInvocation, publicClaudeCodeInvocation } from './invocation.js';
import { ClaudeCodeSessionAdapter } from './session.js';

export class ClaudeCodeRunner extends Runner {
    readonly name = 'claude-code';
    override get displayName(): string {
        return 'Claude Code';
    }
    readonly session: ClaudeCodeSessionAdapter;
    readonly authentication = CLAUDE_CODE_AUTHENTICATION;

    constructor(
        private readonly config: ClaudeCodeConfigStaging,
        private readonly catalog: ModelCatalogSnapshot
    ) {
        super();
        this.session = new ClaudeCodeSessionAdapter({ config });
    }

    async prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>,
        options?: RunnerPrepareOptions
    ): Promise<PreparedRunner> {
        const directory = options?.session
            ? join(options.session.directory, 'claude-code-config')
            : undefined;
        return new PreparedClaudeCodeRunner(
            workbench,
            await this.config.stage(
                workbench,
                environment,
                directory,
                options?.includeRuntimeDirectories ?? false,
                options?.workspaceDirectory
            ),
            Boolean(options?.session),
            options?.workspaceDirectory ?? workbench.repositoryDirectory,
            this.config,
            this.session,
            this.catalog
        );
    }
}

class PreparedClaudeCodeRunner implements PreparedRunner {
    readonly name = 'claude-code';
    readonly nativeCommand = 'claude';
    readonly nativeVersion = { minimum: '2.1.292' };
    readonly authentication = CLAUDE_CODE_AUTHENTICATION;
    readonly failureLabel = 'Claude Code';
    readonly assets: RuntimeAsset[];
    readonly stateOverlay = [
        'claude-code-config/skills',
        'claude-code-config/settings.json',
        'claude-code-config/mcp.json',
        'claude-code-config/.workbench-context',
    ];
    private staged: StagedClaudeCodeConfig;
    private reportNativeCost = true;
    readonly #router: ModelRouter;

    constructor(
        private readonly workbench: ResolvedWorkbench,
        staged: StagedClaudeCodeConfig,
        private readonly sessionScoped: boolean,
        private readonly workspaceDirectory: string,
        private readonly config: ClaudeCodeConfigStaging,
        private readonly session: ClaudeCodeSessionAdapter,
        catalog: ModelCatalogSnapshot
    ) {
        this.staged = staged;
        this.#router = new ModelRouter(catalog);
        this.assets = sessionScoped
            ? []
            : [{ path: staged.directory, access: 'read-write' }];
    }

    get permissions(): { allow: string[]; deny: string[] } {
        return this.staged.permissions;
    }

    get warnings(): string[] {
        return this.staged.warnings;
    }

    connectionCandidates(route: ModelRoute) {
        return this.authentication.providerCapabilities(this.#router.catalog)[
            route.provider
        ]
            ? [
                  {
                      provider: route.provider,
                      nativeProvider: route.provider,
                      nativeModel: route.model,
                  },
              ]
            : [];
    }

    async inspectNativeConnections(runtime: PreparedRuntime) {
        const status = await inspectClaudeCodeAuthentication(runtime, this);
        if (!status.loggedIn) return [];
        return this.#router
            .routes(this.workbench)
            .filter((route) => route.provider === 'anthropic')
            .map((route) => ({
                provider: route.provider,
                nativeProvider: route.provider,
                nativeModel: route.model,
                ...(status.authenticationMethod
                    ? { authenticationMethod: status.authenticationMethod }
                    : {}),
            }));
    }

    async configureRuntime(runtime: PreparedRuntime): Promise<void> {
        this.staged = await this.config.stage(
            this.workbench,
            runtime.environment,
            this.staged.directory,
            true,
            this.workspaceDirectory,
            this.sessionScoped
        );
    }

    build(
        runtime: PreparedRuntime,
        _task: string,
        configuration: ResolvedRunnerConfiguration
    ): RunnerInvocation {
        assertRunnerConfiguration(this.workbench, configuration);
        const environment = this.routeEnvironment(configuration, runtime.environment);
        this.reportNativeCost = configuration.authenticationMethod !== 'oauth';
        return buildClaudeCodeInvocation(
            this.workbench,
            environment,
            runtime.workspaceDirectory,
            configuration,
            this.staged.remap((path) => runtime.pathFor(path)),
            undefined,
            false,
            false,
            runtime.subprocessEnvironmentScrubbing ?? false
        );
    }

    native(runtime: PreparedRuntime, command: string[]): RunnerInvocation {
        return {
            command,
            cwd: runtime.workspaceDirectory,
            env: { ...runtime.environment },
        };
    }

    publicInvocation(invocation: RunnerInvocation): Record<string, unknown> {
        return publicClaudeCodeInvocation(invocation);
    }

    events(): RunnerEventNormalizer {
        return new ClaudeCodeEventAdapter(0, this.reportNativeCost);
    }

    async startSession(
        runtime: PreparedRuntime,
        options: PreparedRunnerSessionOptions
    ) {
        assertRunnerConfiguration(this.workbench, options.configuration);
        const environment = this.routeEnvironment(
            options.configuration,
            runtime.environment
        );
        return this.session.startPrepared(
            {
                workbench: this.workbench,
                workspaceDirectory: runtime.workspaceDirectory,
                environment,
                configuration: options.configuration,
                host: options.host,
                ...(options.answerRequests !== undefined
                    ? { answerRequests: options.answerRequests }
                    : {}),
                ...(options.session ? { session: options.session } : {}),
            },
            {
                staged: this.staged.remap((path) => runtime.pathFor(path)),
                steering: runtime.name === 'local' || runtime.name === 'docker',
                subprocessEnvironmentScrubbing:
                    runtime.subprocessEnvironmentScrubbing ?? false,
                spawn: (invocation) =>
                    runtime.launchSession(invocation, { stdin: 'pipe' }),
            }
        );
    }

    cleanup(): Promise<void> {
        return this.staged.cleanup();
    }

    private routeEnvironment(
        configuration: ResolvedRunnerConfiguration,
        environment: Record<string, string | undefined>
    ): Record<string, string | undefined> {
        const route = this.#router.environmentForRoute(
            this.workbench,
            configuration,
            environment
        );
        if (configuration.authenticationMethod !== 'oauth') return { ...route };
        const providerEnvironment = new Set(
            this.#router.catalog.providers[configuration.provider]?.env ?? []
        );
        return Object.fromEntries(
            Object.entries(route).filter(([name]) => !providerEnvironment.has(name))
        );
    }
}
