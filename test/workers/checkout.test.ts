import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkerCheckout } from '../../src/workers/checkout.js';
import { WorkerRejection } from '../../src/workers/contracts.js';
import type { RunWorkspace } from '../../src/workers/protocol.js';
import { bareRepository } from './fixture.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The isolated environment a run gets, with the account's home holding a git identity of its own. */
async function isolation() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-checkout-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
        join(directory, '.gitconfig'),
        '[user]\n\tname = Account Owner\n\temail = owner@example.test\n'
    );
    const config = join(directory, 'run-gitconfig');
    await writeFile(config, '');
    const checkout = join(directory, 'checkout');
    await Bun.write(join(checkout, '.keep'), '');
    return {
        checkout,
        environment: {
            PATH: process.env.PATH,
            HOME: directory,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: config,
            GIT_TERMINAL_PROMPT: '0',
            // Not on the list of what git may read.
            GIT_ASKPASS: '/bin/MUST_NOT_RUN',
        },
    };
}

async function git(directory: string, ...args: string[]): Promise<string> {
    const child = Bun.spawn(['git', ...args], {
        cwd: directory,
        env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null' },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [code, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
    ]);
    return code === 0 ? stdout.trim() : `exit ${code}`;
}

function workspace(overrides: Partial<RunWorkspace>): RunWorkspace {
    return {
        repository: 'acme/game',
        url: 'https://api.example.test/acme/game.git',
        ref: 'main',
        branch: null,
        credential: null,
        ...overrides,
    };
}

describe('worker checkout', () => {
    test('builds the remote with the credential only when there is one', () => {
        expect(
            WorkerCheckout.remote(
                'https://api.example.test/acme/game.git',
                'placeholder-credential'
            )
        ).toBe(
            'https://workbenches:placeholder-credential@api.example.test/acme/game.git'
        );
        expect(WorkerCheckout.remote('https://github.com/acme/game.git', null)).toBe(
            'https://github.com/acme/game.git'
        );
    });

    test('checks out the commit on a branch with the bot identity', async () => {
        const remote = await bareRepository();
        cleanups.push(remote.cleanup);
        const { checkout, environment } = await isolation();
        const commit = await new WorkerCheckout(remote.api).clone(
            workspace({ url: remote.url, ref: remote.commit, branch: 'wb/run_1' }),
            checkout,
            environment
        );
        expect(commit).toBe(remote.commit);
        expect(await readFile(join(checkout, 'notes.txt'), 'utf8')).toBe('first\n');
        expect(await git(checkout, 'rev-parse', 'HEAD')).toBe(remote.commit);
        expect(await git(checkout, 'branch', '--show-current')).toBe('wb/run_1');
        expect(await git(checkout, 'config', '--local', 'user.name')).toBe(
            'Workbenches'
        );
        expect(await git(checkout, 'config', '--local', 'user.email')).toBe(
            'noreply@workbenches.dev'
        );
        expect(await git(checkout, 'config', '--local', 'push.autoSetupRemote')).toBe(
            'true'
        );
        expect(await git(checkout, 'remote', 'get-url', 'origin')).toBe(remote.url);
    });

    test('leaves a run without a branch detached and without an identity', async () => {
        const remote = await bareRepository();
        cleanups.push(remote.cleanup);
        const { checkout, environment } = await isolation();
        await new WorkerCheckout(remote.api).clone(
            workspace({ url: remote.url, ref: remote.commit }),
            checkout,
            environment
        );
        expect(await git(checkout, 'branch', '--show-current')).toBe('');
        // The account's identity in its home is never read or copied.
        expect(await git(checkout, 'config', '--local', '--get', 'user.name')).toBe(
            'exit 1'
        );
    });

    test('presents the credential to the remote and never reports it', async () => {
        const credential = 'MUST_NOT_RENDER_CREDENTIAL';
        const authorizations: Array<string | null> = [];
        const server = Bun.serve({
            port: 0,
            hostname: '127.0.0.1',
            fetch: (request) => {
                const authorization = request.headers.get('authorization');
                authorizations.push(authorization);
                return authorization
                    ? new Response('not found', { status: 404 })
                    : new Response('unauthorized', {
                          status: 401,
                          headers: { 'www-authenticate': 'Basic realm="proxy"' },
                      });
            },
        });
        cleanups.push(() => server.stop(true));
        const { checkout, environment } = await isolation();
        const error = await new WorkerCheckout(`http://127.0.0.1:${server.port}`)
            .clone(
                workspace({
                    url: `http://127.0.0.1:${server.port}/acme/game.git`,
                    credential,
                }),
                checkout,
                environment
            )
            .catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(WorkerRejection);
        const message = error instanceof Error ? error.message : '';
        expect(message).toStartWith('The repository could not be fetched: ');
        expect(message).not.toContain(credential);
        expect(authorizations).toContain(
            `Basic ${Buffer.from(`workbenches:${credential}`).toString('base64')}`
        );
        // The failure names no address with a credential in it, though git prints one.
        expect(message).not.toContain('workbenches:');
    });

    test('scrubs the credential and the userinfo of any address from a message', () => {
        const scrubbed = WorkerCheckout.scrub(
            "fatal: unable to access 'https://workbenches:a%2Fb@host.test/x.git/' with a/b",
            'a/b'
        );
        expect(scrubbed).not.toContain('a/b');
        expect(scrubbed).not.toContain('a%2Fb');
        expect(scrubbed).not.toContain('workbenches:');
        expect(scrubbed).toContain('https://host.test/x.git/');
    });

    test('fetches only from GitHub or its API, and follows no redirect', async () => {
        const remote = await bareRepository();
        cleanups.push(remote.cleanup);
        const { checkout, environment } = await isolation();
        // A repository on this machine, or a server the API did not name.
        const local = `file://${checkout}`;
        for (const url of [local, remote.url, 'ssh://git@github.com/acme/game.git']) {
            await expect(
                new WorkerCheckout('https://api.example.test').clone(
                    workspace({ url, ref: remote.commit }),
                    checkout,
                    environment
                )
            ).rejects.toThrow("is neither GitHub nor this worker's API");
        }
        const requests: string[] = [];
        const redirect = Bun.serve({
            port: 0,
            hostname: '127.0.0.1',
            fetch: (request) => {
                const url = new URL(request.url);
                requests.push(url.pathname);
                const rest = url.pathname.slice('/acme/game.git'.length);
                return Response.redirect(`${remote.url}${rest}${url.search}`, 302);
            },
        });
        cleanups.push(() => redirect.stop(true));
        await expect(
            new WorkerCheckout(`http://127.0.0.1:${redirect.port}`).clone(
                workspace({
                    url: `http://127.0.0.1:${redirect.port}/acme/game.git`,
                    ref: remote.commit,
                }),
                checkout,
                environment
            )
        ).rejects.toThrow('The repository could not be fetched');
        expect(requests.length).toBeGreaterThan(0);
    });

    test('refuses a ref that would be read as an option', async () => {
        const { checkout, environment } = await isolation();
        await expect(
            new WorkerCheckout('https://api.example.test').clone(
                workspace({ ref: '--upload-pack=MUST_NOT_RUN' }),
                checkout,
                environment
            )
        ).rejects.toThrow('The repository could not be fetched');
    });
});
