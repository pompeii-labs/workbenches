import { isAbsolute, join } from 'node:path';

import { PiConfigStaging } from '../runners/pi/config.js';
import type { RuntimeCredentialFiles } from '../runtimes/contracts.js';
import { HostCredentialFiles } from './credentials.js';

/** One provider's entry in a runner's native credential file. */
export interface NativeCredentialEntry {
    /** The runner's credential type, such as `api`, `api_key`, or `oauth`. */
    readonly type: string | undefined;
    readonly value: Record<string, unknown>;
}

/**
 * A runner's documented credential file: a JSON object keyed by native
 * provider. OpenCode keeps it at `opencode/auth.json` under its data home and
 * Pi at `auth.json` in its agent directory. Entry values are secrets and are
 * never printed.
 */
export class NativeCredentialFile {
    private constructor(
        readonly runner: string,
        /** The file's path relative to a credential root. */
        readonly path: string,
        private readonly apiType: string,
        private readonly root: (
            environment: Record<string, string | undefined>
        ) => string | undefined
    ) {}

    static for(runner: string): NativeCredentialFile {
        if (runner === 'opencode') {
            // OpenCode follows the XDG base directory layout on every platform.
            return new NativeCredentialFile(
                'opencode',
                'opencode/auth.json',
                'api',
                (environment) => {
                    const configured = environment.XDG_DATA_HOME?.trim();
                    if (configured && isAbsolute(configured)) return configured;
                    const home = environment.HOME?.trim();
                    return home ? join(home, '.local', 'share') : undefined;
                }
            );
        }
        if (runner === 'pi') {
            return new NativeCredentialFile(
                'pi',
                'auth.json',
                'api_key',
                (environment) => PiConfigStaging.directoryFor(environment)
            );
        }
        throw new Error(`Unsupported runner: ${runner}`);
    }

    /** The runner's own sign-in on this machine, for reading only. */
    host(
        environment: Record<string, string | undefined>
    ): HostCredentialFiles | undefined {
        const root = this.root(environment);
        return root ? new HostCredentialFiles(root) : undefined;
    }

    /** The entry an API key becomes in this runner's format. */
    apiKey(key: string): NativeCredentialEntry {
        const trimmed = key.trim();
        if (!trimmed) throw new Error('The API key is empty');
        return { type: this.apiType, value: { type: this.apiType, key: trimmed } };
    }

    /** Whether `entry` can serve an `api`, `oauth`, or `native` (any) method. */
    serves(entry: NativeCredentialEntry, method: string): boolean {
        if (method === 'api') return entry.type === this.apiType;
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
