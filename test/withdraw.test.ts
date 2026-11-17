import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from 'citty';
import { withdrawCommand } from '../src/commands/withdraw.js';
import { RegistryAccountStore } from '../src/registry/index.js';

const homes: string[] = [];
afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});

function submission(
    id: string,
    status: string,
    slug = 'expert',
    publisher = 'example'
) {
    return { id, status, slug, publisher_slug: publisher };
}

/**
 * Answers each listing with the submissions of its status, like the registry;
 * an earlier page can be forced with `cursor`, or every page with `repeat`.
 */
async function fixture(submissions: unknown, cursor?: string, repeat = false) {
    const home = await mkdtemp(join(tmpdir(), 'wb-withdraw-'));
    homes.push(home);
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
                requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
                if (url.pathname === '/v1/submissions') {
                    if (cursor && (repeat || !url.searchParams.has('cursor')))
                        return Response.json({ submissions: [], next_cursor: cursor });
                    const status = url.searchParams.get('status');
                    return Response.json({
                        submissions: Array.isArray(submissions)
                            ? submissions.filter(
                                  (value) =>
                                      value?.status === undefined ||
                                      value.status === status
                              )
                            : submissions,
                    });
                }
                if (url.pathname.startsWith('/v1/submissions/'))
                    return Response.json({ withdrawn: true });
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

for (const status of ['pending', 'changes_requested']) {
    test(`withdraw selects only this Workbench's ${status} submission`, async () => {
        const f = await fixture([
            submission('other', 'pending', 'other'),
            submission('other-org', 'pending', 'expert', 'other'),
            submission('closed', 'approved'),
            submission('selected', status),
        ]);
        try {
            await runCommand(withdrawCommand, {
                rawArgs: ['example/expert', '--org', 'example'],
            });
            expect(f.requests).toEqual([
                'GET /v1/submissions?organization_id=org-id&status=pending',
                ...(status === 'pending'
                    ? []
                    : [
                          'GET /v1/submissions?organization_id=org-id&status=changes_requested',
                      ]),
                'DELETE /v1/submissions/selected',
            ]);
            expect(f.writes.join('')).toContain(
                'withdrawn\texample/expert\tselected\n'
            );
        } finally {
            f.restore();
        }
    });
}

test('withdraw refuses when no submission for the Workbench is open', async () => {
    const f = await fixture([
        submission('closed', 'approved'),
        submission('other', 'pending', 'other'),
    ]);
    try {
        await expect(
            runCommand(withdrawCommand, { rawArgs: ['example/expert'] })
        ).rejects.toThrow('No open review submission for example/expert');
        expect(f.requests).toHaveLength(2);
    } finally {
        f.restore();
    }
});

test('withdraw follows the cursor past a page without the submission', async () => {
    const f = await fixture([submission('selected', 'pending')], 'next');
    try {
        await runCommand(withdrawCommand, { rawArgs: ['example/expert'] });
        expect(f.requests).toEqual([
            'GET /v1/submissions?organization_id=org-id&status=pending',
            'GET /v1/submissions?organization_id=org-id&status=pending&cursor=next',
            'DELETE /v1/submissions/selected',
        ]);
    } finally {
        f.restore();
    }
});

for (const submissions of [null, [{}], [submission('bad', 'pending', '')]]) {
    test('withdraw rejects malformed submission listings without deleting', async () => {
        const f = await fixture(submissions);
        try {
            await expect(
                runCommand(withdrawCommand, { rawArgs: ['example/expert'] })
            ).rejects.toThrow('malformed submission');
            expect(f.requests).toHaveLength(1);
        } finally {
            f.restore();
        }
    });
}

test('withdraw stops on a cursor it has already followed', async () => {
    const f = await fixture([], 'same', true);
    try {
        await expect(
            runCommand(withdrawCommand, { rawArgs: ['example/expert'] })
        ).rejects.toThrow('malformed submission listing');
        expect(f.requests).toHaveLength(2);
    } finally {
        f.restore();
    }
});

test('withdraw rejects a mismatched organization and local sources before requests', async () => {
    const f = await fixture([]);
    try {
        await expect(
            runCommand(withdrawCommand, {
                rawArgs: ['example/expert', '--org', 'other'],
            })
        ).rejects.toThrow('does not match example/expert');
        await expect(
            runCommand(withdrawCommand, { rawArgs: ['.#expert'] })
        ).rejects.toThrow('registry org/name');
        expect(f.requests).toHaveLength(0);
    } finally {
        f.restore();
    }
});
