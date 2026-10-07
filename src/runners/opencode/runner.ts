import {
    type AuthenticatedModelRoute,
    type ModelCatalogSnapshot,
    type ModelRoute,
    ModelRouter,
    type ResolvedRunnerConfiguration,
} from '../../models/index.js';
import type { PreparedRuntime, RuntimeAsset } from '../../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import { isRemoteRuntime } from '../../workbench/runtimes.js';
import {
    assertRunnerConfiguration,
    type PreparedRunner,
    type PreparedRunnerSessionOptions,
    Runner,
    type RunnerAuthentication,
    type RunnerEventNormalizer,
} from '../runner.js';
import { OpenCodeSessionAdapter, type OpenCodeSessionDependencies } from './adapter.js';
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
    /** The model catalog snapshot routes are resolved against. */
    catalog: ModelCatalogSnapshot;
}

export class OpenCodeRunner extends Runner {
    readonly name = 'opencode';
    override get displayName(): string {
        return 'OpenCode';
    }
    readonly session: OpenCodeSessionAdapter;
    readonly authentication = openCodeAuthentication;
    private readonly skills: OpenCodeSkillStaging;
    private readonly catalog: ModelCatalogSnapshot;

    constructor(dependencies: OpenCodeRunnerDependencies) {
        super();
        this.skills = dependencies.skills;
        this.catalog = dependencies.catalog;
        this.session = new OpenCodeSessionAdapter({
            ...dependencies.session,
            skills: dependencies.skills,
        });
    }

    async prepare(workbench: ResolvedWorkbench): Promise<PreparedRunner> {
        return PreparedOpenCodeRunner.create(
            workbench,
            this.session,
            this.skills,
            this.catalog
        );
    }
}

/** An OpenCode runner with its skills staged, ready to build invocations and start sessions. */
export class PreparedOpenCodeRunner implements PreparedRunner {
    readonly authentication = openCodeAuthentication;
    readonly name = 'opencode';
    readonly failureLabel = 'OpenCode';
    readonly assets: RuntimeAsset[];

    readonly #workbench: ResolvedWorkbench;
    readonly #staged: StagedOpenCodeSkills;
    readonly #session: OpenCodeSessionAdapter;
    readonly #router: ModelRouter;

    private constructor(options: {
        workbench: ResolvedWorkbench;
        staged: StagedOpenCodeSkills;
        session: OpenCodeSessionAdapter;
        catalog: ModelCatalogSnapshot;
    }) {
        this.#router = new ModelRouter(options.catalog);
        this.#workbench = options.workbench;
        this.#staged = options.staged;
        this.#session = options.session;
        this.assets = [{ path: options.staged.directory, access: 'read-write' }];
    }

    static async create(
        workbench: ResolvedWorkbench,
        session: OpenCodeSessionAdapter,
        skills: OpenCodeSkillStaging,
        catalog: ModelCatalogSnapshot
    ): Promise<PreparedOpenCodeRunner> {
        return new PreparedOpenCodeRunner({
            workbench,
            staged: await skills.stage(workbench),
            session,
            catalog,
        });
    }

    connectionCandidates(route: ModelRoute): AuthenticatedModelRoute[] {
        return [
            {
                provider: route.provider,
                nativeProvider: route.provider,
                nativeModel: route.model,
            },
        ];
    }

    async inspectNativeConnections(
        runtime: PreparedRuntime
    ): Promise<AuthenticatedModelRoute[]> {
        const result = await runtime.execute(
            this.native(runtime, ['opencode', 'auth', 'list']),
            { network: 'none', readOnly: true }
        );
        if (result.code !== 0)
            throw new Error('OpenCode credentials could not be inspected');
        const credentials = openCodeCredentials(`${result.stdout}\n${result.stderr}`);
        return this.#router.routes(this.#workbench).flatMap((route) => {
            const method = credentials.get(normalizeProvider(route.provider));
            return method
                ? [
                      {
                          provider: route.provider,
                          nativeProvider: route.provider,
                          nativeModel: route.model,
                          authenticationMethod: method,
                      },
                  ]
                : [];
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
            this.#router.environmentForRoute(
                this.#workbench,
                configuration,
                runtime.environment
            ),
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
        return {
            command,
            cwd: runtime.workspaceDirectory,
            env: {
                ...runtime.environment,
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
                workbench: runtime.workbench,
                workspaceDirectory: runtime.workspaceDirectory,
                environment: this.#router.environmentForRoute(
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
}

const openCodeAuthentication = {
    environmentNames: [],
    providerCapabilities: (catalog) =>
        catalog.harnesses?.opencode?.versions['1.18.30']?.providers ??
        Object.fromEntries(
            Object.keys(catalog.providers).map((provider) => [
                provider,
                [{ native_provider: provider, auth: ['native'] }],
            ])
        ),
    allowEnvironment: () => true,
    nativeCredentialStore: (runtime) => runtime !== 'daytona',
    inRunAuthentication: true,
    supportsNativeAuthentication: (runtime) => runtime !== 'daytona',
    localAdvice: (provider) => `Run opencode auth login --provider ${provider}`,
    credentialEnvironment: (root) => ({ XDG_DATA_HOME: root }),
} satisfies RunnerAuthentication;

function openCodeCredentials(output: string): Map<string, string> {
    const credentials = new Map<string, string>();
    for (const line of stripTerminalControl(output)
        .split(/\r?\n/)
        .map((line) => line.trim())) {
        if (!line.startsWith('●')) continue;
        const parts = line.slice(1).trim().split(/\s+/);
        const method = parts.pop()?.toLowerCase();
        const provider = normalizeProvider(parts.join(' '));
        if (provider && method) credentials.set(provider, method);
    }
    return credentials;
}

function stripTerminalControl(value: string): string {
    // biome-ignore lint/complexity/useRegexLiterals: the literal form trips the control-character safeguard.
    return value.replaceAll(new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

function normalizeProvider(value: string): string {
    return value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}
