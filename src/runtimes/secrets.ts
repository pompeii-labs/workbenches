import { randomUUID } from 'node:crypto';
import {
    chmodSync,
    closeSync,
    constants,
    fstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { workbenchHome } from '../storage.js';

/** The sandbox providers that need a host-only API key. */
export type RuntimeKeyProvider = 'e2b' | 'daytona';

interface RuntimeSecretFile {
    version: 1;
    e2b?: { api_key: string };
    daytona?: { api_key: string };
}

const filename = 'runtime.secrets.json';
const maximumBytes = 64 * 1024;

/** Host-only sandbox provisioning credentials, never runner environment. */
export class RuntimeSecretStore {
    /** What each provider's key is called to a person and in the environment. */
    static readonly providers = {
        e2b: { label: 'E2B', variable: 'E2B_API_KEY' },
        daytona: { label: 'Daytona', variable: 'DAYTONA_API_KEY' },
    } as const;

    constructor(readonly home = workbenchHome()) {}

    /** The provider's key from `environment`, else the key saved in its Workbench home. */
    static key(
        provider: RuntimeKeyProvider,
        environment: Record<string, string | undefined>
    ): string | undefined {
        return (
            environment[RuntimeSecretStore.providers[provider].variable]?.trim() ||
            new RuntimeSecretStore(workbenchHome(environment)).key(provider)
        );
    }

    /** The key saved for the provider, ignoring the environment. */
    key(provider: RuntimeKeyProvider): string | undefined {
        return this.read()[provider]?.api_key;
    }

    save(provider: RuntimeKeyProvider, key: string): void {
        const value = key.trim();
        if (!value || /[\r\n\0]/.test(value)) {
            throw new Error(
                `${RuntimeSecretStore.providers[provider].label} API key must be a non-empty single line`
            );
        }
        this.write({ ...this.read(), [provider]: { api_key: value } });
    }

    remove(provider: RuntimeKeyProvider): void {
        const current = this.read();
        if (!current[provider]) return;
        const { [provider]: _removed, ...remaining } = current;
        this.write(remaining);
    }

    private read(): RuntimeSecretFile {
        const path = join(this.home, filename);
        let descriptor: number;
        try {
            descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
            if (isMissing(error)) return { version: 1 };
            throw new Error(`Cannot read the Workbench runtime secret store: ${path}`);
        }
        try {
            const details = fstatSync(descriptor);
            if (!details.isFile() || details.size > maximumBytes) {
                throw new Error('The Workbench runtime secret store is invalid');
            }
            if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
                throw new Error(
                    'The Workbench runtime secret store is not private (expected mode 0600)'
                );
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(readFileSync(descriptor, 'utf8'));
            } catch {
                throw new Error('The Workbench runtime secret store is invalid');
            }
            if (
                !isRecord(parsed) ||
                parsed.version !== 1 ||
                !validKey(parsed.e2b) ||
                !validKey(parsed.daytona)
            ) {
                throw new Error('The Workbench runtime secret store is invalid');
            }
            return {
                version: 1,
                ...(parsed.e2b ? { e2b: { api_key: keyOf(parsed.e2b) } } : {}),
                ...(parsed.daytona
                    ? { daytona: { api_key: keyOf(parsed.daytona) } }
                    : {}),
            };
        } finally {
            closeSync(descriptor);
        }
    }

    private write(value: RuntimeSecretFile): void {
        mkdirSync(this.home, { recursive: true, mode: 0o700 });
        const path = join(this.home, filename);
        const temporary = join(this.home, `${filename}.${randomUUID()}.tmp`);
        try {
            writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
                flag: 'wx',
                mode: 0o600,
            });
            renameSync(temporary, path);
            chmodSync(path, 0o600);
        } finally {
            rmSync(temporary, { force: true });
        }
    }
}

/** An absent entry is valid. A present one must hold a non-empty key. */
function validKey(entry: unknown): boolean {
    return (
        entry === undefined ||
        (isRecord(entry) && typeof entry.api_key === 'string' && entry.api_key !== '')
    );
}

function keyOf(entry: unknown): string {
    return (entry as { api_key: string }).api_key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
    return isRecord(error) && error.code === 'ENOENT';
}
