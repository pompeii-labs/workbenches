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
    /** `url` is the build page that streams its log, when the registry names one. */
    imageBuild?: { id: string; state: string; url?: string };
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
 * Owns the organization-facing registry lifecycle. Every call uses the held
 * key of the named organization.
 */
export class RegistryPublisher {
    constructor(readonly accounts: RegistryAccountStore = new RegistryAccountStore()) {}

    /** The held key for `slug`, or the default organization when omitted. */
    account(slug?: string): Promise<RegistryAccount> {
        return this.accounts.require(slug);
    }

    /** Uploads the package as a new immutable internal version. */
    async push(
        account: RegistryAccount,
        workbench: ResolvedWorkbench,
        options: { slug?: string; progress?: (message: string) => void } = {}
    ): Promise<RegistryPushedVersion> {
        const { slug, files, digest } = await RegistryPublisher.pack(
            account,
            workbench,
            options
        );
        options.progress?.(`Pushing ${account.slug}/${slug}`);
        const response = await this.accounts.client.request<{
            workbench?: {
                id?: string;
                slug?: string;
                organization_slug?: string;
                visibility?: string;
            };
            version?: {
                id?: string;
                version?: string;
                digest?: string;
                image_build?: unknown;
            };
        }>('/v1/versions', {
            method: 'POST',
            token: account.token,
            timeout: 60_000,
            body: {
                organization_id: account.organizationId,
                slug,
                package: files,
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
        const build = version.image_build;
        let imageBuild: RegistryPushedVersion['imageBuild'];
        if (build !== undefined && build !== null) {
            const url =
                typeof build === 'object' && 'dashboard_url' in build
                    ? build.dashboard_url
                    : undefined;
            // Each field becomes a column of machine output, so none may hold whitespace.
            if (
                typeof build !== 'object' ||
                !('id' in build) ||
                typeof build.id !== 'string' ||
                !/^\S+$/.test(build.id) ||
                !('state' in build) ||
                typeof build.state !== 'string' ||
                !/^[a-z_]+$/.test(build.state) ||
                (url !== undefined && !RegistryPublisher.webUrl(url))
            )
                throw new Error('The registry returned a malformed image build record');
            imageBuild = {
                id: build.id,
                state: build.state,
                ...(typeof url === 'string' ? { url } : {}),
            };
        }
        return {
            reference: { publisher: stored.organization_slug, workbench: stored.slug },
            workbenchId: stored.id,
            visibility: stored.visibility,
            versionId: version.id,
            version: version.version,
            digest,
            ...(imageBuild ? { imageBuild } : {}),
        };
    }

    /** Resolves `org/name` with the organization's key. */
    async resolve(
        reference: RegistryReference,
        org?: string
    ): Promise<{ account: RegistryAccount; registry: RegistryPackage }> {
        const account = await this.accountFor(reference, org);
        const registry = await this.accounts.client.resolve(reference, account.token);
        if (!registry) throw await this.accounts.client.missing(reference);
        return { account, registry };
    }

    private accountFor(
        reference: RegistryReference,
        org?: string
    ): Promise<RegistryAccount> {
        if (org && org !== reference.publisher) {
            throw new Error(
                `--org ${org} does not match ${reference.publisher}/${reference.workbench}`
            );
        }
        return this.account(reference.publisher);
    }

    /** Withdraws only an open submission for the named Workbench. */
    async withdraw(reference: RegistryReference, org?: string): Promise<string> {
        const account = await this.accountFor(reference, org);
        const submission = await this.openSubmission(account, reference);
        if (!submission) {
            throw new Error(
                `No open review submission for ${reference.publisher}/${reference.workbench}`
            );
        }
        await this.accounts.client.request<unknown>(
            `/v1/submissions/${encodeURIComponent(submission.id)}`,
            { method: 'DELETE', token: account.token }
        );
        return submission.id;
    }

    /** Lists only open submissions, so this reads a page or two however long the history is. */
    private async openSubmission(
        account: RegistryAccount,
        reference: RegistryReference
    ): Promise<{ id: string } | undefined> {
        for (const status of ['pending', 'changes_requested']) {
            let cursor: string | undefined;
            const visited = new Set<string>();
            do {
                const query = new URLSearchParams({
                    organization_id: account.organizationId,
                    status,
                    ...(cursor ? { cursor } : {}),
                });
                const response = await this.accounts.client.request<unknown>(
                    `/v1/submissions?${query}`,
                    { token: account.token }
                );
                if (
                    !RegistryPublisher.isRecord(response) ||
                    !Array.isArray(response.submissions) ||
                    !(
                        response.next_cursor === undefined ||
                        response.next_cursor === null ||
                        typeof response.next_cursor === 'string'
                    )
                ) {
                    throw new Error(
                        'The registry returned a malformed submission listing'
                    );
                }
                const found = RegistryPublisher.submissions(response.submissions).find(
                    (value) =>
                        value.publisher === reference.publisher &&
                        value.slug === reference.workbench &&
                        value.status === status
                );
                if (found) return found;
                cursor = response.next_cursor ?? undefined;
                // A cursor seen before would page forever.
                if (cursor && visited.has(cursor))
                    throw new Error(
                        'The registry returned a malformed submission listing'
                    );
                if (cursor) visited.add(cursor);
            } while (cursor);
        }
        return undefined;
    }

    private static submissions(values: unknown[]) {
        return values.map((value: unknown) => {
            if (
                !RegistryPublisher.isRecord(value) ||
                typeof value.id !== 'string' ||
                !value.id ||
                typeof value.status !== 'string' ||
                !value.status ||
                typeof value.publisher_slug !== 'string' ||
                !slugPattern.test(value.publisher_slug) ||
                typeof value.slug !== 'string' ||
                !slugPattern.test(value.slug)
            ) {
                throw new Error('The registry returned a malformed submission record');
            }
            return {
                id: value.id,
                status: value.status,
                publisher: value.publisher_slug,
                slug: value.slug,
            };
        });
    }

    async resolveRelease(
        reference: RegistryReference,
        options: { org?: string; version?: string } = {}
    ): Promise<{ account: RegistryAccount; registry: RegistryPackage }> {
        const { account, registry } = await this.resolve(reference, options.org);
        if (!registry.workbenchId) {
            throw new Error(
                'The registry did not report a Workbench id. Cannot list stored versions to publish.'
            );
        }
        const selected = (
            await this.accounts.client.versions(registry.workbenchId, account.token)
        ).release(options.version);
        const exact = await this.accounts.client.resolve(
            { ...reference, version: selected.version },
            account.token
        );
        if (
            !exact ||
            exact.versionId !== selected.id ||
            exact.version !== selected.version
        ) {
            throw new Error('The registry did not resolve the selected version.');
        }
        return { account, registry: exact };
    }

    /** Submits a stored version for public review. */
    async submit(
        account: RegistryAccount,
        version: { id: string; digest: string }
    ): Promise<RegistrySubmission> {
        return this.submission(account, { version_id: version.id }, version.digest);
    }

    private async submission(
        account: RegistryAccount,
        body: Record<string, unknown>,
        digest: string
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
            body,
        });
        const submitted = response.submissions?.[0];
        if (!submitted) throw new Error('The registry returned no submission');
        if (RegistryPublisher.prefixed(submitted.digest) !== digest) {
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
            digest,
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

    /** Permanently deletes one stored version and its image unless still used. */
    async deleteVersion(
        account: RegistryAccount,
        workbenchId: string,
        version: string
    ): Promise<void> {
        const stored = await this.accounts.client.versions(workbenchId, account.token);
        const selected = stored.versions.find((entry) => entry.version === version);
        if (!selected) throw new Error(`Version ${version} is not stored.`);
        await this.accounts.client.request<unknown>(
            `/v1/versions/${encodeURIComponent(selected.id)}`,
            { method: 'DELETE', token: account.token }
        );
    }

    /** Permanently deletes the Workbench, its versions, and its registry images. */
    async delete(account: RegistryAccount, workbenchId: string): Promise<void> {
        await this.accounts.client.request<unknown>(
            `/v1/workbenches/${encodeURIComponent(workbenchId)}`,
            {
                method: 'DELETE',
                token: account.token,
            }
        );
    }

    /** Validates and encodes a package for the registry's wire format. */
    private static async pack(
        account: RegistryAccount,
        workbench: ResolvedWorkbench,
        options: { slug?: string; progress?: (message: string) => void }
    ) {
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
        return {
            slug,
            digest: WorkbenchPackage.digest(files),
            files: {
                format: 1,
                files: files.map((file) => ({
                    path: file.path,
                    content: Buffer.from(file.bytes).toString('base64'),
                    executable: file.executable,
                })),
            },
        };
    }

    private static prefixed(digest: string): string {
        return digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
    }

    /** An http or https address a person can open, such as a build's log page. */
    private static webUrl(value: unknown): value is string {
        if (typeof value !== 'string' || !URL.canParse(value)) return false;
        const { protocol } = new URL(value);
        return protocol === 'https:' || protocol === 'http:';
    }

    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
}
