import type { ConnectionAuthenticationMethod } from '../connections/contracts.js';
import { HostCredentialFiles } from '../connections/credentials.js';
import { NativeCredentialFile } from '../connections/nativecredentials.js';
import {
    connectionAuthenticationMethods,
    providerLabel,
} from '../connections/targets.js';
import { ActiveModelCatalog } from '../models/snapshot.js';
import type { RunnerRegistry } from '../runners/registry.js';
import type { Runner, RunnerWorkerSignIn } from '../runners/runner.js';
import { WorkerRunEnvironment } from './environment.js';
import type { WorkerHome } from './home.js';
import { excerpt, type WorkerLog } from './log.js';
import { probe } from './machine.js';
import type {
    ConnectOutput,
    ConnectStart,
    ConnectUpdate,
    TerminalSize,
} from './protocol.js';

/** The most terminal output one message carries, within the server's limit. */
const OUTPUT_CHUNK_BYTES = 48 * 1024;

/** How long after a sign-in exits its terminal's last output is waited for. */
const TERMINAL_DRAIN_MILLISECONDS = 1000;

/**
 * What a member's choice does on this worker: take a key for the provider's
 * standard variable, or run the runner's own sign-in.
 */
type WorkerConnectPlan = {
    runner: Runner;
    provider: string;
    method: ConnectionAuthenticationMethod;
} & (
    | { kind: 'key'; variable: string }
    | { kind: 'sign-in'; signIn: RunnerWorkerSignIn }
);

/** What a finished sign-in ran with, so its login can be exported the same way. */
interface SignedIn {
    readonly executable: string;
    readonly environment: Record<string, string | undefined>;
    readonly version: string;
    /** The member's directory. */
    readonly directory: string;
}

/** A sign-in process attached to a pseudo-terminal. */
export interface WorkerSignInProcess {
    write(data: Uint8Array): void;
    resize(size: TerminalSize): void;
    kill(): void;
    readonly exited: Promise<number>;
}

export type WorkerSignInSpawn = (
    command: string[],
    env: Record<string, string | undefined>,
    cwd: string,
    size: TerminalSize,
    output: (data: Uint8Array) => void
) => WorkerSignInProcess;

export interface WorkerSignInsOptions {
    home: Pick<WorkerHome, 'saveMember' | 'saveMemberConnection' | 'ensure'>;
    runners: Pick<RunnerRegistry, 'find' | 'list'>;
    environment: Pick<WorkerRunEnvironment, 'signIn' | 'release'>;
    log: WorkerLog;
    send: (message: ConnectUpdate | ConnectOutput) => boolean;
    which?: (name: string) => string | null;
    spawn?: WorkerSignInSpawn;
    /** When an unfinished sign-in is ended; the site expires it after 10 minutes. */
    timeoutMilliseconds?: number;
}

/** A member's sign-in from its start until it ends. */
interface Attempt {
    readonly start: ConnectStart;
    attached: boolean;
    process?: WorkerSignInProcess;
    /** Takes the secret the person was asked for, or undefined when the attempt ended first. */
    secret: ((text: string | undefined) => void) | undefined;
    ended: boolean;
}

/**
 * Connects runners for members on this worker, as `wb connect --worker` asks
 * through the site. A sign-in runs the runner's own command unmodified in a
 * terminal at the member's size, with the member's directory as its home and
 * in the sandbox their local runs get, so its login lands there and nowhere
 * else on the machine. Its terminal goes to the member's terminal as it is
 * and their keystrokes come back, so it reads and works exactly as it does on
 * their own machine; nothing here reads it. A key method asks the person to
 * paste the key instead, which is saved owner-only in the member's
 * directory; it is never logged, and no credential is ever sent to the site.
 */
export class WorkerSignIns {
    readonly #attempts = new Map<string, Attempt>();
    readonly #which: (name: string) => string | null;
    readonly #spawn: WorkerSignInSpawn;

