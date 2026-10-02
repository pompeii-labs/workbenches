import type { RunnerInvocation } from '../../types.js';
import type { RemoteCommand, RemoteLauncher, RemoteOutput } from '../remote/process.js';
import { definedEnvironment, shellCommand } from '../staging/shell.js';
import type { DaytonaSandbox } from './contracts.js';

/**
 * True when something accepts connections on the port inside the sandbox. It
 * needs `bash` for its `/dev/tcp` redirection or `curl`, and reports a closed
 * port otherwise.
 */
const portListening = (port: number) =>
    [
        'if command -v bash >/dev/null 2>&1; then',
        `  bash -c '(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null'`,
        'elif command -v curl >/dev/null 2>&1; then',
        `  curl -s -o /dev/null --max-time 2 http://127.0.0.1:${port}/; code=$?`,
        '  [ "$code" != 7 ] && [ "$code" != 28 ] && [ "$code" != 6 ]',
        'else',
        '  exit 1',
        'fi',
    ].join('\n');

/**
 * Starts a runner's server in a reconnected sandbox. When the server is already
 * listening on `port`, it reports the server's address as a fresh start would
 * and leaves it running. Otherwise it starts the server as usual. The command it
 * returns ends when it is killed, which detaches without stopping the server.
 */
export class ServiceLauncher implements RemoteLauncher {
    constructor(
        private readonly sandbox: Pick<DaytonaSandbox, 'run' | 'start'>,
        private readonly invocation: RunnerInvocation,
        private readonly port: number
    ) {}

    async start(output: RemoteOutput): Promise<RemoteCommand> {
        const probe = await this.sandbox.run(portListening(this.port));
        if (probe.code !== 0) {
            return this.sandbox.start(shellCommand(this.invocation.command), {
                cwd: this.invocation.cwd,
                env: definedEnvironment(this.invocation.env),
                stdin: false,
                ...output,
            });
        }
        output.onStdout(
            `Attached to the running server at http://0.0.0.0:${this.port}\n`
        );
        let detach: (() => void) | undefined;
        const detached = new Promise<void>((resolve) => {
            detach = resolve;
        });
        return {
            wait: async () => {
                await detached;
                return { code: 0, stdout: '', stderr: '' };
            },
            sendStdin: async () => {},
            closeStdin: async () => {},
            kill: async () => detach?.(),
        };
    }
}
