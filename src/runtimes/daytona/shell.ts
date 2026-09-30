import type { E2BRunOptions, E2BSandbox } from '../e2b/contracts.js';
import { quote } from '../e2b/shell.js';
import type { DaytonaSandbox } from './contracts.js';

/** The sandbox operations that staging, directory setup, and collection share. */
export type SandboxShell = Pick<E2BSandbox, 'run' | 'download' | 'fileSize' | 'upload'>;

/**
 * Presents a Daytona sandbox through the operations shared with the other remote
 * provider, so staging and outcome collection are not written twice.
 */
export function sandboxShell(sandbox: DaytonaSandbox): SandboxShell {
    return {
        run: (command: string, options: E2BRunOptions = {}) =>
            sandbox.run(command, {
                ...(options.cwd ? { cwd: options.cwd } : {}),
                ...(options.env ? { env: options.env } : {}),
                ...(options.user ? { user: options.user } : {}),
            }),
        async upload(path, data) {
            await sandbox.upload(
                path,
                new Uint8Array(await new Response(data).arrayBuffer())
            );
        },
        download: (path) => sandbox.download(path),
        async fileSize(path) {
            const result = await sandbox.run(`wc -c < ${quote(path)}`);
            const size = Number(result.stdout.trim().split(/\s+/).at(-1));
            if (result.code !== 0 || !Number.isSafeInteger(size) || size < 0) {
                throw new Error(`Cannot read the size of ${path} in the sandbox`);
            }
            return size;
        },
    };
}
