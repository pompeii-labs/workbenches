import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { workbenchHome } from '../storage.js';
import { RegistryClient } from './client.js';

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

/** A held organization key together with the API URL it belongs to. */
export interface RegistryAccount extends RegistryOrganizationKey {
    url: string;
}

export interface RegistryProfile {
    organization: { id: string; slug: string; name: string; personal: boolean };
    user: { id: string; email: string } | null;
    scopes: string[];
    key: { id: string; label: string | null; expires_at: string };
}

export interface RegistryAccountStoreOptions {
    home?: string;
    client?: RegistryClient;
}

export interface RegistryOrganizationList {
    defaultSlug: string | undefined;
    organizations: RegistryAccount[];
}

export interface RegistrySignOut {
    account: RegistryAccount;
    revoked: boolean;
    cleared: boolean;
}

interface RegistryEntry {
    url: string;
    defaultSlug: string;
    organizations: RegistryOrganizationKey[];
}

interface CredentialFile {
    version: 2;
    registries: RegistryEntry[];
}

interface CredentialState {
    registries: RegistryEntry[];
    legacy: boolean;
}

export class RegistryAccountStore {
    readonly home: string;
    readonly client: RegistryClient;

    constructor(options: RegistryAccountStoreOptions = {}) {
        this.home = options.home ?? workbenchHome();
        this.client = options.client ?? new RegistryClient();
    }

    /** The requested held organization, or the default one for this API URL. */
    async current(slugOverride?: string): Promise<RegistryAccount | undefined> {
        const { defaultSlug, organizations } = await this.list();
        const slug = slugOverride ?? defaultSlug;
        return organizations.find((account) => account.slug === slug);
    }

    async list(): Promise<RegistryOrganizationList> {
        const { registries } = await this.read();
        const entry = registries.find(
            (candidate) => candidate.url === this.client.apiUrl
        );
        return {
            defaultSlug: entry?.defaultSlug,
            organizations: (entry?.organizations ?? []).map((organization) => ({
                ...organization,
                url: this.client.apiUrl,
            })),
        };
    }

    async save(
        key: RegistryOrganizationKey,
        options: { makeDefault?: boolean } = {}
    ): Promise<void> {
        const state = await this.read();
        const existing = state.registries.find(
            (candidate) => candidate.url === this.client.apiUrl
        );
        const organizations = [
            ...(existing?.organizations ?? []).filter(
                (candidate) => candidate.slug !== key.slug
            ),
            key,
        ];
        const defaultSlug =
            options.makeDefault || !existing?.defaultSlug
                ? key.slug
                : existing.defaultSlug;
        await this.write(this.replace(state, { organizations, defaultSlug }));
    }

    async setDefault(slug: string): Promise<void> {
        const state = await this.read();
        const existing = state.registries.find(
            (candidate) => candidate.url === this.client.apiUrl
        );
        if (!existing?.organizations.some((candidate) => candidate.slug === slug)) {
            throw new Error(
                RegistryAccountStore.notHeld(slug, existing?.organizations)
            );
        }
        await this.write(this.replace(state, { ...existing, defaultSlug: slug }));
    }

    /**
     * Removes one held organization. If it was the default, the first
     * remaining organization becomes the default.
     */
    async remove(slug: string): Promise<void> {
        const state = await this.read();
        const existing = state.registries.find(
            (candidate) => candidate.url === this.client.apiUrl
        );
        if (!existing) return;
        const organizations = existing.organizations.filter(
            (candidate) => candidate.slug !== slug
        );
        const defaultSlug =
            existing.defaultSlug === slug
                ? (organizations[0]?.slug ?? '')
                : existing.defaultSlug;
        await this.write(this.replace(state, { organizations, defaultSlug }));
    }

    /**
     * Revokes the key on the server (best effort) and forgets it locally.
     * Without a slug it signs out of the default organization.
     */
    async signOut(slugOverride?: string): Promise<RegistrySignOut | undefined> {
        const account = await this.current(slugOverride);
        if (!account) return undefined;
        const revoked = await this.client
            .request(`/v1/keys/${account.keyId}`, {
                method: 'DELETE',
                token: account.token,
            })
            .then(() => true)
            .catch(() => false);
        await this.remove(account.slug);
        return {
            account,
            revoked,
            cleared: (await this.list()).organizations.length === 0,
        };
    }

    async require(slugOverride?: string): Promise<RegistryAccount> {
        const account = await this.current(slugOverride);
        if (!account) {
            const { legacy } = await this.read();
            if (legacy) {
                throw new Error(
                    'Saved Workbench logins from an older CLI are no longer valid. Run wb login once to sign in again.'
                );
            }
            const { organizations } = await this.list();
            if (slugOverride && organizations.length > 0) {
                throw new Error(
                    RegistryAccountStore.notHeld(slugOverride, organizations)
                );
            }
            throw new Error(
                slugOverride
                    ? `Not signed in to organization ${slugOverride}. Run wb login --org ${slugOverride}`
                    : 'Sign in first with wb login'
            );
        }
        if (new Date(account.expiresAt) <= new Date()) {
            throw new Error(
                `Your Workbench CLI login for ${account.slug} has expired. Run wb login --org ${account.slug} again.`
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

    private static notHeld(
        slug: string,
        held: Array<{ slug: string }> | undefined
    ): string {
        const slugs = (held ?? []).map((candidate) => candidate.slug);
        return slugs.length > 0
            ? `Not signed in to organization ${slug}. Held: ${slugs.join(', ')}. Run wb login --org ${slug}`
            : `Not signed in to organization ${slug}. Run wb login --org ${slug}`;
    }

    private replace(
        state: CredentialState,
        update: { organizations: RegistryOrganizationKey[]; defaultSlug: string }
    ): RegistryEntry[] {
        const others = state.registries.filter(
            (candidate) => candidate.url !== this.client.apiUrl
        );
        if (update.organizations.length === 0) return others;
        return [
            ...others,
            {
                url: this.client.apiUrl,
                defaultSlug: update.defaultSlug,
                organizations: update.organizations,
            },
        ];
    }

    private async read(): Promise<CredentialState> {
        const source = await readFile(
            join(this.home, 'credentials.json'),
            'utf8'
        ).catch(() => null);
        if (!source) return { registries: [], legacy: false };
        const parsed: unknown = JSON.parse(source);
        if (!RegistryAccountStore.isRecord(parsed)) {
            throw new Error('The Workbench credential file is invalid');
        }
        // Version 1 tokens are invalid server side, so they are discarded.
        if (parsed.version === 1) return { registries: [], legacy: true };
        if (parsed.version !== 2 || !Array.isArray(parsed.registries)) {
            throw new Error('The Workbench credential file is invalid');
        }
        return {
            registries: parsed.registries.map(RegistryAccountStore.parseRegistry),
            legacy: false,
        };
    }

    private async write(registries: RegistryEntry[]): Promise<void> {
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
            !RegistryAccountStore.isRecord(value) ||
            typeof value.url !== 'string' ||
            typeof value.defaultSlug !== 'string' ||
            !Array.isArray(value.organizations)
        ) {
            throw new Error('The Workbench credential file is invalid');
        }
        return {
            url: value.url,
            defaultSlug: value.defaultSlug,
            organizations: value.organizations.map(RegistryAccountStore.parseKey),
        };
    }

    private static parseKey(value: unknown): RegistryOrganizationKey {
        if (
            !RegistryAccountStore.isRecord(value) ||
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
