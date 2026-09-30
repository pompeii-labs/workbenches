import { defineCommand } from 'citty';

import { RegistryAccountStore } from '../registry/index.js';
import { CliPresenter } from './presenter.js';

export const logoutCommand = defineCommand({
    meta: {
        name: 'logout',
        description: 'Disconnect an organization from this CLI.',
    },
    args: {
        org: {
            type: 'string',
            description: 'Organization to disconnect (default: the default one)',
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
        const accounts = new RegistryAccountStore();
        const result = await accounts.signOut(args.org);
        if (!result) {
            output.message(
                args.org ? `Not signed in to organization ${args.org}` : 'Not signed in'
            );
            return;
        }
        const { organizations, defaultSlug } = await accounts.list();
        output.message(
            `Signed out of ${result.account.slug}${
                result.revoked ? '' : ' (key could not be revoked on the server)'
            }`,
            'success'
        );
        if (!result.cleared && defaultSlug) {
            output.message(`Default organization: ${defaultSlug}`, 'info');
        }
        if (organizations.length === 0) output.message('No organizations remain');
    },
});
