import { defineCommand } from 'citty';

import { RegistryClient, RegistryPublisher } from '../registry/index.js';
import { orgArgument, rejectPublisherFlag } from './org-option.js';
import { CliPresenter } from './presenter.js';

export const withdrawCommand = defineCommand({
    meta: {
        name: 'withdraw',
        description: 'Withdraw an open Workbench review submission.',
    },
    args: {
        workbench: {
            type: 'positional',
            description: 'Registry org/name whose open review submission to withdraw',
            required: true,
        },
        org: {
            ...orgArgument,
            description: 'Organization slug; must match org/name',
        },
    },
    async run({ args }) {
        rejectPublisherFlag(args);
        const output = new CliPresenter();
        const reference = RegistryClient.parseReference(args.workbench);
        if (!reference)
            throw new Error('Use a registry org/name, such as acme/ios-expert');
        const id = await new RegistryPublisher().withdraw(reference, args.org);
        const name = `${reference.publisher}/${reference.workbench}`;
        output.record({
            machine: ['withdrawn', name, id],
            title: `Withdrew review submission for ${name}`,
            details: [id],
        });
    },
});
