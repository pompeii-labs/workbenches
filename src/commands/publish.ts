import { defineCommand } from 'citty';

import {
    RegistryClient,
    RegistryPublisher,
    type RegistrySubmission,
} from '../registry/index.js';
import { WorkbenchResolver } from '../workbench/index.js';
import { orgArgument, rejectPublisherFlag } from './org-option.js';
import { CliPresenter } from './presenter.js';
import { presentPushed } from './push.js';

export const publishCommand = defineCommand({
    meta: {
        name: 'publish',
        description: 'Submit a stored Workbench version for public registry review.',
    },
    args: {
        source: {
            type: 'positional',
            description: 'Registry org/name, local package, or saved alias',
            required: true,
        },
        org: orgArgument,
        version: {
            type: 'string',
            description: 'Version to publish (only the latest stored version for now)',
        },
    },
    async run({ args }) {
        rejectPublisherFlag(args);
        const output = new CliPresenter();
        const publisher = new RegistryPublisher();
        const reference = RegistryClient.parseReference(args.source);

        let submission: RegistrySubmission;
        if (reference) {
            const { account, registry } = await publisher.resolve(reference, args.org);
            if (args.version && args.version !== registry.version) {
                throw new Error(
                    `Only the latest version can be published for now: ${reference.publisher}/${reference.workbench} is at ${registry.version}, not ${args.version}`
                );
            }
            output.progress(
                `Submitting ${reference.publisher}/${reference.workbench}@${registry.version}`
            );
            submission = await publisher.submit(account, {
                id: registry.versionId,
                digest: registry.digest,
            });
        } else {
            if (args.version) {
                throw new Error(
                    '--version applies to a registry org/name. A local package publishes the version in its manifest.'
                );
            }
            const { workbench } = await new WorkbenchResolver().resolve(args.source);
            const account = await publisher.account(args.org);
            const pushed = await publisher.push(account, workbench, {
                progress: (message) => output.progress(message),
            });
            presentPushed(output, pushed);
            output.progress(
                `Submitting ${pushed.reference.publisher}/${pushed.reference.workbench}@${pushed.version}`
            );
            submission = await publisher.submit(account, {
                id: pushed.versionId,
                digest: pushed.digest,
            });
        }

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
