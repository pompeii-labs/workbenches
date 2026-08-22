import { basename } from 'node:path';

import { defineCommand } from 'citty';

import { registryProfile, registryRequest, requireAccount } from '../account.js';
import { packageDigest, workbenchPackageFiles } from '../catalog.js';
import {
    parseWorkbenchReference,
    resolveLocalSource,
    selectWorkbench,
} from '../source.js';

interface PublicationResponse {
    workbenches: Array<{
        publisher: { slug: string };
        slug: string;
        latest_version: { version: string; digest: string };
    }>;
}

export const publishCommand = defineCommand({
    meta: {
        name: 'publish',
        description: 'Publish an immutable Workbench package to the registry.',
    },
    args: {
        source: {
            type: 'positional',
            description:
                'Local Workbench reference (defaults to the current directory)',
            required: false,
        },
        publisher: {
            type: 'string',
            description: 'Publisher slug',
        },
        as: {
            type: 'string',
            description: 'Registry Workbench slug (defaults to its directory name)',
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
                throw new Error('Create or join a publisher before publishing');
            }
            throw new Error(
                `Choose a publisher with --publisher: ${profile.publishers
                    .map((candidate) => candidate.slug)
                    .join(', ')}`
            );
        }

        const reference = parseWorkbenchReference(args.source ?? '.');
        const source = await resolveLocalSource(reference.source);
        if (!source) throw new Error('wb publish requires a local Workbench');
        const workbench = await selectWorkbench(source.directory, reference.selector);
        const slug = args.as ?? basename(workbench.packageDirectory);
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            throw new Error(`Invalid registry Workbench slug: ${slug}`);
        }
        const files = await workbenchPackageFiles(workbench);
        const total = files.reduce((bytes, file) => bytes + file.bytes.byteLength, 0);
        if (files.length > 256) {
            throw new Error('Workbench package exceeds 256 files');
        }
        if (total > 10 * 1024 * 1024) {
            throw new Error('Workbench package exceeds 10485760 bytes');
        }
        const oversized = files.find((file) => file.bytes.byteLength > 2 * 1024 * 1024);
        if (oversized) {
            throw new Error(`Workbench package file is too large: ${oversized.path}`);
        }

        const digest = packageDigest(files);
        const response = await registryRequest<PublicationResponse>(
            '/v1/publications',
            {
                method: 'POST',
                token: account.token,
                timeout: 60_000,
                body: {
                    organization_id: publisher.id,
                    slug,
                    package: {
                        format: 1,
                        files: files.map((file) => ({
                            path: file.path,
                            content: Buffer.from(file.bytes).toString('base64'),
                            executable: file.executable,
                        })),
                    },
                },
            }
        );
        const published = response.workbenches[0];
        if (!published) throw new Error('The registry returned no Workbench');
        if (`sha256:${published.latest_version.digest}` !== digest) {
            throw new Error('The registry returned a different package digest');
        }
        console.log(
            `published\t${published.publisher.slug}/${published.slug}\t${published.latest_version.version}\t${digest}`
        );
    },
});
