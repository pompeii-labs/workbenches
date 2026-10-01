import { defineCommand } from 'citty';

import {
    RegistryPublisher,
    type RegistryPushedVersion,
    registryVisibilityLabel,
} from '../registry/index.js';
import { WorkbenchResolver } from '../workbench/index.js';
import { orgArgument, rejectPublisherFlag } from './org-option.js';
import { CliPresenter } from './presenter.js';

export const pushCommand = defineCommand({
    meta: {
        name: 'push',
        description: 'Store a new Workbench version in your organization, internal.',
    },
    args: {
        source: {
            type: 'positional',
            description: 'Local package (.#name, /path#name) or saved alias',
            required: false,
        },
        org: orgArgument,
        as: {
            type: 'string',
            description: 'Registry name (defaults to the manifest name)',
        },
    },
    async run({ args }) {
        rejectPublisherFlag(args);
        const output = new CliPresenter();
        const { workbench } = await new WorkbenchResolver().resolve(args.source ?? '.');
        const publisher = new RegistryPublisher();
        const account = await publisher.account(args.org);
        presentPushed(
            output,
            await publisher.push(account, workbench, {
                ...(args.as ? { slug: args.as } : {}),
                progress: (message) => output.progress(message),
            })
        );
    },
});

export function presentPushed(output: CliPresenter, pushed: RegistryPushedVersion) {
    const reference = `${pushed.reference.publisher}/${pushed.reference.workbench}`;
    output.record({
        machine: ['push', reference, pushed.version, pushed.digest],
        title: `Pushed ${reference}@${pushed.version} (${registryVisibilityLabel(pushed.visibility)})`,
        details: [pushed.digest],
    });
}
