import { defineCommand } from 'citty';

import { RegistryAccountStore } from '../registry/index.js';
import { CliPresenter } from './presenter.js';

export const whoamiCommand = defineCommand({
    meta: { name: 'whoami', description: 'Show the connected registry account.' },
    async run() {
        const output = new CliPresenter();
        output.progress('Loading registry account');
        const profile = await new RegistryAccountStore().profile();
        output.message(profile.user.email, 'info');
        for (const publisher of profile.publishers) {
            output.detail(publisher.slug, publisher.name);
        }
    },
});
