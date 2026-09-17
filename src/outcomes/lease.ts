import {
    lstat,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

interface LeaseTicket {
    pid: number;
    choosing: boolean;
    number: number;
}

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
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const directory = await lstat(this.directory);
        if (!directory.isDirectory() || directory.isSymbolicLink())
            throw new Error('Outcome storage lease must use a real directory');
        const name = `${process.pid}.${crypto.randomUUID()}.json`;
        const path = join(this.directory, name);
        const started = Date.now();
        try {
            // Publish choosing before inspecting competitors (the bakery algorithm).
            // Each owner has a unique path: stale cleanup can never unlink a new lease.
            await this.write(path, { pid: process.pid, choosing: true, number: 0 });
            const tickets = await this.tickets();
            const number =
                Math.max(0, ...tickets.map(([, ticket]) => ticket.number)) + 1;
            if (!Number.isSafeInteger(number))
                throw new Error('Outcome lease ticket overflow');
            await this.write(path, { pid: process.pid, choosing: false, number });
            while (Date.now() - started < 30_000) {
                const waiting = (await this.tickets()).some(
                    ([other, ticket]) =>
                        other !== name &&
                        (ticket.choosing ||
                            ticket.number < number ||
                            (ticket.number === number && other < name))
                );
                if (!waiting) return await operation();
                await Bun.sleep(25);
            }
            throw new Error('Timed out acquiring outcome storage lease');
        } finally {
            await rm(path, { force: true });
        }
    }

    private async tickets(): Promise<Array<[string, LeaseTicket]>> {
        const tickets: Array<[string, LeaseTicket]> = [];
        for (const name of await readdir(this.directory)) {
            if (!/^\d+\.[a-f0-9-]{36}\.json$/.test(name)) continue;
            const path = join(this.directory, name);
            try {
                const details = await lstat(path);
                if (
                    !details.isFile() ||
                    details.isSymbolicLink() ||
                    details.size > 1_024
                )
                    throw new Error('Invalid outcome storage lease ticket');
                const ticket: LeaseTicket = JSON.parse(await readFile(path, 'utf8'));
                if (
                    !Number.isSafeInteger(ticket.pid) ||
                    ticket.pid <= 0 ||
                    String(ticket.pid) !== name.split('.')[0] ||
                    typeof ticket.choosing !== 'boolean' ||
                    !Number.isSafeInteger(ticket.number) ||
                    ticket.number < 0 ||
                    (!ticket.choosing && ticket.number === 0)
                )
                    throw new Error('Invalid outcome storage lease ticket');
                if (processIsAlive(ticket.pid)) tickets.push([name, ticket]);
                else await rm(path, { force: true });
            } catch (error) {
                if (!hasCode(error, 'ENOENT')) throw error;
            }
        }
        return tickets;
    }

    private async write(path: string, ticket: LeaseTicket): Promise<void> {
        const temporary = `${path}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify(ticket), {
                mode: 0o600,
                flag: 'wx',
            });
            await rename(temporary, path);
        } finally {
            await rm(temporary, { force: true });
        }
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
