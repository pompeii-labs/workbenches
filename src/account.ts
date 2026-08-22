import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { registryApiUrl } from './registry.js';
import { workbenchHome } from './storage.js';
import { WORKBENCH_USER_AGENT } from './user-agent.js';

export interface Account {
    url: string;
    token: string;
    tokenId: string;
    email: string;
    expiresAt: string;
}

interface CredentialFile {
    version: 1;
    accounts: Account[];
}

export interface RegistryProfile {
    user: { id: string; email: string };
    publishers: Array<{ id: string; slug: string; name: string }>;
}

export type RegistryFetch = (
    input: string | URL | Request,
    init?: RequestInit
) => Promise<Response>;

export async function currentAccount(
    home = workbenchHome()
): Promise<Account | undefined> {
    const accounts = await readAccounts(home);
    return accounts.find((account) => account.url === registryApiUrl());
}

export async function saveAccount(
    account: Account,
    home = workbenchHome()
): Promise<void> {
    const accounts = (await readAccounts(home)).filter(
        (candidate) => candidate.url !== account.url
    );
    await writeAccounts(home, [...accounts, account]);
}

export async function deleteAccount(home = workbenchHome()): Promise<void> {
    const url = registryApiUrl();
    await writeAccounts(
        home,
        (await readAccounts(home)).filter((account) => account.url !== url)
    );
}

export async function requireAccount(home = workbenchHome()): Promise<Account> {
    const account = await currentAccount(home);
    if (!account) throw new Error('Sign in first with wb login');
    if (new Date(account.expiresAt) <= new Date()) {
        throw new Error('Your Workbench CLI login has expired. Run wb login again.');
    }
    return account;
}

export async function registryProfile(
    account: Account,
    fetcher: RegistryFetch = fetch
): Promise<RegistryProfile> {
    return registryRequest<RegistryProfile>('/v1/profile', {
        token: account.token,
        fetcher,
    });
}

export async function registryRequest<T>(
    path: string,
    options: {
        method?: string;
        token?: string;
        body?: unknown;
        fetcher?: RegistryFetch;
        timeout?: number;
    } = {}
): Promise<T> {
    let response: Response;
    try {
        response = await (options.fetcher ?? fetch)(`${registryApiUrl()}${path}`, {
            method: options.method ?? 'GET',
            headers: {
                Accept: 'application/json',
                'User-Agent': WORKBENCH_USER_AGENT,
                ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
                ...(options.body === undefined
                    ? {}
                    : { 'Content-Type': 'application/json' }),
            },
            ...(options.body === undefined
                ? {}
                : { body: JSON.stringify(options.body) }),
            signal: AbortSignal.timeout(options.timeout ?? 20_000),
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not reach the Workbench registry: ${detail}`);
    }
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const message =
            isRecord(value) &&
            isRecord(value.error) &&
            typeof value.error.message === 'string'
                ? value.error.message
                : `Workbench registry request failed (HTTP ${response.status})`;
        throw new Error(message);
    }
    return value as T;
}

async function readAccounts(home: string): Promise<Account[]> {
    const source = await readFile(join(home, 'credentials.json'), 'utf8').catch(
        () => null
    );
    if (!source) return [];
    const parsed: unknown = JSON.parse(source);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
        throw new Error('The Workbench credential file is invalid');
    }
    return parsed.accounts.map((value) => {
        if (
            !isRecord(value) ||
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

async function writeAccounts(home: string, accounts: Account[]): Promise<void> {
    await mkdir(home, { recursive: true });
    const path = join(home, 'credentials.json');
    const temporary = join(home, `credentials.${crypto.randomUUID()}.tmp`);
    const contents: CredentialFile = { version: 1, accounts };
    await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, {
        mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
