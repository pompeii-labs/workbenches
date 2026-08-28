import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { workbenchHome } from '../storage.js';
import { RegistryClient } from './client.js';

export interface RegistryAccount {
    url: string;
    token: string;
    tokenId: string;
    email: string;
    expiresAt: string;
}

export interface RegistryProfile {
    user: { id: string; email: string };
    publishers: Array<{ id: string; slug: string; name: string }>;
}

export interface RegistryAccountStoreOptions {
    home?: string;
    client?: RegistryClient;
}

interface CredentialFile {
    version: 1;
    accounts: RegistryAccount[];
}

export class RegistryAccountStore {
    readonly home: string;
    readonly client: RegistryClient;

    constructor(options: RegistryAccountStoreOptions = {}) {
        this.home = options.home ?? workbenchHome();
        this.client = options.client ?? new RegistryClient();
    }

    async current(): Promise<RegistryAccount | undefined> {
        const accounts = await this.read();
        return accounts.find((account) => account.url === this.client.apiUrl);
    }

    async save(account: RegistryAccount): Promise<void> {
        const accounts = (await this.read()).filter(
            (candidate) => candidate.url !== account.url
        );
        await this.write([...accounts, account]);
    }

    async remove(): Promise<void> {
        await this.write(
            (await this.read()).filter((account) => account.url !== this.client.apiUrl)
        );
    }

    async require(): Promise<RegistryAccount> {
        const account = await this.current();
        if (!account) throw new Error('Sign in first with wb login');
        if (new Date(account.expiresAt) <= new Date()) {
            throw new Error(
                'Your Workbench CLI login has expired. Run wb login again.'
            );
        }
        return account;
    }

    async profile(account?: RegistryAccount): Promise<RegistryProfile> {
        const authenticated = account ?? (await this.require());
        return this.client.request<RegistryProfile>('/v1/profile', {
            token: authenticated.token,
        });
    }

    private async read(): Promise<RegistryAccount[]> {
        const source = await readFile(
            join(this.home, 'credentials.json'),
            'utf8'
        ).catch(() => null);
        if (!source) return [];
        const parsed: unknown = JSON.parse(source);
        if (
            !RegistryAccountStore.isRecord(parsed) ||
            parsed.version !== 1 ||
            !Array.isArray(parsed.accounts)
        ) {
            throw new Error('The Workbench credential file is invalid');
        }
        return parsed.accounts.map((value) => {
            if (
                !RegistryAccountStore.isRecord(value) ||
                typeof value.url !== 'string' ||
                typeof value.token !== 'string' ||
                typeof value.tokenId !== 'string' ||
                typeof value.email !== 'string' ||
                typeof value.expiresAt !== 'string'
            ) {
                throw new Error('The Workbench credential file is invalid');
            }
            return {
                url: value.url,
                token: value.token,
                tokenId: value.tokenId,
                email: value.email,
                expiresAt: value.expiresAt,
            };
        });
    }

    private async write(accounts: RegistryAccount[]): Promise<void> {
        await mkdir(this.home, { recursive: true });
        const path = join(this.home, 'credentials.json');
        const temporary = join(this.home, `credentials.${crypto.randomUUID()}.tmp`);
        const contents: CredentialFile = { version: 1, accounts };
        await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, {
            mode: 0o600,
        });
        await rename(temporary, path);
        await chmod(path, 0o600);
    }

    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
}
