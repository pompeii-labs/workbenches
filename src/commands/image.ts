import { defineCommand } from 'citty';

import { type Account, registryProfile, requireAccount } from '../account.js';
import { registryImageHost } from '../registry.js';

const loginCommand = defineCommand({
    meta: {
        name: 'login',
        description: 'Connect an OCI client to the Workbench image registry.',
    },
    args: {
        client: {
            type: 'string',
            description: 'OCI client executable',
            default: 'docker',
        },
    },
    async run({ args }) {
        const account = await requireAccount();
        await loginClient(args.client, account);
        console.log(`connected\t${registryImageHost()}\t${args.client}`);
    },
});

const pushCommand = defineCommand({
    meta: {
        name: 'push',
        description: 'Tag and push a local image to a publisher repository.',
    },
    args: {
        image: {
            type: 'positional',
            description: 'Local image reference',
            required: true,
        },
        publisher: {
            type: 'string',
            description: 'Publisher slug',
        },
        as: {
            type: 'string',
            description: 'Registry image name',
            required: true,
        },
        tag: {
            type: 'string',
            description: 'Registry image tag',
            default: 'latest',
        },
        client: {
            type: 'string',
            description: 'OCI client executable',
            default: 'docker',
        },
    },
    async run({ args }) {
        const account = await requireAccount();
        const profile = await registryProfile(account);
        const publisher = args.publisher
            ? profile.publishers.find((candidate) => candidate.slug === args.publisher)
            : profile.publishers.length === 1
              ? profile.publishers[0]
              : undefined;
        if (!publisher) {
            if (args.publisher) {
                throw new Error(
                    `Publisher is unavailable to this account: ${args.publisher}`
                );
            }
            if (profile.publishers.length === 0) {
                throw new Error('Create or join a publisher before pushing');
            }
            throw new Error(
                `Choose a publisher with --publisher: ${profile.publishers
                    .map((candidate) => candidate.slug)
                    .join(', ')}`
            );
        }
        const target = imageReference(publisher.slug, args.as, args.tag);
        await loginClient(args.client, account);
        await runClient(args.client, ['tag', args.image, target]);
        await runClient(args.client, ['push', target]);
        console.log(`pushed\t${target}`);
    },
});

export const imageCommand = defineCommand({
    meta: {
        name: 'image',
        description: 'Publish OCI images for Workbench runtimes.',
    },
    subCommands: {
        login: loginCommand,
        push: pushCommand,
    },
});

export function imageReference(publisher: string, name: string, tag: string): string {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(publisher)) {
        throw new Error(`Invalid publisher slug: ${publisher}`);
    }
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)) {
        throw new Error(`Invalid registry image name: ${name}`);
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) {
        throw new Error(`Invalid registry image tag: ${tag}`);
    }
    return `${registryImageHost()}/${publisher}/${name}:${tag}`;
}

async function loginClient(client: string, account: Account): Promise<void> {
    await runClient(
        client,
        ['login', registryImageHost(), '--username', 'workbench', '--password-stdin'],
        account.token
    );
}

async function runClient(
    client: string,
    args: string[],
    input?: string
): Promise<void> {
    let child: ReturnType<typeof Bun.spawn>;
    try {
        child = Bun.spawn([client, ...args], {
            stdin: input === undefined ? 'inherit' : 'pipe',
            stdout: 'inherit',
            stderr: 'inherit',
        });
    } catch (error) {
        throw new Error(
            `${client} could not be started: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (input !== undefined && typeof child.stdin === 'object') {
        child.stdin.write(`${input}\n`);
        child.stdin.end();
    }
    const code = await child.exited;
    if (code !== 0) {
        throw new Error(`${client} exited with code ${code}`);
    }
}
