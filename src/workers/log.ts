import { appendFile } from 'node:fs/promises';

import type { WorkerHome } from './home.js';

export interface WorkerLogLine {
    at: string;
    text: string;
}

/**
 * The worker's lifecycle log: one line per state change, appended to the log
 * file and queued for the server as `log` messages. Lines are built from
 * names, ids, and states only, never from secrets or task output.
 */
export class WorkerLog {
    readonly #pending: WorkerLogLine[] = [];
    #writes = Promise.resolve();

    constructor(
        private readonly home: Pick<WorkerHome, 'logPath' | 'ensure'>,
        private name: string,
        private readonly now: () => Date = () => new Date()
    ) {}

    rename(name: string): void {
        this.name = name;
    }

    write(text: string): WorkerLogLine {
        const at = this.now();
        const line = { at: at.toISOString(), text: plain(text) };
        this.#pending.push(line);
        // Bounded, so a long offline period cannot grow memory without limit.
        if (this.#pending.length > 500)
            this.#pending.splice(0, this.#pending.length - 500);
        const formatted = `[${this.name}] ${clock(at)} ${line.text}\n`;
        this.#writes = this.#writes
            .then(async () => {
                await this.home.ensure();
                await appendFile(this.home.logPath, formatted, { mode: 0o600 });
            })
            .catch(() => {});
        return line;
    }

    /** Lines not yet sent, removed from the queue. */
    take(): WorkerLogLine[] {
        return this.#pending.splice(0, this.#pending.length);
    }

    /** Puts lines back at the front after a send failed. */
    restore(lines: WorkerLogLine[]): void {
        this.#pending.unshift(...lines);
    }

    async flush(): Promise<void> {
        await this.#writes;
    }
}

/** `HH:MM:SS` in local time, as the log prints it. */
export function clock(at: Date): string {
    return [at.getHours(), at.getMinutes(), at.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
}

/** `12m 8s`, `4s`, or `1h 2m`. */
export function duration(milliseconds: number): string {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${rest}s`;
    return `${rest}s`;
}

/** A short, single-line excerpt for a log line. */
export function excerpt(value: string, length = 40): string {
    const line = plain(value).trim();
    return line.length > length ? `${line.slice(0, length - 3)}...` : line;
}

function plain(value: string): string {
    return value.replace(/\p{Cc}+/gu, ' ');
}
