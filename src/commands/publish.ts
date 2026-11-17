import { defineCommand } from 'citty';

import { RegistryClient, RegistryPublisher } from '../registry/index.js';
import { orgArgument, rejectPublisherFlag } from './org-option.js';
import { CliPresenter } from './presenter.js';

export const publishCommand = defineCommand({
    meta: {
        name: 'publish',
        description: 'Submit a stored release for public review.',
    },
    args: {
        source: {
            type: 'positional',
            description: 'Registry org/name, pushed first with wb push',
            required: true,
        },
        org: {
            ...orgArgument,
            description: 'Organization slug; must match org/name',
        },
        version: {
            type: 'string',
            description:
                'The newest stored release, named exactly; fails if a newer one exists',
        },
    },
    async run({ args }) {
        rejectPublisherFlag(args);
        const output = new CliPresenter();
        const publisher = new RegistryPublisher();
        const reference = RegistryClient.parseReference(args.source);

        if (!reference) {
            throw new Error(
                'wb publish takes a registry org/name. Push the package with wb push first, then publish it.'
            );
        }
        const { account, registry } = await publisher.resolveRelease(reference, {
            ...(args.org === undefined ? {} : { org: args.org }),
            ...(args.version === undefined ? {} : { version: args.version }),
        });
        output.progress(
            `Submitting ${reference.publisher}/${reference.workbench}@${registry.version}`
        );
        const submission = await publisher.submit(account, {
            id: registry.versionId,
            digest: registry.digest,
        });

        const publishedReference = `${submission.reference.publisher}/${submission.reference.workbench}`;
        output.record({
            machine: [
                'submitted',
                publishedReference,
                submission.version,
                submission.digest,
                submission.status,
                submission.dashboardUrl,
                submission.id,
                submission.latestApprovedVersion ?? '',
            ],
            title: `Submitted ${publishedReference}: ${submission.status}`,
            details: [
                submission.version,
                submission.digest,
                submission.status === 'approved'
                    ? 'Approved by the registry.'
                    : 'Not public yet. Review status is available in the dashboard.',
                submission.latestApprovedVersion
                    ? `Latest approved version: ${submission.latestApprovedVersion}`
                    : 'No approved version yet.',
                submission.dashboardUrl,
            ],
        });
    },
});
