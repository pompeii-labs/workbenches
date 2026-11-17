import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RegistryAccount } from '../account-store.js';
import { RegistryClient, type RegistryReference } from '../client.js';
import { OciArchive } from './archive.js';
import { OciRegistryClient } from './client.js';
import { registryImageReference } from './reference.js';

export type RegistryImageProgress =
    | { type: 'exporting' }
    | { type: 'inspecting' }
    | { type: 'planned'; blobs: number; missing: number }
    | {
          type: 'uploading';
          blob: number;
          blobs: number;
          mediaType: string;
          uploaded: number;
          size: number;
      }
    | { type: 'manifest' };

export type OciClientRunner = (
    client: string,
    args: string[],
    input?: string
) => Promise<void>;

export interface RegistryImagePublisherOptions {
    account: RegistryAccount;
    registry?: RegistryClient;
    run?: OciClientRunner;
    fetch?: typeof fetch;
    progress?: (event: RegistryImageProgress) => void;
}

export class RegistryImagePublisher {
    private readonly registry: RegistryClient;
    private readonly run: OciClientRunner;

    constructor(private readonly options: RegistryImagePublisherOptions) {
        this.registry = options.registry ?? new RegistryClient();
        this.run = options.run ?? RegistryImagePublisher.runClient;
    }

    async login(client: string): Promise<string> {
        await this.run(
            client,
            [
                'login',
                this.registry.imageHost,
                '--username',
                'workbench',
                '--password-stdin',
            ],
            this.options.account.token
        );
        return this.registry.imageHost;
    }

    async push(options: RegistryImagePushOptions): Promise<string> {
        const { publisher, workbench, version } = options.reference;
        if (publisher !== this.options.account.slug) {
            throw new Error(
                `Image organization ${publisher} does not match ${this.options.account.slug}`
            );
        }
        const tag = version.replace(/[^A-Za-z0-9._-]/g, '_');
        const target = registryImageReference(publisher, workbench, tag, this.registry);
        const stored = await this.registry.resolve(
            options.reference,
            this.options.account.token
        );
        if (!stored) {
            throw new Error(
                `Version ${publisher}/${workbench}@${version} is not stored. Push the package with wb push first.`
            );
        }
        if (stored.version !== version) {
            throw new Error('The registry did not resolve the selected version.');
        }
        const directory = await mkdtemp(join(tmpdir(), 'workbench-image-push-'));
        const archive = new OciArchive(join(directory, 'image.tar'));
        try {
            this.options.progress?.({ type: 'exporting' });
            await this.run(options.client, [
                'image',
                'save',
                '--output',
                archive.path,
                options.image,
            ]);
            await this.publish(archive, publisher, workbench, tag);
            return target;
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    private async publish(
        archive: OciArchive,
        publisher: string,
        imageName: string,
        tag: string
    ): Promise<void> {
        this.options.progress?.({ type: 'inspecting' });
        const image = await archive.inspect();
        const client = new OciRegistryClient({
            origin: this.registry.imageOrigin,
            host: this.registry.imageHost,
            publisher,
            image: imageName,
            accountToken: this.options.account.token,
            ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
        });
        const missing = new Set<string>();
        for (const blob of image.blobs) {
            if (!(await client.hasBlob(blob.digest))) missing.add(blob.digest);
        }
        this.options.progress?.({
            type: 'planned',
            blobs: image.blobs.length,
            missing: missing.size,
        });
        if (missing.size > 0) {
            const total = missing.size;
            let position = 0;
            await archive.visit(async (entry) => {
                const digest = OciArchive.digestFromPath(entry.header.name);
                if (!digest || !missing.has(digest)) {
                    entry.resume();
                    return;
                }
                const descriptor = image.blobs.find(
                    (candidate) => candidate.digest === digest
                );
                if (!descriptor) {
                    entry.resume();
                    return;
                }
                if (entry.header.size !== descriptor.size) {
                    throw new Error(
                        `OCI blob ${digest} does not match its declared size`
                    );
                }
                position += 1;
                await client.uploadBlob(entry, descriptor, (uploaded) =>
                    this.options.progress?.({
                        type: 'uploading',
                        blob: position,
                        blobs: total,
                        mediaType: descriptor.mediaType,
                        uploaded,
                        size: descriptor.size,
                    })
                );
                missing.delete(digest);
            });
        }
        if (missing.size > 0) {
            throw new Error(
                `Docker image archive is missing ${[...missing].join(', ')}`
            );
        }
        this.options.progress?.({ type: 'manifest' });
        await client.putManifest(tag, image.mediaType, image.manifest);
    }

    private static async runClient(
        client: string,
        args: string[],
        input?: string
    ): Promise<void> {
        let child: ReturnType<typeof Bun.spawn>;
        try {
            child = Bun.spawn([client, ...args], {
                stdin: input === undefined ? 'ignore' : 'pipe',
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
        if (code !== 0) throw new Error(`${client} exited with code ${code}`);
    }
}

export interface RegistryImagePushOptions {
    image: string;
    reference: RegistryReference & { version: string };
    client: string;
}
