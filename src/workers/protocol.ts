import type { WorkbenchEvent } from '../runs/events.js';
import type { HostGpu } from '../workbench/gpus.js';

/** The worker protocol version this engine speaks in `hello`. */
export const WORKER_PROTOCOL = 1;

/** Close codes the server ends a worker connection with. Others reconnect. */
export const WORKER_CLOSE_CODES = {
    revoked: 4001,
    replaced: 4002,
    unsupported: 4003,
} as const;

export const WORKER_RUNTIMES = ['docker', 'local'] as const;
export type WorkerRuntime = (typeof WORKER_RUNTIMES)[number];

export interface WorkerMachine {
    os: string;
    arch: string;
    cpus: number;
    memory_gb: number;
    /** At most 64, as GPU discovery found them. */
    gpus: HostGpu[];
    docker: { version: string } | null;
    runners: Array<{ name: string; version: string }>;
}

export interface RunCursor {
    run_id: string;
    sequence: number;
}

export type WorkerMessage =
    | {
          type: 'hello';
          protocol: typeof WORKER_PROTOCOL;
          wb_version: string;
          machine: WorkerMachine;
          runtimes: WorkerRuntime[];
          slots: number;
          runs: RunCursor[];
      }
    | { type: 'run.accepted'; run_id: string }
    | { type: 'run.rejected'; run_id: string; reason: string }
    | { type: 'events'; run_id: string; events: WorkbenchEvent[] }
    | {
          type: 'command.done';
          command_id: string;
          status: 'delivered' | 'rejected';
          reason?: string;
      }
    | { type: 'log'; lines: Array<{ at: string; text: string }> }
    | ConnectUpdate
    | ConnectOutput;

/**
 * A member's runner sign-in on this worker asks the person for a secret, such
 * as an API key, or ended. The message says what to paste, or how it ended.
 */
export interface ConnectUpdate {
    type: 'connect.update';
    connect_id: string;
    state: 'secret' | 'done' | 'failed';
    message: string;
}

/** What the sign-in drew in its terminal, base64, for the member's terminal only. */
export interface ConnectOutput {
    type: 'connect.output';
    connect_id: string;
    data: string;
}

/** The member's terminal size in character cells. */
export interface TerminalSize {
    cols: number;
    rows: number;
}

/**
 * Asks the worker to connect a runner for one member: the provider and the
 * id of the method they chose in `wb connect --worker`.
 */
export interface ConnectStart {
    type: 'connect.start';
    connect_id: string;
    member_id: string;
    member_name: string;
    runner: string;
    provider: string;
    method: string;
}

/** Pull credentials for one private image. Held in memory only. */
export interface ImagePull {
    registry: string;
    username: string;
    password: string;
    expires_at: string;
}

/**
 * A repository to clone for the run. The credential is the run's own proxy
 * credential, held in memory only; a public repository has none.
 */
export interface RunWorkspace {
    repository: string;
    /** The address git fetches from, never with a credential in it. */
    url: string;
    /** The commit or ref to fetch. */
    ref: string;
    /** The local branch to leave the checkout on; without one it is detached and cannot push. */
    branch: string | null;
    credential: string | null;
}

export interface RunStart {
    type: 'run.start';
    run_id: string;
    session_id: string;
    started_by: { member_id: string | null };
    runtime: string;
    workbench: { version_id: string; download_url: string };
    image_pull: ImagePull | null;
    task: string;
    max_minutes: number;
    workspace: RunWorkspace | null;
    env: Record<string, string>;
    /** The connection the run was asked to use. Without one the member's own sign-in comes before the keys in `env`. */
    connection: string | null;
    run_token: string;
}

const WORKER_COMMAND_KINDS = ['send', 'steer', 'queue', 'answer', 'cancel'] as const;
type WorkerCommandKind = (typeof WORKER_COMMAND_KINDS)[number];

export interface WorkerCommand {
    type: 'command';
    command_id: string;
    run_id: string;
    kind: WorkerCommandKind;
    payload: Record<string, unknown>;
}

export type ServerMessage =
    | {
          type: 'welcome';
          worker: { id: string; slug: string };
          organization: string;
          stored: RunCursor[];
      }
    | RunStart
    | WorkerCommand
    | { type: 'stored'; run_id: string; sequence: number }
    | ConnectStart
    /** The member's terminal is attached, so the sign-in begins at its size. */
    | ({ type: 'connect.attach'; connect_id: string } & TerminalSize)
    /** What the person typed into the sign-in's terminal, base64. */
    | { type: 'connect.input'; connect_id: string; data: string }
    | ({ type: 'connect.resize'; connect_id: string } & TerminalSize)
    /** The secret the person pasted when the sign-in asked for one. */
    | { type: 'connect.secret'; connect_id: string; text: string }
    | { type: 'connect.cancel'; connect_id: string };

/**
 * Parses one server frame. Unknown message types return undefined so a newer
 * server can add messages; a known type with a malformed body throws.
 */
