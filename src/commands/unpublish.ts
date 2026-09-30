import { defineCommand } from 'citty';

import { RegistryClient, RegistryPublisher } from '../registry/index.js';
import { orgArgument, rejectPublisherFlag } from './org-option.js';
import { CliPresenter } from './presenter.js';

export const unpublishCommand = defineCommand({
    meta: {
        name: 'unpublish',
        description: 'Make a public Workbench internal to your organization again.',
    },
    args: {
        workbench: {
            type: 'positional',
            description: 'Registry org/name',
            required: true,
        },
        org: orgArgument,
    },
    async run({ args }) {
        rejectPublisherFlag(args);
        const output = new CliPresenter();
        const reference = RegistryClient.parseReference(args.workbench);
        if (!reference)
            throw new Error('Use a registry org/name, such as acme/ios-expert');
        const publisher = new RegistryPublisher();
        const { account, registry } = await publisher.resolve(reference, args.org);
        if (!registry.workbenchId) {
            throw new Error('The registry did not identify this workbench');
        }
        await publisher.unpublish(account, registry.workbenchId);
        const name = `${reference.publisher}/${reference.workbench}`;
        output.record({
            machine: ['unpublished', name, 'internal'],
            title: `Unpublished ${name} (internal)`,
        });
    },
});
