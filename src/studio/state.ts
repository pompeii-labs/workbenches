import { randomBytes } from 'node:crypto';
import {
    chmodSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { isRecord } from './values.js';

export interface StudioStateRecord {
    server_pid: number;
    api_port: number;
    ui_port: number;
    container_id: string;
    token: string;
    image: string;
    created_at: string;
}

/**
 * The running local Studio, kept in one file only this user can read because
 * it holds the API token. Each write replaces the file whole, so a reader
 * never sees a partial record, and removing the file is how Studio is cleared.
 */
export class StudioState {
    constructor(readonly path: string) {}

    read(): StudioStateRecord | undefined {
        let text: string;
        try {
            text = readFileSync(this.path, 'utf8');
        } catch (error) {
            if (missing(error)) return undefined;
            throw error;
        }
        return this.parse(text);
    }

    write(record: StudioStateRecord): void {
        const directory = dirname(this.path);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const details = lstatSync(directory);
        if (!details.isDirectory() || details.isSymbolicLink())
            throw new Error(`Studio state must use a real directory: ${directory}`);
        chmodSync(directory, 0o700);
        const temporary = join(
            directory,
            `.${basename(this.path)}.${randomBytes(8).toString('hex')}.tmp`
        );
        try {
            writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
                mode: 0o600,
                flag: 'wx',
            });
            renameSync(temporary, this.path);
        } catch (error) {
            rmSync(temporary, { force: true });
            throw error;
        }
    }

    clear(): void {
        rmSync(this.path, { force: true });
    }

    private parse(text: string): StudioStateRecord {
        let value: unknown;
        try {
            value = JSON.parse(text);
        } catch {
            throw this.invalid();
        }
        if (!isRecord(value)) throw this.invalid();
        const {
            server_pid,
            api_port,
            ui_port,
            container_id,
            token,
            image,
            created_at,
        } = value;
        if (
            !integer(server_pid) ||
            !integer(api_port) ||
            !integer(ui_port) ||
            typeof container_id !== 'string' ||
            typeof token !== 'string' ||
            typeof image !== 'string' ||
            typeof created_at !== 'string'
        )
            throw this.invalid();
        return {
            server_pid,
            api_port,
            ui_port,
            container_id,
            token,
            image,
            created_at,
        };
    }

    private invalid(): Error {
        return new Error(
            `Studio state is invalid: ${this.path}. Remove it and run wb studio again.`
        );
    }
}

function integer(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

function missing(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
