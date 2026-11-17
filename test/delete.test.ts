import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from 'citty';
import { deleteCommand } from '../src/commands/delete.js';
import { RegistryAccountStore } from '../src/registry/index.js';

const homes: string[] = [];
afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

async function fixture(
    options: {
        conflict?: string;
        workbenchId?: boolean;
        login?: boolean;
        versions?: unknown;
    } = {}
) {
    const home = await mkdtemp(join(tmpdir(), 'wb-delete-'));
    homes.push(home);
    if (options.login !== false)
        await new RegistryAccountStore({ home }).save({
            organizationId: 'org-id',
            slug: 'example',
            name: 'Example',
            token: 'wb_test_placeholder',
            keyId: 'key-id',
            expiresAt: '2099-01-01T00:00:00Z',
            personal: false,
            scopes: ['packages:write'],
        });
    const requests: string[] = [];
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
            async (input: string | URL | Request, init?: RequestInit) => {
                const url = new URL(String(input));
                requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
                if (url.pathname === '/v1/resolutions')
                    return Response.json({
                        ...(options.workbenchId === false
                            ? {}
                            : { workbench_id: 'wb-id' }),
                        visibility: 'private',
                        source_path: 'workbench.yml',
                        repository: null,
                        latest_version: {
                            id: 'version-id',
                            version: '1.0.0',
                            digest: 'a'.repeat(64),
                            source_commit: 'b'.repeat(40),
                            artifact_url: null,
                        },
                    });
                if (url.pathname === '/v1/workbenches/wb-id/versions')
                    return Response.json(
                        options.versions ?? {
                            versions: [
                                {
                                    id: 'older-id',
                                    version: '0.9.0',
                                    prerelease: false,
                                    withdrawn: false,
                                },
                                {
                                    id: 'selected-id',
                                    version: '1.0.0+build.7',
                                    prerelease: false,
                                    withdrawn: true,
                                },
                            ],
                        }
                    );
                if (
                    url.pathname === '/v1/workbenches/wb-id' ||
                    url.pathname === '/v1/versions/selected-id'
                )
                    return options.conflict
                        ? Response.json(
                              { error: { message: options.conflict } },
                              { status: 409 }
                          )
                        : new Response(null, { status: 204 });
                throw new Error(`Unexpected request: ${url.pathname}`);
            },
            { preconnect: fetch.preconnect }
        )
    );
    const writes: string[] = [];
    const output = spyOn(process.stdout, 'write').mockImplementation((value) => {
        writes.push(String(value));
        return true;
    });
    const previousHome = process.env.WORKBENCH_HOME;
    process.env.WORKBENCH_HOME = home;
    return {
        requests,
        writes,
        restore() {
            fetcher.mockRestore();
            output.mockRestore();
            if (previousHome === undefined) delete process.env.WORKBENCH_HOME;
            else process.env.WORKBENCH_HOME = previousHome;
        },
    };
}

test('delete without --yes makes no requests and describes the irreversible deletion', async () => {
    const f = await fixture({ login: false });
    try {
        await runCommand(deleteCommand, { rawArgs: ['example/expert'] });
        expect(f.requests).toHaveLength(0);
        const output = f.writes.join('');
        expect(output).toContain('example/expert');
        expect(output).toContain('every version');
        expect(output).toContain('cannot be undone');
        expect(output).toContain('--yes');
        expect(output).toContain('Its registry images are deleted too.');
    } finally {
        f.restore();
    }
});

test('delete --yes resolves and permanently deletes the Workbench', async () => {
    const f = await fixture();
    try {
        await runCommand(deleteCommand, {
            rawArgs: ['example/expert', '--yes', '--org', 'example'],
        });
        expect(f.requests).toEqual([
            'POST /v1/resolutions',
            'DELETE /v1/workbenches/wb-id',
        ]);
        expect(f.writes.join('')).toContain('deleted\texample/expert\tevery version\n');
        expect(f.writes.join('')).toContain('Its registry images were deleted too.');
    } finally {
        f.restore();
    }
});

