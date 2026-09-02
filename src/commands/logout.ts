import { defineCommand } from 'citty';

import { RegistryAccountStore } from '../registry/index.js';
import { CliPresenter } from './presenter.js';

export const logoutCommand = defineCommand({
    meta: { name: 'logout', description: 'Disconnect the CLI from workbenches.dev.' },
    async run() {
        const output = new CliPresenter();
        const accounts = new RegistryAccountStore();
        const account = await accounts.current();
        if (!account) {
            output.message('Not signed in');
            return;
        }
        await accounts.client
            .request(`/v1/tokens/${account.tokenId}`, {
                method: 'DELETE',
                token: account.token,
            })
            .catch(() => undefined);
        await accounts.remove();
        output.message('Signed out', 'success');
    },
});
