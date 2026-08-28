import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RegistryAccount, RegistryProfile } from '../account-store.js';
import { RegistryClient } from '../client.js';
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
    profile?: RegistryProfile;
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
        const publisher = this.publisher(options.publisher);
        const target = registryImageReference(
            publisher,
            options.name,
            options.tag,
            this.registry
        );
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
            await this.publish(archive, publisher, options.name, options.tag);
            return target;
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    private publisher(requested: string | undefined): string {
        const profile = this.options.profile;
        if (!profile) throw new Error('Registry profile is required to push an image');
        const publisher = requested
            ? profile.publishers.find((candidate) => candidate.slug === requested)
            : profile.publishers.length === 1
              ? profile.publishers[0]
              : undefined;
        if (publisher) return publisher.slug;
        if (requested) {
            throw new Error(`Publisher is unavailable to this account: ${requested}`);
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
    publisher?: string;
    name: string;
    tag: string;
    client: string;
}
