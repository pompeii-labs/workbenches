import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { SessionStore } from '../sessions/index.js';
import type { TranscriptItem } from './model.js';

interface StoredTranscript {
    version: 1;
    items: TranscriptItem[];
}

export class SessionTranscript {
    readonly #path: string;
    private pending: TranscriptItem[] | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private writing: Promise<void> = Promise.resolve();

    constructor(
        home: string,
        sessionId: string,
        private readonly delayMs = 150
    ) {
        this.#path = new SessionStore(home).transcriptPath(sessionId);
    }

    async load(): Promise<TranscriptItem[]> {
        const source = await readFile(this.#path, 'utf8').catch(() => null);
        if (!source) return [];
        let value: unknown;
        try {
            value = JSON.parse(source);
        } catch {
            return [];
        }
        if (!isStoredTranscript(value)) return [];
        return value.items;
    }

    schedule(items: TranscriptItem[]): void {
        this.pending = structuredClone(items);
        if (this.timer !== undefined) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush().catch(() => {});
        }, this.delayMs);
    }

    async flush(): Promise<void> {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const items = this.pending;
        if (!items) return;
        this.pending = undefined;
        const write = this.writing.then(() => this.write(items));
        this.writing = write.catch(() => {});
        await write;
    }

    private async write(items: TranscriptItem[]): Promise<void> {
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
        await writeFile(
            temporary,
            `${JSON.stringify({ version: 1, items } satisfies StoredTranscript, null, 2)}\n`,
            { mode: 0o600 }
        );
        await rename(temporary, this.#path);
    }
}

function isStoredTranscript(value: unknown): value is StoredTranscript {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const version = Reflect.get(value, 'version');
    const items = Reflect.get(value, 'items');
    return version === 1 && Array.isArray(items) && items.every(isTranscriptItem);
}

function isTranscriptItem(value: unknown): value is TranscriptItem {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const id = Reflect.get(value, 'id');
    const kind = Reflect.get(value, 'kind');
    if (typeof id !== 'string' || typeof kind !== 'string') return false;
    if (kind === 'user' || kind === 'assistant') {
        return typeof Reflect.get(value, 'text') === 'string';
    }
    if (kind === 'notice') {
        return (
            typeof Reflect.get(value, 'text') === 'string' &&
            ['muted', 'error'].includes(String(Reflect.get(value, 'tone')))
        );
    }
    return (
        kind === 'tool' &&
        typeof Reflect.get(value, 'name') === 'string' &&
        typeof Reflect.get(value, 'title') === 'string' &&
        ['running', 'completed', 'failed'].includes(
            String(Reflect.get(value, 'status'))
        )
    );
}
