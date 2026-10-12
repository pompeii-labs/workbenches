import { ProcessProbe } from '../processes/processprobe.js';
import type { WorkbenchDatabase } from './workbenchdatabase.js';

export interface LeaseOptions {
    timeoutMilliseconds: number;
    pollMilliseconds: number;
    timeoutMessage: string;
}

/**
 * Named mutual exclusion between processes, stored as rows. A lease is taken
 * and released in transactions. The owner is recorded by pid, and a lease is
 * recovered only when that process is gone.
 */
export class LeaseStore {
    constructor(
        private readonly database: WorkbenchDatabase,
        private readonly clock: () => number = Date.now,
        private readonly probe = new ProcessProbe()
    ) {}

    async exclusive<T>(
        name: string,
        options: LeaseOptions,
        operation: () => Promise<T>
    ): Promise<T> {
        const token = crypto.randomUUID();
        const started = this.clock();
        while (!this.tryAcquire(name, token)) {
            if (this.clock() - started >= options.timeoutMilliseconds)
                throw new Error(options.timeoutMessage);
            await Bun.sleep(options.pollMilliseconds);
        }
        try {
            return await operation();
        } finally {
            this.release(name, token);
        }
    }

    tryAcquire(name: string, token: string): boolean {
        return this.database.transaction(() => {
            const held = this.database.one(
                'SELECT pid FROM leases WHERE name = ?',
                name
            );
            // A live holder keeps its lease however long it holds it.
            if (held && typeof held.pid === 'number' && this.probe.alive(held.pid))
                return false;
            this.database.run(
                'INSERT OR REPLACE INTO leases (name, token, pid, acquired_at) VALUES (?, ?, ?, ?)',
                name,
                token,
                process.pid,
                this.clock()
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
