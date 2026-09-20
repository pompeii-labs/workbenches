import { describe, expect, test } from 'bun:test';
import {
    assertRepositoryBinding,
    parseRepository,
} from '../../src/repositories/contracts.js';
import { RepositoryCredentials } from '../../src/repositories/credentials.js';
import { RepositoryGitHub } from '../../src/repositories/github.js';
import { binding } from './fixture.js';

describe('GitHub repository input and authority', () => {
    test('accepts only GitHub repository slugs and HTTPS URLs', () => {
        for (const name of [
            'example/project',
            'https://github.com/example/project',
            'https://github.com/example/project.git/',
        ])
            expect(parseRepository(name)).toEqual({
                owner: 'example',
                name: 'project',
            });
        for (const name of [
            'example/..',
            'example/.',
            'example/.git',
            'git@github.com:example/project',
            'https://other.example/example/project',
            'https://github.com/example/project?token=secret',
            'example/project/../other',
            'example/project\n',
        ])
            expect(() => parseRepository(name)).toThrow();
    });

    test('validates durable provenance', () => {
        assertRepositoryBinding(binding);
        for (const value of [
            { ...binding, revision: 'main' },
            { ...binding, session_id: '../run' },
            { ...binding, base_branch: '\nmain' },
            { ...binding, default_branch: 123 },
            { ...binding, delivery: 'merge' },
        ])
            expect(() => assertRepositoryBinding(value as typeof binding)).toThrow();
    });

    test('strips GitHub authority and Git overrides without discarding model credentials', async () => {
        const credentials = new RepositoryCredentials({
            GH_TOKEN: 'gh',
            GITHUB_TOKEN: 'github',
            GH_CONFIG_DIR: '/config',
            SSH_AUTH_SOCK: '/socket',
            GIT_CONFIG_VALUE_0: 'poison',
            GIT_DIR: '/poison',
            GIT_AUTHOR_EMAIL: 'someone-else@example.com',
            GIT_COMMITTER_NAME: 'someone-else',
            OPENAI_API_KEY: 'model',
            E2B_API_KEY: 'infrastructure',
            PATH: process.env.PATH,
        });
        expect(await credentials.token(true)).toBe('gh');
        expect(credentials.runnerEnvironment()).toEqual({
            OPENAI_API_KEY: 'model',
            E2B_API_KEY: 'infrastructure',
            PATH: process.env.PATH,
        });
        expect(credentials.controlEnvironment()).toEqual({
            PATH: process.env.PATH,
            GH_CONFIG_DIR: '/config',
        });
        expect(
            await new RepositoryCredentials({
                GH_TOKEN: '',
                GITHUB_TOKEN: 'fallback',
            }).token()
        ).toBe('fallback');
        await expect(
            new RepositoryCredentials({ GH_TOKEN: 'bad\nsecret' }).token()
        ).rejects.toThrow('Invalid GitHub credential');
    });

    test('attributes commits to the authenticated GitHub account without exposing its private email', async () => {
        const response = (createdAt: string) =>
            new RepositoryGitHub('fixture-token', (async (input, init) => {
                expect(String(input)).toBe('https://api.github.com/user');
                expect(new Headers(init?.headers).get('authorization')).toBe(
                    'Bearer fixture-token'
                );
                return Response.json({
                    id: 123,
                    login: 'example',
                    created_at: createdAt,
                    email: 'private@example.com',
                });
            }) as typeof fetch);
        expect(await response('2020-07-01T00:00:00Z').commitIdentity()).toEqual({
            name: 'example',
            email: '123+example@users.noreply.github.com',
        });
        expect(await response('2016-07-01T00:00:00Z').commitIdentity()).toEqual({
            name: 'example',
            email: 'example@users.noreply.github.com',
        });
        await expect(
            new RepositoryGitHub('fixture-token', (async () =>
                Response.json({
                    id: 123,
                    login: 'workbench\n',
                    created_at: 'today',
                })) as unknown as typeof fetch).commitIdentity()
        ).rejects.toThrow('invalid account identity');
    });

    test('pins branch input without requiring write permissions', async () => {
        const paths: string[] = [];
        const client = new RepositoryGitHub('credential', (async (input, init) => {
            const url = new URL(String(input));
            paths.push(url.pathname);
            expect(url.origin).toBe('https://api.github.com');
            expect(init?.redirect).toBe('error');
            expect(new Headers(init?.headers).get('authorization')).toBe(
                'Bearer credential'
            );
            if (url.pathname.endsWith('/branches/feature%2Fpagination'))
                return Response.json({ name: 'feature/pagination' });
            if (url.pathname.includes('/commits/'))
                return Response.json({
                    sha: binding.revision,
                    commit: { tree: { sha: binding.tree } },
                });
            return Response.json({
                default_branch: 'main',
                permissions: { push: false },
            });
        }) as typeof fetch);
        expect(
            await client.resolve(
                {
                    repository: 'example/project',
                    ref: 'feature/pagination',
                },
                binding.session_id
            )
        ).toEqual({ ...binding, base_branch: 'feature/pagination' });
        expect(paths).toHaveLength(3);
        const tagged = new RepositoryGitHub(undefined, (async (input) => {
            const path = new URL(String(input)).pathname;
            if (path.includes('/branches/')) return Response.json({}, { status: 404 });
            if (path.includes('/commits/'))
                return Response.json({
                    sha: binding.revision,
                    commit: { tree: { sha: binding.tree } },
                });
            return Response.json({ default_branch: 'main' });
        }) as typeof fetch);
        expect(
            await tagged.resolve(
                { repository: 'example/project', ref: 'v1.0.0' },
                binding.session_id
            )
        ).toEqual(binding);
    });

    test('never includes response bodies or network errors in diagnostics', async () => {
        const denied = new RepositoryGitHub('credential', (async () =>
            Response.json(
                { secret: 'credential' },
                { status: 401 }
            )) as unknown as typeof fetch);
        await expect(denied.request('example', 'project')).rejects.toThrow('HTTP 401');
        try {
            await denied.request('example', 'project');
        } catch (error) {
            expect(String(error)).not.toContain('credential');
        }
        const redirect = new RepositoryGitHub('credential', (async () => {
            throw new Error('credential at hostile redirect');
        }) as unknown as typeof fetch);
        await expect(redirect.request('example', 'project')).rejects.toThrow(
            'could not be completed'
        );
    });
});
