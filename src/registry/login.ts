import { hostname, platform } from 'node:os';

import type {
    RegistryAccount,
    RegistryAccountStore,
    RegistryOrganizationKey,
} from './account-store.js';
import type { RegistryClient } from './client.js';

interface LoginRequest {
    id: string;
    code: string;
    secret: string;
    verification_url: string;
    expires_at: string;
    interval: number;
}

interface CompletedToken {
    status: 'complete';
    token: string;
    key_id: string;
    organization: { id: string; slug: string; name: string; personal: boolean };
    scopes: string[];
    expires_at: string;
}

type TokenResponse = { status: 'pending' } | CompletedToken;

export interface RegistryLoginOptions {
    client: RegistryClient;
    accounts: RegistryAccountStore;
    /** Advisory: fail without storing if the approved organization differs. */
    organization?: string;
    onProgress?: (message: string) => void;
    onApproval?: (approval: { url: string; code: string }) => void;
    wait?: (milliseconds: number) => Promise<void>;
}

export interface RegistryLoginResult {
    account: RegistryAccount;
    isDefault: boolean;
}

/** Runs the browser device flow and stores the key for the approved organization. */
export class RegistryLogin {
    constructor(private readonly options: RegistryLoginOptions) {}

    async run(): Promise<RegistryLoginResult> {
        const { client } = this.options;
        const wait =
            this.options.wait ??
            ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
        this.options.onProgress?.('Starting browser sign-in');
        const login = await client.request<LoginRequest>('/v1/logins', {
            method: 'POST',
            body: { label: `${hostname()} (${platform()})` },
        });
        this.options.onApproval?.({ url: login.verification_url, code: login.code });
        this.options.onProgress?.('Waiting for approval');

        while (new Date(login.expires_at) > new Date()) {
            await wait(login.interval * 1000);
            const result = await client.request<TokenResponse>('/v1/tokens', {
                method: 'POST',
                body: { login_id: login.id, secret: login.secret },
            });
            if (result.status === 'pending') continue;
            return this.store(result);
        }
        throw new Error('The CLI login expired before it was approved');
    }

    private async store(result: CompletedToken): Promise<RegistryLoginResult> {
        const { client, accounts, organization } = this.options;
        const slug = result.organization.slug;
        if (organization && organization !== slug) {
            const revoked = await client
                .request(`/v1/keys/${result.key_id}`, {
                    method: 'DELETE',
                    token: result.token,
                })
                .then(() => true)
                .catch(() => false);
            throw new Error(
                `Approved organization ${slug} does not match --org ${organization}. Nothing was saved and the new key ${revoked ? 'was revoked' : 'could not be revoked'}. Approve ${organization} in the browser and try again.`
            );
        }
        const key: RegistryOrganizationKey = {
            organizationId: result.organization.id,
            slug,
            name: result.organization.name,
            personal: result.organization.personal,
            token: result.token,
            keyId: result.key_id,
            scopes: result.scopes,
            expiresAt: result.expires_at,
        };
        const profile = await accounts.profile({ ...key, url: client.apiUrl });
        const email = profile.user?.email;
        const held = await accounts.list();
        const makeDefault = Boolean(organization) || !held.defaultSlug;
        const stored = { ...key, ...(email ? { email } : {}) };
        await accounts.save(stored, { makeDefault });
        return {
            account: { ...stored, url: client.apiUrl },
            isDefault: (await accounts.list()).defaultSlug === slug,
        };
    }
}
