import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A key for one organization, as stored per API URL. */
export interface RegistryOrganizationKey {
    organizationId: string;
    slug: string;
    name: string;
    personal: boolean;
    token: string;
    keyId: string;
    scopes: string[];
    expiresAt: string;
    email?: string;
}

export interface RegistryEntry {
    url: string;
    defaultSlug: string;
    organizations: RegistryOrganizationKey[];
}

export interface CredentialState {
    registries: RegistryEntry[];
    legacy: boolean;
}

interface CredentialFile {
    version: 2;
    registries: RegistryEntry[];
}

/** Owns reading and writing credentials.json. It never touches the network. */
export class RegistryCredentialFile {
    constructor(readonly home: string) {}

    async read(): Promise<CredentialState> {
        const source = await readFile(
            join(this.home, 'credentials.json'),
            'utf8'
        ).catch(() => null);
        if (!source) return { registries: [], legacy: false };
        const parsed: unknown = JSON.parse(source);
        if (!RegistryCredentialFile.isRecord(parsed)) {
            throw new Error('The Workbench credential file is invalid');
        }
        // Version 1 tokens are invalid server side, so they are discarded.
        if (parsed.version === 1) return { registries: [], legacy: true };
        if (parsed.version !== 2 || !Array.isArray(parsed.registries)) {
            throw new Error('The Workbench credential file is invalid');
        }
        return {
            registries: parsed.registries.map(RegistryCredentialFile.parseRegistry),
            legacy: false,
        };
    }

    async write(registries: RegistryEntry[]): Promise<void> {
        const path = join(this.home, 'credentials.json');
        if (registries.length === 0) {
            await rm(path, { force: true });
            return;
        }
        await mkdir(this.home, { recursive: true });
        const temporary = join(this.home, `credentials.${crypto.randomUUID()}.tmp`);
        const contents: CredentialFile = { version: 2, registries };
        await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, {
            mode: 0o600,
        });
        await rename(temporary, path);
        await chmod(path, 0o600);
    }

    private static parseRegistry(value: unknown): RegistryEntry {
        if (
            !RegistryCredentialFile.isRecord(value) ||
            typeof value.url !== 'string' ||
            typeof value.defaultSlug !== 'string' ||
            !Array.isArray(value.organizations)
        ) {
            throw new Error('The Workbench credential file is invalid');
        }
        return {
            url: value.url,
            defaultSlug: value.defaultSlug,
            organizations: value.organizations.map(RegistryCredentialFile.parseKey),
        };
    }

    private static parseKey(value: unknown): RegistryOrganizationKey {
        if (
            !RegistryCredentialFile.isRecord(value) ||
            typeof value.organizationId !== 'string' ||
            typeof value.slug !== 'string' ||
            typeof value.name !== 'string' ||
            typeof value.personal !== 'boolean' ||
            typeof value.token !== 'string' ||
            typeof value.keyId !== 'string' ||
            !Array.isArray(value.scopes) ||
            !value.scopes.every((scope) => typeof scope === 'string') ||
            typeof value.expiresAt !== 'string' ||
            (value.email !== undefined && typeof value.email !== 'string')
        ) {
            throw new Error('The Workbench credential file is invalid');
        }
        return {
            organizationId: value.organizationId,
            slug: value.slug,
            name: value.name,
            personal: value.personal,
            token: value.token,
            keyId: value.keyId,
            scopes: value.scopes as string[],
            expiresAt: value.expiresAt,
            ...(value.email !== undefined ? { email: value.email } : {}),
        };
    }

    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
}
