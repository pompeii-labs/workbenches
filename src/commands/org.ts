import { defineCommand } from 'citty';

import { RegistryAccountStore } from '../registry/index.js';
import { CliPresenter } from './presenter.js';

const listCommand = defineCommand({
    meta: { name: 'list', description: 'List organizations connected to this CLI.' },
    async run() {
        const output = new CliPresenter();
        const { defaultSlug, organizations } = await new RegistryAccountStore().list();
        if (organizations.length === 0) {
            output.empty('No organizations connected. Run wb login.');
            return;
        }
        for (const account of organizations) {
            const expired = new Date(account.expiresAt) <= new Date();
            output.record({
                machine: [
                    'org',
                    account.slug,
                    account.slug === defaultSlug ? 'default' : '',
                    account.expiresAt,
                ],
                title: `${account.slug}${account.slug === defaultSlug ? ' (default)' : ''}`,
                details: [
                    account.name,
                    expired
                        ? `Expired ${account.expiresAt}`
                        : `Expires ${account.expiresAt}`,
                ],
            });
        }
    },
});

const useCommand = defineCommand({
    meta: { name: 'use', description: 'Set the default organization.' },
    args: {
        slug: {
            type: 'positional',
            description: 'Organization slug',
            required: true,
        },
    },
    async run({ args }) {
        await new RegistryAccountStore().setDefault(args.slug);
        new CliPresenter().message(`Default organization: ${args.slug}`, 'success');
    },
});

export const orgCommand = defineCommand({
    meta: { name: 'org', description: 'Manage connected registry organizations.' },
    subCommands: { list: listCommand, use: useCommand },
});
