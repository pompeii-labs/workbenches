import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addRemoteToCatalog, readCatalog } from '../src/catalog.js';
import {
    fetchGitHubWorkbench,
    fetchGitHubWorkbenches,
    listGitHubWorkbenches,
    parseGitHubRepository,
    resolvedRemoteWorkbench,
} from '../src/github.js';
import { preflightWorkbench } from '../src/preflight.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('GitHub Workbench provider', () => {
    test('normalizes slugs and repository URLs without accepting ambiguous URLs', () => {
        expect(parseGitHubRepository('lux-db/lux')).toEqual({
            owner: 'lux-db',
            repo: 'lux',
            source: 'https://github.com/lux-db/lux',
        });
        expect(parseGitHubRepository('https://github.com/lux-db/lux.git/')).toEqual({
            owner: 'lux-db',
            repo: 'lux',
            source: 'https://github.com/lux-db/lux',
        });
        expect(() => parseGitHubRepository('http://github.com/lux-db/lux')).toThrow(
            'must use HTTPS'
        );
        expect(() => parseGitHubRepository('https://gitlab.com/lux-db/lux')).toThrow(
            'Unsupported remote Workbench host: gitlab.com'
        );
        expect(() =>
            parseGitHubRepository('https://token@github.com/lux-db/lux')
        ).toThrow('may not contain credentials');
        expect(() =>
            parseGitHubRepository('https://github.com/lux-db/lux/tree/main')
        ).toThrow('must identify one repository');
    });

    test('lists manifests entirely through the API and forwards optional auth', async () => {
        const api = githubApiFixture();
        const workbenches = await listGitHubWorkbenches('lux-db/lux', {
            fetch: api.fetch,
            env: { GITHUB_TOKEN: 'secret-token' },
        });

        expect(workbenches).toHaveLength(1);
        expect(workbenches[0]).toMatchObject({
            selector: 'migrations',
            source: 'https://github.com/lux-db/lux',
            revision: 'commit-sha',
            manifest: { name: 'lux-migrations', version: '0.1.0' },
        });
        expect(api.requests.map((request) => request.url)).toEqual([
            'https://api.github.com/repos/lux-db/lux',
            'https://api.github.com/repos/lux-db/lux/commits/main',
            'https://api.github.com/repos/lux-db/lux/git/trees/commit-sha?recursive=1',
            'https://api.github.com/repos/lux-db/lux/git/blobs/manifest-sha',
        ]);
        expect(api.requests[0]?.authorization).toBe('Bearer secret-token');
        expect(JSON.stringify(api.requests)).not.toContain('git clone');
    });

    test('fetches and validates only the selected package in memory', async () => {
        const api = githubApiFixture();
        const workbench = await fetchGitHubWorkbench(
            'https://github.com/lux-db/lux',
            'migrations',
            { fetch: api.fetch, env: {} }
        );

        expect(workbench.files.map((file) => file.path).sort()).toEqual([
            'instructions.md',
            'skills/lux-migrations/SKILL.md',
            'workbench.yml',
        ]);
        expect(workbench.manifest.tools).toEqual(['lux']);
        expect(
            preflightWorkbench(resolvedRemoteWorkbench(workbench), {
                env: {},
                findExecutable: (name) => `/bin/${name}`,
            }).disabledMcps
        ).toEqual(['lux']);
    });

    test('pins registry-backed package inspection to the published commit', async () => {
        const api = githubApiFixture();
        const workbench = await fetchGitHubWorkbench('lux-db/lux', 'migrations', {
            fetch: api.fetch,
            env: {},
            revision: 'published-commit',
        });

        expect(workbench.revision).toBe('commit-sha');
        expect(api.requests.map((request) => request.url).slice(0, 2)).toEqual([
            'https://api.github.com/repos/lux-db/lux/commits/published-commit',
            'https://api.github.com/repos/lux-db/lux/git/trees/commit-sha?recursive=1',
        ]);
    });

    test('writes remote package bytes only when explicitly added', async () => {
        const api = githubApiFixture();
        const workbench = await fetchGitHubWorkbench('lux-db/lux', 'migrations', {
            fetch: api.fetch,
            env: {},
        });
        const home = await temporaryDirectory();
        const entry = await addRemoteToCatalog({
            home,
            alias: 'lux-migrations',
            workbench,
        });

        expect(await readFile(join(entry.packagePath, 'instructions.md'), 'utf8')).toBe(
            '# Migrations\n'
        );
        expect((await readCatalog(home))[0]).toMatchObject({
            alias: 'lux-migrations',
            source: 'https://github.com/lux-db/lux',
            revision: 'commit-sha',
        });
    });

    test('validates every package without requiring a selector', async () => {
        const api = githubApiFixture();
        const workbenches = await fetchGitHubWorkbenches('lux-db/lux', undefined, {
            fetch: api.fetch,
            env: {},
        });
        expect(workbenches.map((workbench) => workbench.selector)).toEqual([
            'migrations',
        ]);
    });

    test.each([
        [401, {}, 'rejected the configured credentials'],
        [403, {}, 'denied access'],
        [404, {}, 'not found or is not accessible'],
        [409, {}, 'has no inspectable commit history'],
        [410, {}, 'is gone'],
        [451, {}, 'unavailable for legal reasons'],
        [429, {}, 'rate limit exceeded'],
        [503, {}, 'GitHub is unavailable'],
        [418, {}, 'could not inspect'],
        [403, { 'x-ratelimit-remaining': '0' }, 'rate limit exceeded'],
    ])('reports GitHub HTTP %i cleanly', async (status, headers, message) => {
        await expect(
            listGitHubWorkbenches('lux-db/lux', {
                fetch: async () => response({}, status, headers),
                env: {},
            })
        ).rejects.toThrow(message);
    });

    test('reports network, malformed, empty, and oversized repository failures', async () => {
        await expect(
            listGitHubWorkbenches('lux-db/lux', {
                fetch: async () => {
                    throw new Error('offline');
                },
                env: {},
            })
        ).rejects.toThrow('Could not reach GitHub');

        await expect(
            listGitHubWorkbenches('lux-db/lux', {
                fetch: async () => new Response('not json'),
                env: {},
            })
        ).rejects.toThrow('malformed response');

        const noBranch = githubApiFixture({ metadata: {} });
        await expect(
            listGitHubWorkbenches('lux-db/lux', {
                fetch: noBranch.fetch,
                env: {},
            })
        ).rejects.toThrow('has no default branch');

        const truncated = githubApiFixture({ truncated: true });
        await expect(
            listGitHubWorkbenches('lux-db/lux', {
                fetch: truncated.fetch,
                env: {},
            })
        ).rejects.toThrow('tree is too large');
    });

    test('rejects missing files, path escapes, and remote symlinks', async () => {
        const missingInstructions = githubApiFixture({ includeInstructions: false });
        await expect(
            fetchGitHubWorkbench('lux-db/lux', 'migrations', {
                fetch: missingInstructions.fetch,
                env: {},
            })
        ).rejects.toThrow('Instructions file does not exist');

        const escaping = githubApiFixture({ instructions: '../../outside.md' });
        await expect(
            fetchGitHubWorkbench('lux-db/lux', 'migrations', {
                fetch: escaping.fetch,
                env: {},
            })
        ).rejects.toThrow('must remain inside the Workbench package');

        const symlink = githubApiFixture({ symlink: true });
        await expect(
            fetchGitHubWorkbench('lux-db/lux', 'migrations', {
                fetch: symlink.fetch,
                env: {},
            })
        ).rejects.toThrow('may not contain symlinks or submodules');
    });
});

