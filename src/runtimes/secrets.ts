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

type RuntimeSecretProvider = 'e2b' | 'daytona';

interface RuntimeSecretFile {
    version: 1;
    e2b?: { api_key: string };
    daytona?: { api_key: string };
}

const filename = 'runtime.secrets.json';
const maximumBytes = 64 * 1024;

/** Host-only sandbox provisioning credentials, never runner environment. */
export class RuntimeSecretStore {
    constructor(readonly home = workbenchHome()) {}

    static e2bKey(
        environment: Record<string, string | undefined> = process.env
    ): string | undefined {
        return (
            environment.E2B_API_KEY?.trim() ||
            new RuntimeSecretStore(workbenchHome(environment)).e2bKey()
        );
    }

    e2bKey(): string | undefined {
        return this.read().e2b?.api_key;
    }

    static daytonaKey(
        environment: Record<string, string | undefined> = process.env
    ): string | undefined {
        return (
            environment.DAYTONA_API_KEY?.trim() ||
            new RuntimeSecretStore(workbenchHome(environment)).daytonaKey()
        );
    }

    daytonaKey(): string | undefined {
        return this.read().daytona?.api_key;
    }

    saveE2B(key: string): void {
        this.save('e2b', key, 'E2B');
    }

    saveDaytona(key: string): void {
        this.save('daytona', key, 'Daytona');
    }

    removeE2B(): void {
        this.remove('e2b');
    }

    removeDaytona(): void {
        this.remove('daytona');
    }

    private save(provider: RuntimeSecretProvider, key: string, label: string): void {
        const value = key.trim();
        if (!value || /[\r\n\0]/.test(value)) {
            throw new Error(`${label} API key must be a non-empty single line`);
        }
        this.write({ ...this.read(), [provider]: { api_key: value } });
    }

    private remove(provider: RuntimeSecretProvider): void {
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
