import { defineCommand } from 'citty';

import { currentAccount, deleteAccount, registryRequest } from '../account.js';

export const logoutCommand = defineCommand({
    meta: { name: 'logout', description: 'Disconnect the CLI from workbenches.dev.' },
    async run() {
        const account = await currentAccount();
        if (!account) {
            console.log('Not signed in');
            return;
        }
        await registryRequest(`/v1/tokens/${account.tokenId}`, {
            method: 'DELETE',
            token: account.token,
        }).catch(() => undefined);
        await deleteAccount();
        console.log('Signed out');
    },
});
