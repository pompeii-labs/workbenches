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

interface RuntimeSecretFile {
    version: 1;
    e2b?: { api_key: string };
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

    saveE2B(key: string): void {
        const value = key.trim();
        if (!value || /[\r\n\0]/.test(value)) {
            throw new Error('E2B API key must be a non-empty single line');
        }
        this.write({ ...this.read(), e2b: { api_key: value } });
    }

    removeE2B(): void {
        const current = this.read();
        if (!current.e2b) return;
        this.write({ version: 1 });
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
                (parsed.e2b !== undefined &&
                    (!isRecord(parsed.e2b) ||
                        typeof parsed.e2b.api_key !== 'string' ||
                        !parsed.e2b.api_key))
            ) {
                throw new Error('The Workbench runtime secret store is invalid');
            }
            return parsed.e2b === undefined
                ? { version: 1 }
                : { version: 1, e2b: { api_key: parsed.e2b.api_key as string } };
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
    return isRecord(error) && error.code === 'ENOENT';
}
