import type { RuntimeProcessHandle } from '../../types.js';
import type { RunnerContext } from '../context/files.js';
import type {
    RunnerAdapterDeclaration,
    RunnerSession,
    RunnerSessionAdapter,
    RunnerSessionStartOptions,
} from '../session.js';
import type { PiConfigStaging } from './config.js';
import { PI_PACKAGE_VERSION } from './providers.js';
import { PiRpcSession } from './session.js';

export const PI_SESSION_DECLARATION: RunnerAdapterDeclaration = {
    native: {
        command: 'pi',
        verified: [
            { version: PI_PACKAGE_VERSION, surfaces: ['json', 'rpc'] },
            { version: '1.5.0', surfaces: ['rpc'] },
        ],
    },
    capabilities: {
        streaming_text: { status: 'supported' },
        tool_events: { status: 'supported' },
        file_events: { status: 'supported' },
        usage: { status: 'supported' },
        permissions: {
            status: 'unsupported',
            detail: 'Pi does not provide a native permission request protocol.',
        },
        questions: {
            status: 'supported',
            detail: 'Questions come from Pi extensions through native RPC dialogs.',
        },
        multi_turn: { status: 'supported' },
        steering: { status: 'supported' },
        image_input: { status: 'supported' },
        image_generation: {
            status: 'unsupported',
            detail: 'Workbench does not yet provide a normalized image-generation tool or image output event for Pi.',
        },
        session_resume: { status: 'supported' },
        cancellation: { status: 'supported' },
        failures: { status: 'supported' },
        unknown_events: { status: 'supported' },
    },
};

export interface PiInput {
    write(value: string): unknown;
    flush?(): unknown;
    end?(): void | Promise<void>;
}

export interface SpawnedPi {
    handle?: Promise<RuntimeProcessHandle | undefined>;
    exited: Promise<number>;
    stdin: PiInput;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    kill(): void;
}

export interface PiSessionDependencies {
    /** Stages config and context for a session the adapter starts itself with `start`. */
    config: PiConfigStaging;
    spawn?: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'pipe';
            stdout: 'pipe';
            stderr: 'pipe';
        }
    ) => SpawnedPi;
    startupTimeoutMs?: number;
}

export interface PreparedPiSession {
    context?: RunnerContext;
    configDirectory: string;
    spawn: NonNullable<PiSessionDependencies['spawn']>;
}

export class PiSessionAdapter implements RunnerSessionAdapter {
    readonly runner = 'pi';
    readonly declaration = PI_SESSION_DECLARATION;
    private readonly dependencies: Required<Omit<PiSessionDependencies, 'config'>>;
    private readonly config: PiConfigStaging;

    constructor(dependencies: PiSessionDependencies) {
        this.config = dependencies.config;
        this.dependencies = {
            spawn: dependencies.spawn ?? defaultSpawn,
            startupTimeoutMs: dependencies.startupTimeoutMs ?? 10_000,
        };
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        const staged = await this.config.stage(
            options.workbench,
            options.environment,
            {}
        );
        return this.startConfigured(
            options,
            {
                context: staged.context,
                configDirectory: staged.directory,
                spawn: this.dependencies.spawn,
            },
            () => staged.cleanup()
        );
    }

    startPrepared(
        options: RunnerSessionStartOptions,
        prepared: PreparedPiSession
    ): Promise<RunnerSession> {
        return this.startConfigured(options, prepared, async () => {});
    }

    private async startConfigured(
        options: RunnerSessionStartOptions,
        prepared: PreparedPiSession,
        cleanup: () => Promise<void>
    ): Promise<RunnerSession> {
        const session = new PiRpcSession({
            ...options,
            ...this.dependencies,
            ...prepared,
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

function defaultSpawn(
    command: string[],
    options: Parameters<NonNullable<PiSessionDependencies['spawn']>>[1]
): SpawnedPi {
    return Bun.spawn(command, options) as unknown as SpawnedPi;
}
