import { defineCommand } from 'citty';

import { RegistryAccountStore } from '../registry/index.js';
import { CliPresenter } from './presenter.js';

export const whoamiCommand = defineCommand({
    meta: { name: 'whoami', description: 'Show the default registry organization.' },
    async run() {
        const output = new CliPresenter();
        const accounts = new RegistryAccountStore();
        output.progress('Loading registry account');
        const profile = await accounts.profile();
        const { organizations } = await accounts.list();
        output.message(
            `${profile.organization.slug} (${profile.organization.name})`,
            'info'
        );
        if (profile.user) output.detail('user', profile.user.email);
        output.detail('scopes', profile.scopes.join(', '));
        output.detail('key expires', profile.key.expires_at);
        const others = organizations.filter(
            (account) => account.slug !== profile.organization.slug
        );
        for (const account of others) output.detail('also connected', account.slug);
    },
});
