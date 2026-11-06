import type {
    RunnerSession,
    RunnerSessionAdapter,
    RunnerSessionStartOptions,
} from '../session.js';
import { CLAUDE_CODE_SESSION_DECLARATION } from './capabilities.js';
import type { ClaudeCodeCost } from './cost.js';
import type { ClaudeCodeStagedPaths } from './invocation.js';
import type { OpenRouterAccess } from './openrouter.js';
import { type ClaudeCodeSpawn, defaultSpawn } from './process.js';
import { ClaudeCodeSession } from './session.js';

/** What a session needs from staging, routing, and the runtime before it starts. */
export interface PreparedClaudeCodeSession {
    paths: ClaudeCodeStagedPaths;
    /** The `--settings` value: a settings file or its JSON text. */
    settings: string;
    /** Directories outside the workspace the tools may reach. */
    additionalDirectories?: string[] | undefined;
    /** The credential and route variables of the selected connection. */
    routeEnvironment: Record<string, string>;
    /** The key the host reads each generation's OpenRouter charge with. */
    openRouterKey?: string | undefined;
    secureStorageDirectory: string;
    scrubSubprocessEnvironment: boolean;
    /** The host answers permissions and questions. Otherwise they are denied. */
    answersPrompts: boolean;
    maxTurns?: number | undefined;
    /** Per-turn cost from the native cumulative total. Without it, a fresh metered count. */
    cost?: ClaudeCodeCost | undefined;
    /** How this session's child starts, such as inside a runtime. Defaults to the adapter's. */
    spawn?: ClaudeCodeSpawn | undefined;
}

export interface ClaudeCodeSessionDependencies {
    /** Prepares a session the adapter starts itself with `start`. */
    prepare(options: RunnerSessionStartOptions): Promise<{
        session: PreparedClaudeCodeSession;
        cleanup(): Promise<void>;
    }>;
    spawn?: ClaudeCodeSpawn;
    /** How long a stopping child has after SIGTERM before SIGKILL. */
    stopTimeoutMs?: number;
    /** How the host reads what OpenRouter charged for each turn. */
    openRouter: OpenRouterAccess;
}

export class ClaudeCodeSessionAdapter implements RunnerSessionAdapter {
    readonly runner = 'claude-code';
    readonly declaration = CLAUDE_CODE_SESSION_DECLARATION;
    private readonly spawn: ClaudeCodeSpawn;
    private readonly stopTimeoutMs: number;

    constructor(private readonly dependencies: ClaudeCodeSessionDependencies) {
        this.spawn = dependencies.spawn ?? defaultSpawn;
        this.stopTimeoutMs = dependencies.stopTimeoutMs ?? 5_000;
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        const prepared = await this.dependencies.prepare(options);
        return this.open(options, prepared.session, () => prepared.cleanup());
    }

    startPrepared(
        options: RunnerSessionStartOptions,
        prepared: PreparedClaudeCodeSession
    ): Promise<RunnerSession> {
        return this.open(options, prepared, async () => {});
    }

    private async open(
        options: RunnerSessionStartOptions,
        prepared: PreparedClaudeCodeSession,
        cleanup: () => Promise<void>
    ): Promise<RunnerSession> {
        const session = new ClaudeCodeSession(
            options,
            prepared,
            {
                spawn: this.spawn,
                stopTimeoutMs: this.stopTimeoutMs,
                openRouter: this.dependencies.openRouter,
            },
            cleanup
        );
        try {
            await session.start();
            return session;
        } catch (error) {
            await session.close().catch(() => {});
            throw error;
        }
    }
}
