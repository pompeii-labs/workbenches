import { lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Serializes private storage metadata operations across engine processes. */
export class OutcomeStorageLease {
    private readonly directory: string;

    constructor(private readonly root: string) {
        this.directory = join(root, '.lease');
    }

    async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const root = await lstat(this.root);
        if (!root.isDirectory() || root.isSymbolicLink())
            throw new Error('Outcome lease root must use a real directory');
        const token = crypto.randomUUID();
        const started = Date.now();
        while (Date.now() - started < 30_000) {
            let acquired = false;
            try {
                await mkdir(this.directory, { mode: 0o700 });
                acquired = true;
                await writeFile(
                    join(this.directory, 'owner.json'),
                    JSON.stringify({ pid: process.pid, token }),
                    { mode: 0o600 }
                );
                return await operation();
            } catch (error) {
                if (acquired || !hasCode(error, 'EEXIST')) throw error;
                if (!(await this.recover())) await Bun.sleep(25);
            } finally {
                if (acquired)
                    await rm(this.directory, { recursive: true, force: true });
            }
        }
        throw new Error('Timed out acquiring outcome storage lease');
    }

    private async recover(): Promise<boolean> {
        const lock = await lstat(this.directory).catch(() => undefined);
        if (lock && (!lock.isDirectory() || lock.isSymbolicLink()))
            throw new Error('Outcome storage lease must use a real directory');
        const source = await readFile(join(this.directory, 'owner.json'), 'utf8').catch(
            () => undefined
        );
        if (source) {
            try {
                const owner = JSON.parse(source) as { pid?: unknown };
                if (typeof owner.pid === 'number' && processIsAlive(owner.pid))
                    return false;
            } catch {
                return false;
            }
        } else {
            const details = await stat(this.directory).catch(() => undefined);
            if (!details || Date.now() - details.mtimeMs < 5_000) return false;
        }
        await rm(this.directory, { recursive: true, force: true });
        return true;
    }
}

export function processIsAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return hasCode(error, 'EPERM');
    }
}

function hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}