interface FixtureOptions {
    metadata?: Record<string, unknown>;
    truncated?: boolean;
    includeInstructions?: boolean;
    instructions?: string;
    symlink?: boolean;
}

function githubApiFixture(options: FixtureOptions = {}) {
    const manifest = manifestSource(options.instructions ?? './instructions.md');
    const skill = [
        '---',
        'name: lux-migrations',
        'description: Operate Lux migrations safely.',
        '---',
        '',
        '# Lux migrations',
        '',
    ].join('\n');
    const blobs: Record<string, string> = {
        'manifest-sha': manifest,
        'instructions-sha': '# Migrations\n',
        'skill-sha': skill,
    };
    const tree = [
        blob('.workbenches/migrations/workbench.yml', 'manifest-sha', manifest),
        ...(options.includeInstructions === false
            ? []
            : [
                  {
                      ...blob(
                          '.workbenches/migrations/instructions.md',
                          'instructions-sha',
                          '# Migrations\n'
                      ),
                      ...(options.symlink ? { mode: '120000' } : {}),
                  },
              ]),
        blob(
            '.workbenches/migrations/skills/lux-migrations/SKILL.md',
            'skill-sha',
            skill
        ),
    ];
    const requests: Array<{ url: string; authorization: string | null }> = [];
    return {
        requests,
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input);
            const headers = new Headers(init?.headers);
            requests.push({ url, authorization: headers.get('Authorization') });
            if (url.endsWith('/repos/lux-db/lux')) {
                return response(options.metadata ?? { default_branch: 'main' });
            }
            if (/\/commits\/(?:main|published-commit)$/.test(url)) {
                return response({ sha: 'commit-sha' });
            }
            if (url.includes('/git/trees/commit-sha')) {
                return response({ tree, truncated: options.truncated ?? false });
            }
            const sha = url.split('/').at(-1);
            const content = sha ? blobs[sha] : undefined;
            if (content === undefined) return response({}, 404);
            return response({
                encoding: 'base64',
                content: Buffer.from(content).toString('base64'),
                size: Buffer.byteLength(content),
            });
        },
    };
}

function manifestSource(instructions: string) {
    return [
        'spec: 0',
        'version: 0.1.0',
        'name: lux-migrations',
        'description: Safely manage Lux migrations.',
        'runner: opencode',
        'model: openrouter/openai/gpt-5.6-terra',
        `instructions: ${instructions}`,
        'skills:',
        '  - ./skills/lux-migrations',
        'tools:',
        '  - lux',
        'mcps:',
        '  - name: lux',
        '    url: https://api.luxdb.dev/mcp',
        '    headers:',
        '      Authorization: Bearer $' + '{LUX_TOKEN}',
        'env:',
        '  LUX_TOKEN:',
        '    required: false',
        'runtime: local',
        '',
    ].join('\n');
}

function blob(path: string, sha: string, contents: string) {
    return {
        path,
        mode: '100644',
        type: 'blob' as const,
        sha,
        size: Buffer.byteLength(contents),
    };
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

async function temporaryDirectory() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-github-'));
    temporaryDirectories.push(directory);
    return directory;
}
