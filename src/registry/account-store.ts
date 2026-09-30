import { workbenchHome } from '../storage.js';
import { RegistryClient } from './client.js';
import {
    type CredentialState,
    RegistryCredentialFile,
    type RegistryEntry,
    type RegistryOrganizationKey,
} from './credentials.js';

export type { RegistryOrganizationKey } from './credentials.js';

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

export class RegistryAccountStore {
    readonly home: string;
    readonly client: RegistryClient;
    readonly #file: RegistryCredentialFile;

    constructor(options: RegistryAccountStoreOptions = {}) {
        this.home = options.home ?? workbenchHome();
        this.client = options.client ?? new RegistryClient({ home: this.home });
        this.#file = new RegistryCredentialFile(this.home);
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

    private read(): Promise<CredentialState> {
        return this.#file.read();
    }

    private write(registries: RegistryEntry[]): Promise<void> {
        return this.#file.write(registries);
    }
}
