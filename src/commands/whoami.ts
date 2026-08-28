import { defineCommand } from 'citty';

import { RegistryAccountStore } from '../registry/index.js';

export const whoamiCommand = defineCommand({
    meta: { name: 'whoami', description: 'Show the connected registry account.' },
    async run() {
        const profile = await new RegistryAccountStore().profile();
        console.log(profile.user.email);
        for (const publisher of profile.publishers) {
            console.log(`${publisher.slug}\t${publisher.name}`);
        }
    },
});
