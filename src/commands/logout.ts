import { defineCommand } from 'citty';

import { RegistryAccountStore } from '../registry/index.js';

export const logoutCommand = defineCommand({
    meta: { name: 'logout', description: 'Disconnect the CLI from workbenches.dev.' },
    async run() {
        const accounts = new RegistryAccountStore();
        const account = await accounts.current();
        if (!account) {
            console.log('Not signed in');
            return;
        }
        await accounts.client
            .request(`/v1/tokens/${account.tokenId}`, {
                method: 'DELETE',
                token: account.token,
            })
            .catch(() => undefined);
        await accounts.remove();
        console.log('Signed out');
    },
});
