import { defineCommand } from 'citty';

import { registryProfile, requireAccount } from '../account.js';

export const whoamiCommand = defineCommand({
    meta: { name: 'whoami', description: 'Show the connected registry account.' },
    async run() {
        const profile = await registryProfile(await requireAccount());
        console.log(profile.user.email);
        for (const publisher of profile.publishers) {
            console.log(`${publisher.slug}\t${publisher.name}`);
        }
    },
});
