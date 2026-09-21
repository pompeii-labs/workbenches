import type { RunnerContextFiles } from '../context.js';

import type {
    RunnerSession,
    RunnerSessionAdapter,
    RunnerSessionStartOptions,
} from '../session.js';
import { stageOpenCodeSkills } from './assets.js';
import { OPENCODE_SESSION_DECLARATION } from './capabilities.js';
import {
    launchLocalOpenCodeServer,
    type OpenCodeFetch,
    type OpenCodeServerLauncher,
    type SpawnedOpenCodeServer,
    spawnOpenCodeServer,
} from './server.js';
import { OpenCodeServerSession } from './session.js';

export interface OpenCodeSessionDependencies {
    spawn?: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'ignore';
            stdout: 'pipe';
            stderr: 'pipe';
        }
    ) => SpawnedOpenCodeServer;
    fetch?: OpenCodeFetch;
    password?: () => string;
    startupTimeoutMs?: number;
    authenticationTimeoutMs?: number;
}

export interface PreparedOpenCodeSession {
    context?: RunnerContextFiles;
    configDirectory?: string;
    nativeConfigFile?: string;
    startupTimeoutMs?: number;
    launch: OpenCodeServerLauncher;
}

export class OpenCodeSessionAdapter implements RunnerSessionAdapter {
    readonly runner = 'opencode';
    readonly declaration = OPENCODE_SESSION_DECLARATION;
    private readonly dependencies: Required<OpenCodeSessionDependencies>;

    constructor(dependencies: OpenCodeSessionDependencies = {}) {
        this.dependencies = {
            spawn: dependencies.spawn ?? spawnOpenCodeServer,
            fetch: dependencies.fetch ?? globalThis.fetch,
            password: dependencies.password ?? (() => crypto.randomUUID()),
            startupTimeoutMs: dependencies.startupTimeoutMs ?? 10_000,
            authenticationTimeoutMs:
                dependencies.authenticationTimeoutMs ?? 10 * 60_000,
        };
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        const staged = await stageOpenCodeSkills(options.workbench);
        const nativeConfigFile = staged.nativeConfigFile;
        return this.startConfigured(
            options,
            {
                context: staged.context,
                ...(staged?.directory ? { configDirectory: staged.directory } : {}),
                ...(nativeConfigFile ? { nativeConfigFile } : {}),
                launch: launchLocalOpenCodeServer(this.dependencies.spawn),
            },
            staged?.cleanup ?? (async () => {})
        );
    }

    startPrepared(
        options: RunnerSessionStartOptions,
        prepared: PreparedOpenCodeSession
    ): Promise<RunnerSession> {
        return this.startConfigured(options, prepared, async () => {});
    }

    private async startConfigured(
        options: RunnerSessionStartOptions,
        prepared: PreparedOpenCodeSession,
        cleanup: () => Promise<void>
    ): Promise<RunnerSession> {
        const startupTimeoutMs =
            prepared.startupTimeoutMs ?? this.dependencies.startupTimeoutMs;
        const session = new OpenCodeServerSession({
            ...options,
            ...this.dependencies,
            ...prepared,
            startupTimeoutMs,
            authenticationTimeoutMs: this.dependencies.authenticationTimeoutMs,
            cleanup,
        });
        try {
            await session.start();
            return session;
        } catch (error) {
            await session.close().catch(() => {});
            throw error;
        }
    }
}
