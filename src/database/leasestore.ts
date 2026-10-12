import type { WorkbenchDatabase } from './workbenchdatabase.js';

export interface LeaseOptions {
    timeoutMilliseconds: number;
    pollMilliseconds: number;
    timeoutMessage: string;
}

/** A lease older than this is released even if its recorded process looks alive (pid reuse). */
const LEASE_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * Named mutual exclusion between processes, stored as rows. A lease is taken
 * and released in transactions. A lease whose owner process is gone, or that
 * outlived its expiry, is recovered by the next taker.
 */
export class LeaseStore {
    constructor(private readonly database: WorkbenchDatabase) {}

    async exclusive<T>(
        name: string,
        options: LeaseOptions,
        operation: () => Promise<T>
    ): Promise<T> {
        const token = crypto.randomUUID();
        const started = Date.now();
        while (!this.tryAcquire(name, token)) {
            if (Date.now() - started >= options.timeoutMilliseconds)
                throw new Error(options.timeoutMessage);
            await Bun.sleep(options.pollMilliseconds);
        }
        try {
            return await operation();
        } finally {
            this.release(name, token);
        }
    }

    tryAcquire(name: string, token: string, now = Date.now()): boolean {
        return this.database.transaction(() => {
            const held = this.database.one(
                'SELECT pid, expires_at FROM leases WHERE name = ?',
                name
            );
            if (
                held &&
                typeof held.pid === 'number' &&
                typeof held.expires_at === 'number' &&
                held.expires_at > now &&
                processIsAlive(held.pid)
            )
                return false;
            this.database.run(
                'INSERT OR REPLACE INTO leases (name, token, pid, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)',
                name,
                token,
                process.pid,
                now,
                now + LEASE_LIFETIME_MILLISECONDS
            );
            return true;
        });
    }

    release(name: string, token: string): void {
        this.database.run(
            'DELETE FROM leases WHERE name = ? AND token = ?',
            name,
            token
        );
    }
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // An inaccessible process still owns its lease.
        return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
    }
}
