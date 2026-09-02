import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const promptHistoryLimit = 50;

export interface PromptHistoryEntry {
    text: string;
}

export class PromptHistory {
    readonly #path: string;
    #entries: PromptHistoryEntry[] = [];
    #index = 0;

    constructor(home: string) {
        this.#path = join(home, 'prompt-history.jsonl');
    }

    async load(): Promise<void> {
        const source = await readFile(this.#path, 'utf8').catch((error) => {
            if (isMissingFile(error)) return '';
            throw error;
        });
        this.#entries = parsePromptHistory(source);
        this.#index = 0;
        if (source && this.#entries.length > 0) await this.#rewrite();
    }

    move(direction: 1 | -1, current: string): string | undefined {
        if (this.#entries.length === 0) return undefined;
        const selected = this.#entries.at(this.#index);
        if (selected && selected.text !== current && current.length > 0)
            return undefined;

        const next = this.#index + direction;
        if (next > 0 || Math.abs(next) > this.#entries.length) return undefined;
        this.#index = next;
        return this.#index === 0 ? '' : this.#entries.at(this.#index)?.text;
    }

    async append(text: string): Promise<void> {
        const value = text.trim();
        if (!value) return;
        const entry = { text: value };
        if (isDuplicateEntry(this.#entries.at(-1), entry)) {
            this.#index = 0;
            return;
        }

        this.#entries.push(entry);
        this.#index = 0;
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        if (this.#entries.length > promptHistoryLimit) {
            this.#entries = this.#entries.slice(-promptHistoryLimit);
            await this.#rewrite();
            return;
        }
        await appendFile(this.#path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    }

    reset(): void {
        this.#index = 0;
    }

    async #rewrite(): Promise<void> {
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        const temporary = `${this.#path}.${process.pid}.tmp`;
        const source = this.#entries.map((entry) => JSON.stringify(entry)).join('\n');
        await writeFile(temporary, source ? `${source}\n` : '', { mode: 0o600 });
        await rename(temporary, this.#path);
    }
}

export function parsePromptHistory(source: string): PromptHistoryEntry[] {
    return source
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            try {
                const value = JSON.parse(line) as unknown;
                return isPromptHistoryEntry(value) ? value : undefined;
            } catch {
                return undefined;
            }
        })
        .filter((entry): entry is PromptHistoryEntry => entry !== undefined)
        .slice(-promptHistoryLimit);
}

function isPromptHistoryEntry(value: unknown): value is PromptHistoryEntry {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as Partial<PromptHistoryEntry>).text === 'string'
    );
}

function isDuplicateEntry(
    previous: PromptHistoryEntry | undefined,
    next: PromptHistoryEntry
): boolean {
    return previous?.text === next.text;
}

function isMissingFile(error: unknown): boolean {
    return (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
    );
}
