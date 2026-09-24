import { defineCommand } from 'citty';

import { WorkbenchPackage } from '../catalog/index.js';
import { RegistryAccountStore } from '../registry/index.js';
import { WorkbenchResolver } from '../workbench/index.js';
import { CliPresenter } from './presenter.js';

interface PublicationResponse {
    submissions: Array<{
        id: string;
        status: string;
        publisher_slug: string;
        slug: string;
        version: string;
        digest: string;
        dashboard_url: string;
        latest_approved_version: string | null;
    }>;
}

export const publishCommand = defineCommand({
    meta: {
        name: 'publish',
        description: 'Submit a saved Workbench package for registry review.',
    },
    args: {
        source: {
            type: 'positional',
            description: 'Saved Workbench alias',
            required: true,
        },
        publisher: {
            type: 'string',
            description: 'Publisher slug',
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
        const { workbench } = await new WorkbenchResolver().resolve(args.source, {
            savedOnly: true,
        });
        const accounts = new RegistryAccountStore();
        const account = await accounts.require();
        const profile = await accounts.profile(account);
        const publisher = args.publisher
            ? profile.publishers.find((candidate) => candidate.slug === args.publisher)
            : profile.publishers.length === 1
              ? profile.publishers[0]
              : undefined;
        if (!publisher) {
            if (args.publisher) {
                throw new Error(
                    `Publisher is unavailable to this account: ${args.publisher}`
                );
            }
            if (profile.publishers.length === 0) {
                throw new Error('Create or join a publisher before publishing');
            }
            throw new Error(
                `Choose a publisher with --publisher: ${profile.publishers
                    .map((candidate) => candidate.slug)
                    .join(', ')}`
            );
        }

        const slug = workbench.manifest.name;
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            throw new Error(
                `Workbench manifest name is not a valid registry slug: ${slug}`
            );
        }
        output.progress(`Preparing ${publisher.slug}/${slug}`);
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
        output.progress(`Submitting ${publisher.slug}/${slug}`);
        const response = await accounts.client.request<PublicationResponse>(
            '/v1/submissions',
            {
                method: 'POST',
                token: account.token,
                timeout: 60_000,
                body: {
                    organization_id: publisher.id,
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
            }
        );
        const published = response.submissions[0];
        if (!published) throw new Error('The registry returned no submission');
        if (`sha256:${published.digest}` !== digest) {
            throw new Error('The registry returned a different package digest');
        }
        const publishedReference = `${published.publisher_slug}/${published.slug}`;
        output.record({
            machine: [
                'submitted',
                publishedReference,
                published.version,
                digest,
                published.status,
                published.dashboard_url,
                published.id,
                published.latest_approved_version ?? '',
            ],
            title: `Submitted ${publishedReference}: ${published.status}`,
            details: [
                published.version,
                digest,
                published.status === 'approved'
                    ? 'Approved by the registry.'
                    : 'Not published. Review status is available in the dashboard.',
                published.latest_approved_version
                    ? `Latest approved version: ${published.latest_approved_version}`
                    : 'No approved version yet.',
                published.dashboard_url,
            ],
        });
    },
});
