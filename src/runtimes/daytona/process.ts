import type { RuntimeCommandResult } from '../contracts.js';
import { RuntimeError } from '../error.js';
import type { RemoteCommand, RemoteCommandOptions } from '../remote/process.js';
import type { DaytonaTransport } from './transport.js';

/**
 * A command's status. The toolbox leaves `exitCode` out, or reports null,
 * while the command runs.
 */
interface CommandStatus {
    id?: string;
    exitCode?: number | null;
}

const maximumPollFailures = 5;
/** The longest wait between polls while a command's output is unchanged. */
const maximumIdleIntervalMs = 5_000;

/**
 * A command running in a toolbox session. Output is read by polling the
 * session's logs and appending only what is new, so a dropped poll loses nothing.
 */
export class SessionProcess implements RemoteCommand {
    private readonly finished: Promise<RuntimeCommandResult>;
    private stopped = false;

    constructor(
        private readonly transport: DaytonaTransport,
        private readonly session: string,
        private readonly command: string,
        private readonly options: RemoteCommandOptions
    ) {
        this.finished = this.follow();
    }

    wait(): Promise<RuntimeCommandResult> {
        return this.finished;
    }

    async sendStdin(data: string | Uint8Array): Promise<void> {
        await this.transport.request(
            'POST',
            `${this.session}/command/${this.command}/input`,
            {
                absolute: true,
                json: {
                    data:
                        typeof data === 'string'
                            ? data
                            : new TextDecoder().decode(data),
                },
            }
        );
    }

    async closeStdin(): Promise<void> {
        // The toolbox has no end-of-input operation. Runners that need EOF to
        // finish are refused before a sandbox is created.
    }

    async kill(): Promise<void> {
        this.stopped = true;
        await this.transport
            .request('DELETE', this.session, { absolute: true })
            .catch(() => {});
    }

    private async follow(): Promise<RuntimeCommandResult> {
        let stdout = '';
        let stderr = '';
        // The toolbox logs endpoint takes no offset, so each poll returns the
        // whole output. Lengths are compared before slicing, and the poll interval
        // backs off while output is unchanged so idle commands cost little.
        const drain = async (): Promise<boolean> => {
            const logs = await this.logs();
            let changed = false;
            if (logs.stdout.length > stdout.length) {
                const added = logs.stdout.slice(stdout.length);
                stdout = logs.stdout;
                changed = true;
                await this.options.onStdout?.(added);
            }
            if (logs.stderr.length > stderr.length) {
                const added = logs.stderr.slice(stderr.length);
                stderr = logs.stderr;
                changed = true;
                await this.options.onStderr?.(added);
            }
            return changed;
        };
        const base = this.transport.pollIntervalMs;
        const ceiling = Math.max(base, maximumIdleIntervalMs);
        let interval = base;
        let failures = 0;
        for (;;) {
            if (this.stopped) {
                await drain().catch(() => {});
                return { code: 143, stdout, stderr };
            }
            let status: CommandStatus;
            try {
                status = await this.transport.json<CommandStatus>(
                    'GET',
                    `${this.session}/command/${this.command}`,
                    { absolute: true }
                );
                this.assertStatus(status);
            } catch (error) {
                // A reply that is not a command's status is final, not a passing failure.
                if (error instanceof RuntimeError) throw error;
                await this.retryAfter(++failures, error);
                continue;
            }
            if (status.exitCode !== undefined && status.exitCode !== null) {
                // One more read so output written just before exit is not lost.
                // The exit code is already known, so a failed read must not hide it.
                await drain().catch(() => {});
                await this.transport
                    .request('DELETE', this.session, { absolute: true })
                    .catch(() => {});
                return { code: status.exitCode, stdout, stderr };
            }
            try {
                interval = (await drain()) ? base : Math.min(interval * 2, ceiling);
                failures = 0;
            } catch (error) {
                await this.retryAfter(++failures, error);
                continue;
            }
            await this.transport.wait(interval);
        }
    }

    /**
     * A brief network or proxy failure must not end a long run, so wait a little
     * longer after each one in a row and give up only after several.
     */
    private async retryAfter(failures: number, error: unknown): Promise<void> {
        if (failures >= maximumPollFailures) throw error;
        await this.transport.wait(this.transport.pollIntervalMs * failures);
    }

    /**
     * The toolbox schema leaves `exitCode` optional, so its absence means the
     * command is still running. A reply that does not identify the command, such
     * as a proxy page, is not a status, and a command must never wait on it.
     */
    private assertStatus(status: CommandStatus): void {
        if (
            typeof status !== 'object' ||
            status === null ||
            typeof status.id !== 'string'
        ) {
            throw new RuntimeError(
                'daytona',
                'launch',
                'Daytona toolbox returned an unexpected command status: expected JSON with the command id'
            );
        }
    }

    private async logs(): Promise<{ stdout: string; stderr: string }> {
        const response = await this.transport.request(
            'GET',
            `${this.session}/command/${this.command}/logs`,
            { absolute: true, accept: 'application/json,text/plain' }
        );
        const text = await response.text();
        if (!(response.headers.get('content-type') ?? '').includes('json')) {
            return { stdout: text, stderr: '' };
        }
        const body = JSON.parse(text) as {
            stdout?: string;
            stderr?: string;
            output?: string;
        };
        return {
            stdout:
                body.stdout ?? (body.stderr === undefined ? (body.output ?? '') : ''),
            stderr: body.stderr ?? '',
        };
    }
}