test('version delete previews without requests or login', async () => {
    const f = await fixture({ login: false });
    try {
        await runCommand(deleteCommand, { rawArgs: ['example/expert@1.0.0+build.7'] });
        expect(f.requests).toHaveLength(0);
        expect(f.writes.join('')).toContain(
            'Would permanently delete example/expert@1.0.0+build.7.'
        );
        expect(f.writes.join('')).toContain('cannot be undone');
        expect(f.writes.join('')).toContain(
            "The version's image is deleted unless a later version uses it."
        );
    } finally {
        f.restore();
    }
});

test('version delete lists stored versions and deletes only the selected id', async () => {
    const f = await fixture();
    try {
        await runCommand(deleteCommand, {
            rawArgs: ['example/expert@1.0.0+build.7', '--yes'],
        });
        expect(f.requests).toEqual([
            'POST /v1/resolutions',
            'GET /v1/workbenches/wb-id/versions',
            'DELETE /v1/versions/selected-id',
        ]);
        expect(f.writes.join('')).toContain('deleted\texample/expert@1.0.0+build.7');
        expect(f.writes.join('')).toContain(
            'Its image was deleted too, unless a later version uses it.'
        );
    } finally {
        f.restore();
    }
});

test('version delete passes registry conflicts through unchanged', async () => {
    for (const message of [
        'Cannot delete a version with unfinished runs',
        'Cannot delete the current public version',
        'Cannot delete the only version',
    ]) {
        const f = await fixture({ conflict: message });
        try {
            await expect(
                runCommand(deleteCommand, {
                    rawArgs: ['example/expert@1.0.0+build.7', '--yes'],
                })
            ).rejects.toThrow(new Error(message));
            expect(f.requests.at(-1)).toBe('DELETE /v1/versions/selected-id');
            expect(f.writes).toHaveLength(0);
        } finally {
            f.restore();
        }
    }
});

test('version delete rejects missing and malformed listings before deleting', async () => {
    for (const versions of [
        { versions: [] },
        { versions: [{ id: 3, version: '1.0.0' }] },
        null,
    ]) {
        const f = await fixture({
            versions: versions === null ? { versions: null } : versions,
        });
        try {
            await expect(
                runCommand(deleteCommand, {
                    rawArgs: ['example/expert@1.0.0+build.7', '--yes'],
                })
            ).rejects.toThrow(
                versions &&
                    Array.isArray(versions.versions) &&
                    versions.versions.length === 0
                    ? 'is not stored'
                    : 'malformed version listing'
            );
            expect(f.requests).toEqual([
                'POST /v1/resolutions',
                'GET /v1/workbenches/wb-id/versions',
            ]);
        } finally {
            f.restore();
        }
    }
});

test('delete passes the unfinished-run conflict message through unchanged', async () => {
    const message = 'Cannot delete this Workbench while any run is unfinished';
    const f = await fixture({ conflict: message });
    try {
        await expect(
            runCommand(deleteCommand, { rawArgs: ['example/expert', '--yes'] })
        ).rejects.toThrow(new Error(message));
        expect(f.requests).toHaveLength(2);
        expect(f.writes).toHaveLength(0);
    } finally {
        f.restore();
    }
});

test('delete refuses a resolution with no Workbench identity', async () => {
    const f = await fixture({ workbenchId: false });
    try {
        await expect(
            runCommand(deleteCommand, { rawArgs: ['example/expert', '--yes'] })
        ).rejects.toThrow('did not identify');
        expect(f.requests).toHaveLength(1);
    } finally {
        f.restore();
    }
});

test('delete rejects local sources and mismatched organizations without requests', async () => {
    const f = await fixture();
    try {
        for (const flags of [[], ['--yes']]) {
            await expect(
                runCommand(deleteCommand, { rawArgs: ['.#expert', ...flags] })
            ).rejects.toThrow('registry org/name');
            await expect(
                runCommand(deleteCommand, {
                    rawArgs: ['example/expert', '--org', 'other', ...flags],
                })
            ).rejects.toThrow('does not match example/expert');
        }
        expect(f.requests).toHaveLength(0);
    } finally {
        f.restore();
    }
});