export function parseServerMessage(text: string): ServerMessage | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error('Worker server sent a message that is not JSON');
    }
    if (!isRecord(value) || typeof value.type !== 'string')
        throw new Error('Worker server sent a message without a type');
    switch (value.type) {
        case 'welcome':
            return parseWelcome(value);
        case 'run.start':
            return parseRunStart(value);
        case 'command':
            return parseCommand(value);
        case 'stored':
            return {
                type: 'stored',
                run_id: required(value.run_id, 'stored.run_id'),
                sequence: sequence(value.sequence, 'stored.sequence'),
            };
        case 'connect.start':
            return {
                type: 'connect.start',
                connect_id: required(value.connect_id, 'connect.start.connect_id'),
                member_id: required(value.member_id, 'connect.start.member_id'),
                member_name: required(value.member_name, 'connect.start.member_name'),
                runner: required(value.runner, 'connect.start.runner'),
                provider: required(value.provider, 'connect.start.provider'),
                method: required(value.method, 'connect.start.method'),
            };
        case 'connect.attach':
        case 'connect.resize':
            return {
                type: value.type,
                connect_id: required(value.connect_id, `${value.type}.connect_id`),
                cols: cells(value.cols, `${value.type}.cols`),
                rows: cells(value.rows, `${value.type}.rows`),
            };
        case 'connect.input':
            return {
                type: 'connect.input',
                connect_id: required(value.connect_id, 'connect.input.connect_id'),
                data: required(value.data, 'connect.input.data'),
            };
        case 'connect.secret':
            return {
                type: 'connect.secret',
                connect_id: required(value.connect_id, 'connect.secret.connect_id'),
                text: required(value.text, 'connect.secret.text'),
            };
        case 'connect.cancel':
            return {
                type: 'connect.cancel',
                connect_id: required(value.connect_id, 'connect.cancel.connect_id'),
            };
        default:
            return undefined;
    }
}

function parseWelcome(value: Record<string, unknown>): ServerMessage {
    const worker = record(value.worker, 'welcome.worker');
    const stored = value.stored;
    if (!Array.isArray(stored)) throw malformed('welcome.stored');
    return {
        type: 'welcome',
        worker: {
            id: required(worker.id, 'welcome.worker.id'),
            slug: required(worker.slug, 'welcome.worker.slug'),
        },
        organization: required(value.organization, 'welcome.organization'),
        stored: stored.map((entry: unknown) => {
            const cursor = record(entry, 'welcome.stored[]');
            return {
                run_id: required(cursor.run_id, 'welcome.stored[].run_id'),
                sequence: sequence(cursor.sequence, 'welcome.stored[].sequence'),
            };
        }),
    };
}

function parseRunStart(value: Record<string, unknown>): RunStart {
    const startedBy = record(value.started_by, 'run.start.started_by');
    const workbench = record(value.workbench, 'run.start.workbench');
    const env = record(value.env, 'run.start.env');
    const variables: Record<string, string> = {};
    for (const [name, entry] of Object.entries(env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== 'string')
            throw malformed('run.start.env');
        variables[name] = entry;
    }
    const maxMinutes = value.max_minutes;
    if (
        typeof maxMinutes !== 'number' ||
        !Number.isSafeInteger(maxMinutes) ||
        maxMinutes < 1
    )
        throw malformed('run.start.max_minutes');
    return {
        type: 'run.start',
        run_id: required(value.run_id, 'run.start.run_id'),
        session_id: required(value.session_id, 'run.start.session_id'),
        started_by: {
            member_id: optional(startedBy.member_id, 'run.start.started_by.member_id'),
        },
        runtime: required(value.runtime, 'run.start.runtime'),
        workbench: {
            version_id: required(
                workbench.version_id,
                'run.start.workbench.version_id'
            ),
            download_url: required(
                workbench.download_url,
                'run.start.workbench.download_url'
            ),
        },
        image_pull: parseImagePull(value.image_pull),
        task: required(value.task, 'run.start.task'),
        max_minutes: maxMinutes,
        workspace: parseWorkspace(value.workspace),
        env: variables,
        connection: optional(value.connection, 'run.start.connection'),
        run_token: required(value.run_token, 'run.start.run_token'),
    };
}

function parseImagePull(value: unknown): ImagePull | null {
    if (value === undefined || value === null) return null;
    const pull = record(value, 'run.start.image_pull');
    return {
        registry: required(pull.registry, 'run.start.image_pull.registry'),
        username: required(pull.username, 'run.start.image_pull.username'),
        password: required(pull.password, 'run.start.image_pull.password'),
        expires_at: required(pull.expires_at, 'run.start.image_pull.expires_at'),
    };
}

function parseWorkspace(value: unknown): RunWorkspace | null {
    if (value === undefined || value === null) return null;
    const workspace = record(value, 'run.start.workspace');
    const url = required(workspace.url, 'run.start.workspace.url');
    try {
        const address = new URL(url);
        if (address.username || address.password) throw new Error('credential');
    } catch {
        throw malformed('run.start.workspace.url');
    }
    return {
        repository: required(workspace.repository, 'run.start.workspace.repository'),
        url,
        ref: required(workspace.ref, 'run.start.workspace.ref'),
        branch: optional(workspace.branch, 'run.start.workspace.branch'),
        credential: optional(workspace.credential, 'run.start.workspace.credential'),
    };
}

function parseCommand(value: Record<string, unknown>): WorkerCommand {
    const kind = WORKER_COMMAND_KINDS.find((candidate) => candidate === value.kind);
    if (!kind) throw malformed('command.kind');
    return {
        type: 'command',
        command_id: required(value.command_id, 'command.command_id'),
        run_id: required(value.run_id, 'command.run_id'),
        kind,
        payload: record(value.payload, 'command.payload'),
    };
}

export function isWorkerRuntime(value: string): value is WorkerRuntime {
    return WORKER_RUNTIMES.some((runtime) => runtime === value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
    if (!isRecord(value)) throw malformed(field);
    return value;
}

function required(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value) throw malformed(field);
    return value;
}

function optional(value: unknown, field: string): string | null {
    if (value === undefined || value === null || value === '') return null;
    return required(value, field);
}

function sequence(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw malformed(field);
    return value;
}

/** A terminal dimension: a whole number of cells, at least one. */
function cells(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
        throw malformed(field);
    return value;
}

function malformed(field: string): Error {
    return new Error(`Worker server sent a malformed message: ${field}`);
}
