import { defineCommand } from 'citty';
import pc from 'picocolors';
import {
    RegistryAccountStore,
    type RegistryImageProgress,
    RegistryImagePublisher,
} from '../registry/index.js';

export const loginCommand = defineCommand({
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
        const account = await new RegistryAccountStore().require();
        const host = await new RegistryImagePublisher({ account }).login(args.client);
        console.log(`connected\t${host}\t${args.client}`);
    },
});

export const pushCommand = defineCommand({
    meta: {
        name: 'push',
        description: 'Publish a local image to a publisher repository.',
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
        const accounts = new RegistryAccountStore();
        const account = await accounts.require();
        const profile = await accounts.profile(account);
        const target = await new RegistryImagePublisher({
            account,
            profile,
            progress: new ImageProgressRenderer().render,
        }).push({
            image: args.image,
            ...(args.publisher ? { publisher: args.publisher } : {}),
            name: args.as,
            tag: args.tag,
            client: args.client,
        });
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

class ImageProgressRenderer {
    private activeBlob = 0;
    private reported = -1;

    readonly render = (event: RegistryImageProgress): void => {
        if (event.type === 'exporting') {
            process.stderr.write(`${pc.cyan('→')} Exporting local image\n`);
            return;
        }
        if (event.type === 'inspecting') {
            process.stderr.write(`${pc.cyan('→')} Inspecting OCI image\n`);
            return;
        }
        if (event.type === 'planned') {
            const reused = event.blobs - event.missing;
            process.stderr.write(
                `${pc.cyan('→')} ${event.missing} blob${event.missing === 1 ? '' : 's'} to upload${reused ? pc.dim(` · ${reused} already stored`) : ''}\n`
            );
            return;
        }
        if (event.type === 'manifest') {
            process.stderr.write(`${pc.cyan('→')} Publishing image manifest\n`);
            return;
        }
        const percent =
            event.size === 0
                ? 100
                : Math.floor((event.uploaded / event.size) * 10) * 10;
        if (
            event.blob === this.activeBlob &&
            percent === this.reported &&
            percent < 100
        ) {
            return;
        }
        this.activeBlob = event.blob;
        this.reported = percent;
        const kind = event.mediaType.includes('config') ? 'config' : 'layer';
        process.stderr.write(
            `  ${pc.cyan('•')} ${kind} ${event.blob}/${event.blobs} · ${Math.min(percent, 100)}% · ${formatBytes(event.uploaded)} / ${formatBytes(event.size)}\n`
        );
    };
}

function formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    if (value < 1024 * 1024 * 1024) {
        return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
    }
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
