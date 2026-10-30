import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DockerLogins } from '../../../src/runtimes/docker/logins.js';

let directory: string;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'workbench-docker-logins-'));
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

async function config(value: unknown): Promise<void> {
    await writeFile(join(directory, 'config.json'), JSON.stringify(value));
}

/** A credential helper that answers one registry and fails for any other. */
async function helper(name: string, registry: string): Promise<void> {
    const path = join(directory, `docker-credential-${name}`);
    await writeFile(
        path,
        `#!/bin/sh\nread -r key\nif [ "$key" = "${registry}" ]; then printf '{"ServerURL":"%s","Username":"helper-user","Secret":"helper-secret"}' "$key"; else echo "credentials not found" >&2; exit 1; fi\n`
    );
    await chmod(path, 0o755);
}

function logins(): DockerLogins {
    return new DockerLogins({
        DOCKER_CONFIG: directory,
        PATH: `${directory}:${process.env.PATH ?? ''}`,
    });
}

describe('DockerLogins', () => {
    test('reads a login saved in the config file', async () => {
        await config({
            auths: {
                'ghcr.io': { auth: btoa('octo:saved-secret') },
                'https://index.docker.io/v1/': { auth: btoa('hub:hub-secret') },
            },
        });
        expect(await logins().find('ghcr.io')).toEqual({
            username: 'octo',
            secret: 'saved-secret',
        });
        expect(await logins().find('registry-1.docker.io')).toEqual({
            username: 'hub',
            secret: 'hub-secret',
        });
        expect(await logins().find('quay.io')).toBeUndefined();
    });

    test("asks the registry's credential helper first, then the default store", async () => {
        await helper('fake', 'images.example.test');
        await config({
            credHelpers: { 'images.example.test': 'fake' },
            auths: { 'images.example.test': { auth: btoa('file:file-secret') } },
        });
        expect(await logins().find('images.example.test')).toEqual({
            username: 'helper-user',
            secret: 'helper-secret',
        });
        await config({ credsStore: 'fake' });
        expect(await logins().find('images.example.test')).toEqual({
            username: 'helper-user',
            secret: 'helper-secret',
        });
        expect(await logins().find('ghcr.io')).toBeUndefined();
    });

    test('falls back to the config file when the helper is missing or has no login', async () => {
        await config({
            credsStore: 'absent',
            auths: { 'ghcr.io': { auth: btoa('octo:saved-secret') } },
        });
        expect(await logins().find('ghcr.io')).toEqual({
            username: 'octo',
            secret: 'saved-secret',
        });
    });

    test('has no login without a config file or with a helper name that is not a plain name', async () => {
        expect(await logins().find('ghcr.io')).toBeUndefined();
        await config({ credsStore: '../../bin/sh' });
        expect(await logins().find('ghcr.io')).toBeUndefined();
    });
});
