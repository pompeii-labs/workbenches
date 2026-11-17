import { defineCommand } from 'citty';
import {
    RegistryAccountStore,
    RegistryClient,
    type RegistryImageProgress,
    RegistryImagePublisher,
} from '../registry/index.js';
import { orgArgument, rejectPublisherFlag } from './org-option.js';
import { CliPresenter } from './presenter.js';

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
        org: orgArgument,
    },
    async run({ args }) {
        rejectPublisherFlag(args);
        const output = new CliPresenter();
        output.progress(`Connecting ${args.client} to the image registry`);
        const account = await new RegistryAccountStore().require(args.org);
        const host = await new RegistryImagePublisher({ account }).login(args.client);
        output.record({
            machine: ['connected', host, args.client],
            title: `Connected ${args.client}`,
            details: [host],
        });
    },
});

export const pushCommand = defineCommand({
    meta: {
        name: 'push',
        description: 'Push a local image once for a stored Workbench version.',
    },
    args: {
        image: {
            type: 'positional',
            description: 'Local image reference',
            required: true,
        },
        workbench: {
            type: 'positional',
            description: 'Registry org/name@version, stored first with wb push',
        },
        org: {
            ...orgArgument,
            description: 'Organization slug; must match org/name@version',
        },
        client: {
            type: 'string',
            description: 'OCI client executable',
            default: 'docker',
        },
    },
    async run({ args }) {
        rejectPublisherFlag(args);
        if ('as' in args || 'tag' in args) {
            throw new Error(
                '--as and --tag were replaced. Use wb image push <local image> <org/name@version>'
            );
        }
        const reference = RegistryClient.parseVersionReference(args.workbench ?? '');
        if (!reference) {
            throw new Error('Use wb image push <local image> <org/name@version>');
        }
        if (args.org && args.org !== reference.publisher) {
            throw new Error(
                `--org ${args.org} does not match ${reference.publisher}/${reference.workbench}`
            );
        }
        const output = new CliPresenter();
        const account = await new RegistryAccountStore().require(reference.publisher);
        const target = await new RegistryImagePublisher({
            account,
            progress: new ImageProgressRenderer(output).render,
        }).push({
            image: args.image,
            reference,
            client: args.client,
        });
        output.record({
            machine: ['pushed', target],
            title: 'Pushed image',
            details: [target],
        });
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

    constructor(private readonly output: CliPresenter) {}

    readonly render = (event: RegistryImageProgress): void => {
        if (event.type === 'exporting') {
            this.output.message('Exporting local image', 'info', 'stderr');
            return;
        }
        if (event.type === 'inspecting') {
            this.output.message('Inspecting OCI image', 'info', 'stderr');
            return;
        }
        if (event.type === 'planned') {
            const reused = event.blobs - event.missing;
            this.output.message(
                `${event.missing} blob${event.missing === 1 ? '' : 's'} to upload${reused ? ` · ${reused} already stored` : ''}`,
                'info',
                'stderr'
            );
            return;
        }
        if (event.type === 'manifest') {
            this.output.message('Publishing image manifest', 'info', 'stderr');
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
        this.output.message(
            `${kind} ${event.blob}/${event.blobs} · ${Math.min(percent, 100)}% · ${formatBytes(event.uploaded)} / ${formatBytes(event.size)}`,
            'muted',
            'stderr'
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
