import { defineCommand } from 'citty';

import { RegistryAccountStore } from '../registry/index.js';
import { CliPresenter } from './presenter.js';

export const whoamiCommand = defineCommand({
    meta: { name: 'whoami', description: 'Show the connected registry account.' },
    async run() {
        const profile = await new RegistryAccountStore().profile();
        const output = new CliPresenter();
        output.message(profile.user.email, 'info');
        for (const publisher of profile.publishers) {
            output.detail(publisher.slug, publisher.name);
        }
    },
});
