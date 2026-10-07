import { join } from 'node:path';

import type { RunnerInvocation, SpawnedRunner } from '../../types.js';
import { redactRunnerEnvironment } from '../output.js';
import type {
    NormalizedRunnerInput,
    RunnerAdapterDeclaration,
    RunnerInput,
    RunnerInputDelivery,
    RunnerSession,
    RunnerSessionAdapter,
    RunnerSessionStartOptions,
    RunnerTurnResult,
} from '../session.js';
import { normalizeRunnerInput, RunnerCapabilityUnsupportedError } from '../session.js';
import type { ClaudeCodeConfigStaging, StagedClaudeCodeConfig } from './config.js';
import { buildClaudeCodeInvocation } from './invocation.js';
import { ClaudeCodeProcess } from './process.js';

export const CLAUDE_CODE_SESSION_DECLARATION: RunnerAdapterDeclaration = {
    native: {
        command: 'claude',
        verified: [
            {
                version: '2.1.292',
                surfaces: ['stream-json', 'stdio-control'],
            },
        ],
    },
    capabilities: {
        streaming_text: { status: 'supported' },
        tool_events: { status: 'supported' },
        file_events: { status: 'supported' },
        usage: { status: 'supported' },
        permissions: { status: 'supported' },
        questions: { status: 'supported' },
        multi_turn: { status: 'supported' },
        steering: {
            status: 'degraded',
            detail: 'Supported on Local and Docker; E2B and Daytona accept queued follow-ups.',
        },
        image_input: { status: 'supported' },
        image_generation: {
            status: 'unsupported',
            detail: 'Workbench does not provide normalized image generation for Claude Code.',
        },
        session_resume: { status: 'supported' },
        cancellation: { status: 'supported' },
        failures: { status: 'supported' },
        unknown_events: { status: 'supported' },
    },
};

export interface ClaudeCodeSessionDependencies {
    config: ClaudeCodeConfigStaging;
    spawn?: (invocation: RunnerInvocation) => SpawnedRunner;
}

export interface PreparedClaudeCodeSession {
    staged: StagedClaudeCodeConfig;
    spawn: NonNullable<ClaudeCodeSessionDependencies['spawn']>;
    steering?: boolean;
    subprocessEnvironmentScrubbing?: boolean;
}

export class ClaudeCodeSessionAdapter implements RunnerSessionAdapter {
    readonly runner = 'claude-code';
    readonly declaration = CLAUDE_CODE_SESSION_DECLARATION;
    private readonly spawn: NonNullable<ClaudeCodeSessionDependencies['spawn']>;

    constructor(private readonly dependencies: ClaudeCodeSessionDependencies) {
        this.spawn = dependencies.spawn ?? defaultSpawn;
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        const directory = options.session
            ? join(options.session.directory, 'claude-code-config')
            : undefined;
        const staged = await this.dependencies.config.stage(
            options.workbench,
            options.environment,
            directory,
            true,
            options.workspaceDirectory
        );
        return this.startPrepared(options, { staged, spawn: this.spawn });
    }

    async startPrepared(
        options: RunnerSessionStartOptions,
        prepared: PreparedClaudeCodeSession
    ): Promise<RunnerSession> {
        for (const warning of prepared.staged.warnings) {
            await options.host.emit({
                type: 'runner.event',
                data: { native_type: 'config.warning', message: warning },
            });
        }
        return new ClaudeCodeSession(options, prepared);
    }
}

class ClaudeCodeSession implements RunnerSession {
    private nativeSessionId: string;
    private recordedSessionId: string | undefined;
    private process: ClaudeCodeProcess | undefined;
    private active: Promise<RunnerTurnResult> | undefined;
    private closed = false;
    private initialSessionIdUsed = false;

    constructor(
        private readonly options: RunnerSessionStartOptions,
        private readonly prepared: PreparedClaudeCodeSession
    ) {
        this.nativeSessionId = options.session?.nativeSessionId ?? crypto.randomUUID();
        this.recordedSessionId = options.session?.nativeSessionId;
    }

    get id(): string | undefined {
        return this.nativeSessionId;
    }

    prompt(input: RunnerInput): Promise<RunnerTurnResult> {
        if (this.closed) return Promise.reject(new Error('runner session is closed'));
        if (this.active) {
            return Promise.reject(
                new Error('runner session is already processing a turn')
            );
        }
        const normalized = normalizeRunnerInput(input);
        const turn = this.runTurn(normalized);
        this.active = turn;
        return turn.finally(() => {
            if (this.active === turn) this.active = undefined;
        });
    }

    async cancelTurn(): Promise<void> {
        const process = this.process;
        if (!this.active || !process) return;
        await process.cancel();
        if (!process.running && this.process === process) this.process = undefined;
    }

    steer(input: RunnerInput): Promise<RunnerInputDelivery> {
        if (this.prepared.steering === false) {
            return Promise.reject(
                new RunnerCapabilityUnsupportedError(
                    'Claude Code steering is not supported on this runtime'
                )
            );
        }
        if (!this.active || !this.process) {
            return Promise.reject(new Error('runner session is not processing a turn'));
        }
        return this.process.steer(input);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.process?.close();
            await this.active?.catch(() => undefined);
        } finally {
            await this.prepared.staged.cleanup();
        }
    }

    private async runTurn(input: NormalizedRunnerInput): Promise<RunnerTurnResult> {
        if (!this.process?.running) this.process = this.startProcess();
        return this.process.prompt(input);
    }

    private startProcess(): ClaudeCodeProcess {
        const resume = Boolean(this.recordedSessionId);
        if (this.initialSessionIdUsed) {
            this.nativeSessionId = this.recordedSessionId ?? crypto.randomUUID();
        }
        const session = this.options.session
            ? {
                  ...this.options.session,
                  nativeSessionId: this.nativeSessionId,
              }
            : {
                  id: this.nativeSessionId,
                  directory: this.prepared.staged.directory,
                  nativeSessionId: this.nativeSessionId,
              };
        const invocation = buildClaudeCodeInvocation(
            this.options.workbench,
            this.options.environment,
            this.options.workspaceDirectory,
            this.options.configuration,
            this.prepared.staged,
            session,
            resume,
            this.options.answerRequests ?? true,
            this.prepared.subprocessEnvironmentScrubbing ?? false
        );
        this.initialSessionIdUsed = true;
        const process = new ClaudeCodeProcess({
            invocation,
            spawn: this.prepared.spawn,
            emit: (event) => this.options.host.emit(event),
            sessionId: (id) => {
                this.nativeSessionId = id;
                this.recordedSessionId = id;
            },
            host: this.options.host,
            answerRequests: this.options.answerRequests ?? true,
            redact: (value) => redactRunnerEnvironment(value, this.options.environment),
            reportNativeCost:
                this.options.configuration.authenticationMethod !== 'oauth',
        });
        process.start();
        return process;
    }
}

function defaultSpawn(invocation: RunnerInvocation): SpawnedRunner {
    return Bun.spawn(invocation.command, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
    });
}
