import { defineCommand } from 'citty';

import { RegistryClient, RegistryPublisher } from '../registry/index.js';
import { orgArgument, rejectPublisherFlag } from './org-option.js';
import { CliPresenter } from './presenter.js';

export const deleteCommand = defineCommand({
    meta: {
        name: 'delete',
        description:
            'Permanently delete a registry version or a whole Workbench with --yes.',
    },
    args: {
        workbench: {
            type: 'positional',
            description:
                'Registry org/name@version, or org/name for every version and image',
            required: true,
        },
        org: {
            ...orgArgument,
            description: 'Organization slug; must match the registry reference',
        },
        yes: {
            type: 'boolean',
            description:
                'Confirm irreversible deletion, including images no longer in use',
            default: false,
        },
    },
    async run({ args }) {
        rejectPublisherFlag(args);
        const output = new CliPresenter();
        const reference =
            RegistryClient.parseVersionReference(args.workbench) ??
            RegistryClient.parseReference(args.workbench);
        if (!reference)
            throw new Error(
                'Use a registry org/name or org/name@version, such as acme/ios-expert@1.0.0'
            );
        const name = `${reference.publisher}/${reference.workbench}`;
        const target = reference.version ? `${name}@${reference.version}` : name;
        const description = reference.version ? target : `${name} and every version`;
        const imageNotice = reference.version
            ? "The version's image is deleted unless a later version uses it."
            : 'Its registry images are deleted too.';
        const imageResult = reference.version
            ? 'Its image was deleted too, unless a later version uses it.'
            : 'Its registry images were deleted too.';
        if (args.org && args.org !== reference.publisher) {
            throw new Error(`--org ${args.org} does not match ${name}`);
        }
        if (!args.yes) {
            output.message(
                `Would permanently delete ${description}. This cannot be undone. Pass --yes to delete.`,
                'warning'
            );
            output.text(imageNotice);
            return;
        }
        const publisher = new RegistryPublisher();
        const { account, registry } = await publisher.resolve(
            { publisher: reference.publisher, workbench: reference.workbench },
            args.org
        );
        if (!registry.workbenchId) {
            throw new Error('The registry did not identify this workbench');
        }
        if (reference.version) {
            await publisher.deleteVersion(
                account,
                registry.workbenchId,
                reference.version
            );
        } else {
            await publisher.delete(account, registry.workbenchId);
        }
        output.record({
            machine: reference.version
                ? ['deleted', target]
                : ['deleted', name, 'every version'],
            title: `Deleted ${description}`,
        });
        output.text(imageResult);
    },
});
