import { defineCommand } from 'citty';

import {
    RegistryAccountStore,
    RegistryClient,
    RegistryLogin,
} from '../registry/index.js';
import { CliPresenter } from './presenter.js';

export const loginCommand = defineCommand({
    meta: { name: 'login', description: 'Connect the CLI to workbenches.dev.' },
    args: {
        browser: {
            type: 'boolean',
            description: 'Open the approval page in a browser',
            default: true,
        },
        org: {
            type: 'string',
            description: 'Organization to connect and make the default',
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
        const client = new RegistryClient();
        const { account, isDefault } = await new RegistryLogin({
            client,
            accounts: new RegistryAccountStore({ client }),
            ...(args.org ? { organization: args.org } : {}),
            onProgress: (message) => output.progress(message),
            onApproval: ({ url, code }) => {
                output.message(`Open ${url}`, 'info');
                output.message(`Confirm code: ${code}`, 'warning');
                if (args.browser) openBrowser(url);
            },
        }).run();
        output.message(
            `Connected organization ${account.slug}${
                account.email ? ` as ${account.email}` : ''
            }${isDefault ? ' (default)' : ''}`,
            'success'
        );
    },
});

function openBrowser(url: string): void {
    const command =
        process.platform === 'darwin'
            ? ['open', url]
            : process.platform === 'win32'
              ? ['cmd', '/c', 'start', '', url]
              : ['xdg-open', url];
    const child = Bun.spawn(command, {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
    });
    child.unref();
}
