import type { RemoteSandbox } from '../remote/runtime.js';
import { quote } from '../staging/shell.js';

/**
 * Only the end of a command's standard error is collected. It is read once,
 * when the command exits, as diagnostic detail such as a failure's last
 * words, so the last 64 KiB is enough and a noisy command never costs more.
 */
const collectedBytes = 64 * 1024;

/**
 * A file in the sandbox that holds one background command's standard error.
 * The toolbox merges standard error into standard output, so a command whose
 * caller reads the two apart writes its standard error here instead. The file
 * is in `/tmp`, outside every staged path and the outbox, and is named for
 * its command.
 */
export class StderrFile {
    readonly path = `/tmp/.workbench-stderr-${crypto.randomUUID()}`;
    #removed = false;

    constructor(private readonly sandbox: Pick<RemoteSandbox, 'run'>) {}

    /** The command line with its standard error sent to the file. */
    redirect(command: string): string {
        return `${command} 2>${quote(this.path)}`;
    }

    /**
     * Reads the end of the file and removes it. Resolves with nothing when it
     * cannot be read, so a failed read never hides how the command ended.
     */
    async collect(): Promise<string> {
        const path = quote(this.path);
        try {
            const result = await this.sandbox.run(
                `tail -c ${collectedBytes} ${path}; S=$?; rm -f ${path}; exit $S`
            );
            this.#removed = true;
            return result.code === 0 ? result.stdout : '';
        } catch {
            return '';
        }
    }

    /** Removes the file without reading it. Safe to repeat. */
    async discard(): Promise<void> {
        if (this.#removed) return;
        try {
            await this.sandbox.run(`rm -f ${quote(this.path)}`);
            this.#removed = true;
        } catch {}
    }
}