    constructor(private readonly options: WorkerSignInsOptions) {
        this.#which = options.which ?? ((name) => Bun.which(name));
        this.#spawn = options.spawn ?? spawnInTerminal;
    }

    /**
     * Notes the member's sign-in. Nothing runs until their terminal attaches,
     * so what happens, a refusal included, is what that terminal is told.
     */
    start(start: ConnectStart): void {
        if (this.#attempts.has(start.connect_id)) return;
        this.#attempts.set(start.connect_id, {
            start,
            attached: false,
            secret: undefined,
            ended: false,
        });
    }

    /** The member's terminal is attached: the sign-in begins at its size. */
    attach(id: string, size: TerminalSize): void {
        const attempt = this.#attempts.get(id);
        if (!attempt || attempt.attached) return;
        attempt.attached = true;
        const timeout = setTimeout(
            () => this.#end(attempt),
            this.options.timeoutMilliseconds ?? 10 * 60 * 1000
        );
        void this.#begin(attempt, size)
            .catch(() => {
                if (!attempt.ended)
                    this.#update(id, 'failed', 'The sign-in failed on this worker.');
            })
            .finally(() => {
                clearTimeout(timeout);
                this.#end(attempt);
            });
    }

    /** Writes what the person typed into the sign-in's terminal. */
    input(id: string, data: string): void {
        this.#attempts.get(id)?.process?.write(Buffer.from(data, 'base64'));
    }

    resize(id: string, size: TerminalSize): void {
        this.#attempts.get(id)?.process?.resize(size);
    }

    /** The secret the person pasted when asked for one. */
    secret(id: string, text: string): void {
        this.#attempts.get(id)?.secret?.(text);
    }

    cancel(id: string): void {
        const attempt = this.#attempts.get(id);
        if (!attempt) return;
        this.options.log.write(
            `sign-in cancelled  ${excerpt(attempt.start.runner, 40)}`
        );
        this.#end(attempt);
    }

    /** Ends every sign-in, when the daemon exits. */
    close(): void {
        for (const attempt of this.#attempts.values()) this.#end(attempt);
    }

    async #begin(attempt: Attempt, size: TerminalSize): Promise<void> {
        const { start } = attempt;
        const plan = this.#plan(start);
        if (typeof plan === 'string') {
            this.#update(start.connect_id, 'failed', plan);
            return;
        }
        const directory = await this.options.home
            .saveMember({ id: start.member_id, name: start.member_name })
            .catch(() => undefined);
        if (!directory) {
            this.#update(
                start.connect_id,
                'failed',
                'The connection could not start on this worker.'
            );
            return;
        }
        if (plan.kind === 'key') await this.#key(attempt, plan);
        else await this.#signIn(attempt, plan, directory, size);
    }

    /**
     * Resolves the member's choice from the runner's own methods, the ones
     * `wb connect` offers for `local`, or says why this worker cannot do it.
     */
    #plan(start: ConnectStart): WorkerConnectPlan | string {
        const runner = this.options.runners.find(start.runner);
        if (!runner) return `This worker has no runner named ${start.runner}.`;
        const { provider, method: id } = start;
        const catalog = ActiveModelCatalog.active();
        if (!catalog)
            return 'This worker has no model metadata yet. Restart it while it is online, then connect again.';
        const method = connectionAuthenticationMethods(
            'local',
            runner.name,
            provider,
            catalog,
            this.options.runners
        ).find((candidate) => candidate.id === id);
        if (!method)
            return `${runner.displayName} has no ${id} method for ${providerLabel(provider)}.`;
        if (method.authenticationMethod === 'api') {
            const variable = catalog.providers[provider]?.env[0];
            if (!variable)
                return `${providerLabel(provider)} has no API key variable, so a worker cannot keep its key.`;
            return { kind: 'key', runner, provider, method, variable };
        }
        const signIn = runner.workerSignIn;
        if (!signIn)
            return `${runner.displayName} has no command-line sign-in, so a ${runner.displayName} subscription cannot be connected on a worker yet. An API key can be.`;
        return { kind: 'sign-in', runner, provider, method, signIn };
    }

    /** Asks the person for the key and keeps it for the provider's standard variable. */
    async #key(
        attempt: Attempt,
        plan: WorkerConnectPlan & { kind: 'key' }
    ): Promise<void> {
        const { runner, provider, method, variable } = plan;
        this.options.log.write(
            `key requested  ${runner.name}  for ${excerpt(attempt.start.member_name, 40)}`
        );
        const key = await this.#ask(
            attempt,
            runner,
            `Paste your ${providerLabel(provider)} API key. Your ${runner.displayName} runs on this worker get it as ${variable}.`
        );
        if (key === undefined) return;
        await this.#save(attempt, runner, {
            provider,
            method: method.id,
            variable,
            secret: key,
        });
        this.options.log.write(`key saved  ${runner.name}`);
        this.#update(
            attempt.start.connect_id,
            'done',
            `Saved your ${providerLabel(provider)} API key for ${runner.displayName} on this worker.`
        );
    }

    async #signIn(
        attempt: Attempt,
        plan: WorkerConnectPlan & { kind: 'sign-in' },
        directory: string,
        size: TerminalSize
    ): Promise<void> {
        const { connect_id: id } = attempt.start;
        const { runner, method, signIn } = plan;
        const executable = this.#which(runner.executable);
        if (!executable) {
            this.#update(
                id,
                'failed',
                `${runner.displayName} is not installed on this worker.`
            );
            return;
        }
        for (const child of ['.config', '.local/share', '.local/state', '.cache'])
            await this.options.home.ensure(`${directory}/${child}`);
        const version = signIn.versionCommand
            ? await probe([executable, ...signIn.versionCommand])
            : '';
        if (version === undefined) {
            this.#update(
                id,
                'failed',
                `${runner.displayName} on this worker did not report its version.`
            );
            return;
        }
        if (attempt.ended) return;
        const environment = await this.options.environment.signIn(
            id,
            directory,
            runner.name
        );
        try {
            attempt.process = this.#spawn(
                [
                    executable,
                    ...signIn.arguments(
                        method.nativeProvider,
                        method.nativeMethod,
                        version
                    ),
                ],
                {
                    ...environment,
                    // The person opens the link on their own machine, never on this one's screen.
                    BROWSER: this.#which('true') ?? '/usr/bin/true',
                    TERM: 'xterm-256color',
                },
                directory,
                size,
                (data) => this.#output(id, data)
            );
            this.options.log.write(
                `sign-in started  ${runner.name}  for ${excerpt(attempt.start.member_name, 40)}`
            );
            await this.#finish(attempt, plan, await attempt.process.exited, {
                executable,
                environment,
                version,
                directory,
            });
        } finally {
            await this.options.environment.release(id);
        }
    }

    async #finish(
        attempt: Attempt,
        plan: WorkerConnectPlan & { kind: 'sign-in' },
        code: number,
        signedIn: SignedIn
    ): Promise<void> {
        const { connect_id: id } = attempt.start;
        const { runner, provider, method } = plan;
        if (attempt.ended) return;
        if (code !== 0) {
            this.options.log.write(`sign-in failed  ${runner.name}`);
            this.#update(
                id,
                'failed',
                `${runner.displayName} sign-in did not finish (exit ${code}).`
            );
            return;
        }
        await this.#keepPortable(plan, signedIn);
        // The runner keeps its login in the member's home; this records only which it is.
        await this.#save(attempt, runner, { provider, method: method.id });
        this.options.log.write(`sign-in finished  ${runner.name}`);
        this.#update(id, 'done', `Signed in to ${runner.displayName} on this worker.`);
    }

    /**
     * Copies a login the runner keeps outside its credential file, such as in
     * OpenCode 2's database, into that file in the member's directory. A docker
     * run gives the file to its image's runner, so the login works whatever
     * version of the runner the image has. A failed copy leaves the login for
     * local runs and says so in the log.
     */
    async #keepPortable(
        plan: WorkerConnectPlan & { kind: 'sign-in' },
        signedIn: SignedIn
    ): Promise<void> {
        const { runner, method } = plan;
        const exportCredential = runner.connection.hostSignIn?.exportCredential;
        if (!exportCredential) return;
        try {
            const value = await exportCredential(
                signedIn.executable,
                signedIn.environment,
                method.nativeProvider,
                signedIn.version
            );
            if (!value) return;
            await NativeCredentialFile.for(runner.name, this.options.runners).save(
                new HostCredentialFiles(
                    WorkerRunEnvironment.credentialRoot(signedIn.directory)
                ),
                method.nativeProvider,
                { type: typeof value.type === 'string' ? value.type : undefined, value }
            );
        } catch {
            this.options.log.write(`sign-in kept for local runs only  ${runner.name}`);
        }
    }

    /**
     * Asks the person for a secret and waits for it. Undefined when the
     * attempt ended first, or after telling them they sent nothing. A key has
     * no whitespace, so any in what they sent is dropped: a long key copied
     * from a terminal carries the line breaks it wrapped at.
     */
    async #ask(
        attempt: Attempt,
        runner: Runner,
        message: string
    ): Promise<string | undefined> {
        if (attempt.ended) return undefined;
        const answer = new Promise<string | undefined>((resolve) => {
            attempt.secret = (text) => {
                attempt.secret = undefined;
                resolve(text);
            };
        });
        this.#update(attempt.start.connect_id, 'secret', message);
        const text = (await answer)?.replace(/\s+/g, '');
        if (text === undefined || attempt.ended) return undefined;
        if (!text) {
            this.options.log.write(`key refused  ${runner.name}`);
            this.#update(
                attempt.start.connect_id,
                'failed',
                'Nothing was pasted, so nothing was saved.'
            );
            return undefined;
        }
        return text;
    }

    async #save(
        attempt: Attempt,
        runner: Runner,
        connection: Parameters<WorkerHome['saveMemberConnection']>[2]
    ): Promise<void> {
        await this.options.home.saveMemberConnection(
            attempt.start.member_id,
            runner.name,
            connection
        );
    }

    /** Ends the attempt: its process stops and a pending question goes unanswered. */
    #end(attempt: Attempt): void {
        if (attempt.ended) return;
        attempt.ended = true;
        this.#attempts.delete(attempt.start.connect_id);
        attempt.process?.kill();
        attempt.secret?.(undefined);
    }

    #output(id: string, data: Uint8Array): void {
        for (let offset = 0; offset < data.length; offset += OUTPUT_CHUNK_BYTES)
            this.options.send({
                type: 'connect.output',
                connect_id: id,
                data: Buffer.from(
                    data.subarray(offset, offset + OUTPUT_CHUNK_BYTES)
                ).toString('base64'),
            });
    }

    #update(id: string, state: ConnectUpdate['state'], message: string): void {
        this.options.send({ type: 'connect.update', connect_id: id, state, message });
    }
}

function spawnInTerminal(
    command: string[],
    env: Record<string, string | undefined>,
    cwd: string,
    size: TerminalSize,
    output: (data: Uint8Array) => void
): WorkerSignInProcess {
    let drained = () => {};
    const closed = new Promise<void>((resolve) => {
        drained = resolve;
    });
    const terminal = new Bun.Terminal({
        cols: size.cols,
        rows: size.rows,
        data: (_terminal, data) => output(data),
        exit: () => drained(),
    });
    const child = Bun.spawn(command, { cwd, env, terminal });
    return {
        write: (data) => {
            terminal.write(data);
        },
        resize: ({ cols, rows }) => terminal.resize(cols, rows),
        kill: () => child.kill(),
        // Its last output, which puts the person's terminal back as it found it,
        // is read before the exit is reported. A child it left holding the
        // terminal open is not waited on for long.
        exited: child.exited.then(async (code) => {
            await Promise.race([closed, Bun.sleep(TERMINAL_DRAIN_MILLISECONDS)]);
            terminal.close();
            return code;
        }),
    };
}
