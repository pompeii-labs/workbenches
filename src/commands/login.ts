import { hostname, platform } from 'node:os';

import { defineCommand } from 'citty';

import { RegistryAccountStore, RegistryClient } from '../registry/index.js';

interface LoginRequest {
    id: string;
    code: string;
    secret: string;
    verification_url: string;
    expires_at: string;
    interval: number;
}

type TokenResponse =
    | { status: 'pending' }
    | {
          status: 'complete';
          token: string;
          token_id: string;
          expires_at: string;
      };

export const loginCommand = defineCommand({
    meta: { name: 'login', description: 'Connect the CLI to workbenches.dev.' },
    args: {
        browser: {
            type: 'boolean',
            description: 'Open the approval page in a browser',
            default: true,
        },
    },
    async run({ args }) {
        const client = new RegistryClient();
        const accounts = new RegistryAccountStore({ client });
        const login = await client.request<LoginRequest>('/v1/logins', {
            method: 'POST',
            body: { label: `${hostname()} (${platform()})` },
        });
        console.log(`Open ${login.verification_url}`);
        console.log(`Confirm code: ${login.code}`);
        if (args.browser) openBrowser(login.verification_url);

        while (new Date(login.expires_at) > new Date()) {
            await wait(login.interval * 1000);
            const result = await client.request<TokenResponse>('/v1/tokens', {
                method: 'POST',
                body: { login_id: login.id, secret: login.secret },
            });
            if (result.status === 'pending') continue;
            const account = {
                url: client.apiUrl,
                token: result.token,
                tokenId: result.token_id,
                email: '',
                expiresAt: result.expires_at,
            };
            const profile = await accounts.profile(account);
            await accounts.save({ ...account, email: profile.user.email });
            console.log(`Signed in as ${profile.user.email}`);
            return;
        }
        throw new Error('The CLI login expired before it was approved');
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

function wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
