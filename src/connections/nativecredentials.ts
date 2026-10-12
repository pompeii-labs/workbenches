import { RunnerRegistry } from '../runners/registry.js';
import type { RuntimeCredentialFiles } from '../runtimes/contracts.js';

/** One provider's entry in a runner's native credential file. */
export interface NativeCredentialEntry {
    /** The runner's credential type, such as `api`, `api_key`, or `oauth`. */
    readonly type: string | undefined;
    readonly value: Record<string, unknown>;
}

/**
 * A runner's documented credential file inside a Workbench credential store: a
 * JSON object keyed by native provider, at the path the runner declares. Entry
 * values are secrets and are never printed. Workbench never reads the user's
 * own runner files.
 */
export class NativeCredentialFile {
    private constructor(
        readonly runner: string,
        /** The file's path relative to a credential root. */
        readonly path: string,
        private readonly apiKeyEntryType: string,
        /** A stored entry decides readiness alone, ahead of provider variables. */
        readonly storeFirst: boolean
    ) {}

    static for(
        runner: string,
        runners: Pick<RunnerRegistry, 'find'> = RunnerRegistry.standard()
    ): NativeCredentialFile {
        const credentials = runners.find(runner)?.credentials;
        if (!credentials) throw new Error(`Unsupported runner: ${runner}`);
        return new NativeCredentialFile(
            runner,
            credentials.file,
            credentials.apiKeyEntryType,
            credentials.storeFirst
        );
    }

    /** The entry an API key becomes in this runner's format. */
    apiKey(key: string): NativeCredentialEntry {
        const trimmed = key.trim();
        if (!trimmed) throw new Error('The API key is empty');
        // `NAME=value` is an env-file line; a bare `=` can be base64 padding in a real key.
        if (/\s/.test(trimmed) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
            throw new Error(
                'The API key contains whitespace or starts with NAME=; give only the key value, not an env-file line'
            );
        }
        return {
            type: this.apiKeyEntryType,
            value: { type: this.apiKeyEntryType, key: trimmed },
        };
    }

    /** Whether `entry` can serve an `api`, `oauth`, or `native` (any) method. */
    serves(entry: NativeCredentialEntry, method: string): boolean {
        if (method === 'api') return entry.type === this.apiKeyEntryType;
        if (method === 'oauth') return entry.type === 'oauth';
        return true;
    }

    async find(
        files: RuntimeCredentialFiles,
        provider: string
    ): Promise<NativeCredentialEntry | undefined> {
        const value = (await this.document(files))[provider];
        if (!isRecord(value)) return undefined;
        return {
            type: typeof value.type === 'string' ? value.type : undefined,
            value,
        };
    }

    /** Adds or replaces `provider`, keeping every other entry. */
    async save(
        files: RuntimeCredentialFiles,
        provider: string,
        entry: NativeCredentialEntry
    ): Promise<void> {
        const document = await this.document(files);
        document[provider] = entry.value;
        await files.write(this.path, `${JSON.stringify(document, null, 2)}\n`);
    }

    /** Removes `provider`, keeping every other entry. False when it was absent. */
    async remove(files: RuntimeCredentialFiles, provider: string): Promise<boolean> {
        const document = await this.document(files);
        if (!Object.hasOwn(document, provider)) return false;
        delete document[provider];
        await files.write(this.path, `${JSON.stringify(document, null, 2)}\n`);
        return true;
    }

    private async document(
        files: RuntimeCredentialFiles
    ): Promise<Record<string, unknown>> {
        const source = await files.read(this.path);
        if (!source?.trim()) return {};
        let value: unknown;
        try {
            value = JSON.parse(source);
        } catch {
            value = undefined;
        }
        if (!isRecord(value)) {
            throw new Error(
                `The ${this.runner} credential file ${this.path} is not a JSON object; it was left unchanged`
            );
        }
        return value;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
