import { WorkbenchPackage } from '../catalog/index.js';
import type { ResolvedWorkbench } from '../types.js';
import type { RegistryAccount } from './account-store.js';
import { RegistryAccountStore } from './account-store.js';
import type {
    RegistryPackage,
    RegistryReference,
    RegistryVisibility,
} from './client.js';

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface RegistryPushedVersion {
    reference: RegistryReference;
    workbenchId: string;
    visibility: RegistryVisibility;
    versionId: string;
    version: string;
    /** Package digest, `sha256:` prefixed. */
    digest: string;
}

export interface RegistrySubmission {
    id: string;
    status: string;
    reference: RegistryReference;
    version: string;
    digest: string;
    dashboardUrl: string;
    latestApprovedVersion: string | null;
}

/**
 * Owns the organization-facing registry lifecycle: push a stored version,
 * submit a stored version for public review, and unpublish. Every call uses
 * the held key of the named organization.
 */
export class RegistryPublisher {
    constructor(readonly accounts: RegistryAccountStore = new RegistryAccountStore()) {}

    /** The held key for `slug`, or the default organization when omitted. */
    account(slug?: string): Promise<RegistryAccount> {
        return this.accounts.require(slug);
    }

    /** Uploads the package as a new immutable version. Internal unless already public. */
    async push(
        account: RegistryAccount,
        workbench: ResolvedWorkbench,
        options: { slug?: string; progress?: (message: string) => void } = {}
    ): Promise<RegistryPushedVersion> {
        const slug = options.slug ?? workbench.manifest.name;
        if (!slugPattern.test(slug)) {
            throw new Error(`Workbench name is not a valid registry slug: ${slug}`);
        }
        options.progress?.(`Preparing ${account.slug}/${slug}`);
        const files = await new WorkbenchPackage(workbench).files();
        const total = files.reduce((bytes, file) => bytes + file.bytes.byteLength, 0);
        if (files.length > 256) {
            throw new Error('Workbench package exceeds 256 files');
        }
        if (total > 10 * 1024 * 1024) {
            throw new Error('Workbench package exceeds 10485760 bytes');
        }
        const oversized = files.find((file) => file.bytes.byteLength > 2 * 1024 * 1024);
        if (oversized) {
            throw new Error(`Workbench package file is too large: ${oversized.path}`);
        }
        const digest = WorkbenchPackage.digest(files);
        options.progress?.(`Pushing ${account.slug}/${slug}`);
        const response = await this.accounts.client.request<{
            workbench?: {
                id?: string;
                slug?: string;
                organization_slug?: string;
                visibility?: string;
            };
            version?: { id?: string; version?: string; digest?: string };
        }>('/v1/versions', {
            method: 'POST',
            token: account.token,
            timeout: 60_000,
            body: {
                organization_id: account.organizationId,
                slug,
                package: {
                    format: 1,
                    files: files.map((file) => ({
                        path: file.path,
                        content: Buffer.from(file.bytes).toString('base64'),
                        executable: file.executable,
                    })),
                },
            },
        });
        const stored = response.workbench;
        const version = response.version;
        if (
            !stored?.id ||
            !stored.slug ||
            !stored.organization_slug ||
            (stored.visibility !== 'public' && stored.visibility !== 'private') ||
            !version?.id ||
            !version.version ||
            !version.digest
        ) {
            throw new Error('The registry returned a malformed version record');
        }
        if (RegistryPublisher.prefixed(version.digest) !== digest) {
            throw new Error('The registry returned a different package digest');
        }
        return {
            reference: { publisher: stored.organization_slug, workbench: stored.slug },
            workbenchId: stored.id,
            visibility: stored.visibility,
            versionId: version.id,
            version: version.version,
            digest,
        };
    }

    /** Resolves `org/name` with the organization's key. */
    async resolve(
        reference: RegistryReference,
        org?: string
    ): Promise<{ account: RegistryAccount; registry: RegistryPackage }> {
        if (org && org !== reference.publisher) {
            throw new Error(
                `--org ${org} does not match ${reference.publisher}/${reference.workbench}`
            );
        }
        const account = await this.account(reference.publisher);
        const registry = await this.accounts.client.resolve(reference);
        if (!registry) throw await this.accounts.client.missing(reference);
        return { account, registry };
    }

    /** Submits a stored version for public review. */
    async submit(
        account: RegistryAccount,
        version: { id: string; digest: string }
    ): Promise<RegistrySubmission> {
        const response = await this.accounts.client.request<{
            submissions?: Array<{
                id: string;
                status: string;
                publisher_slug: string;
                slug: string;
                version: string;
                digest: string;
                dashboard_url: string;
                latest_approved_version: string | null;
            }>;
        }>('/v1/submissions', {
            method: 'POST',
            token: account.token,
            timeout: 60_000,
            body: { version_id: version.id },
        });
        const submitted = response.submissions?.[0];
        if (!submitted) throw new Error('The registry returned no submission');
        if (RegistryPublisher.prefixed(submitted.digest) !== version.digest) {
            throw new Error('The registry returned a different package digest');
        }
        return {
            id: submitted.id,
            status: submitted.status,
            reference: {
                publisher: submitted.publisher_slug,
                workbench: submitted.slug,
            },
            version: submitted.version,
            digest: version.digest,
            dashboardUrl: submitted.dashboard_url,
            latestApprovedVersion: submitted.latest_approved_version ?? null,
        };
    }

    /** Flips a public workbench back to internal immediately. */
    async unpublish(account: RegistryAccount, workbenchId: string): Promise<void> {
        const response = await this.accounts.client.request<{
            unpublished?: boolean;
        }>(`/v1/publications/${encodeURIComponent(workbenchId)}`, {
            method: 'DELETE',
            token: account.token,
        });
        if (response.unpublished !== true) {
            throw new Error('The registry did not confirm the unpublish');
        }
    }

    private static prefixed(digest: string): string {
        return digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
    }
}
