import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class RunReconciliationLease {
    readonly #directory: string;
    readonly #ownerPath: string;

    constructor(
        private readonly runId: string,
        runDirectory: string
    ) {
        this.#directory = join(runDirectory, '.reconcile');
        this.#ownerPath = join(this.#directory, 'owner.json');
    }

    async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        const token = crypto.randomUUID();
        const started = Date.now();
        while (Date.now() - started < 5_000) {
            let acquired = false;
            try {
                await mkdir(this.#directory, { mode: 0o700 });
                acquired = true;
                try {
                    await writeFile(
                        this.#ownerPath,
                        `${JSON.stringify({ version: 1, token, pid: process.pid })}\n`,
                        { mode: 0o600 }
                    );
                    return await operation();
                } finally {
                    await this.release(token);
                }
            } catch (error) {
                if (acquired) throw error;
                if (!isAlreadyExists(error)) throw error;
                if (await this.recover()) continue;
                await Bun.sleep(10);
            }
        }
        throw new Error(`Timed out reconciling Workbench run: ${this.runId}`);
    }

    private async recover(): Promise<boolean> {
        const source = await readFile(this.#ownerPath, 'utf8').catch(() => undefined);
        if (source) {
            try {
                const owner = JSON.parse(source) as { pid?: unknown };
                if (typeof owner.pid === 'number' && processIsAlive(owner.pid)) {
                    return false;
                }
                await rm(this.#directory, { recursive: true, force: true });
                return true;
            } catch {
                // A partial owner record is handled by the age check below.
            }
        }
        const details = await stat(this.#directory).catch(() => undefined);
        if (!details || Date.now() - details.mtimeMs < 5_000) return false;
        await rm(this.#directory, { recursive: true, force: true });
        return true;
    }

    private async release(token: string): Promise<void> {
        const source = await readFile(this.#ownerPath, 'utf8').catch(() => undefined);
        if (!source) {
            await rm(this.#directory, { recursive: true, force: true });
            return;
        }
        try {
            const owner = JSON.parse(source) as { token?: unknown };
            if (owner.token !== token) return;
        } catch {
            return;
        }
        await rm(this.#directory, { recursive: true, force: true });
    }
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isAlreadyExists(error: unknown): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
    );
}
