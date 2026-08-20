import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveWorkbench } from '../src/manifest.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('spec 0 manifest parser', () => {
    test('resolves the same package from its directory or manifest file', async () => {
        const fixture = await createFixture();
        const fromDirectory = await resolveWorkbench(fixture.packageDirectory);
        const fromFile = await resolveWorkbench(fixture.manifestPath);

        expect(fromDirectory).toEqual(fromFile);
        expect(fromDirectory.manifest).toMatchObject({
            spec: 0,
            version: '0.1.0',
            name: 'fixture-core',
        });
    });

    test('rejects missing and future spec versions without guessing', async () => {
        const missing = await createFixture({
            manifest: validManifest().replace('spec: 0\n', ''),
        });
        const future = await createFixture({
            manifest: validManifest().replace('spec: 0', 'spec: 1'),
        });

        await expect(resolveWorkbench(missing.packageDirectory)).rejects.toThrow(
            'Unsupported Workbench spec: undefined. Supported specs: 0'
        );
        await expect(resolveWorkbench(future.packageDirectory)).rejects.toThrow(
            'Unsupported Workbench spec: 1. Supported specs: 0'
        );
    });

    test('accepts semantic prerelease and build metadata', async () => {
        const fixture = await createFixture({
            manifest: validManifest().replace(
                'version: 0.1.0',
                'version: 1.2.3-rc.1+build.7'
            ),
        });
        const resolved = await resolveWorkbench(fixture.packageDirectory);
        expect(resolved.manifest.version).toBe('1.2.3-rc.1+build.7');
    });

    test('rejects non-semantic package versions', async () => {
        const fixture = await createFixture({
            manifest: validManifest().replace('version: 0.1.0', 'version: latest'),
        });
        await expect(resolveWorkbench(fixture.packageDirectory)).rejects.toThrow(
            'version must be a semantic version'
        );
    });

    test('rejects unknown manifest fields', async () => {
        const fixture = await createFixture({
            manifest: `${validManifest()}surprise: true\n`,
        });
        await expect(resolveWorkbench(fixture.packageDirectory)).rejects.toThrow(
            'Unknown manifest field: surprise'
        );
    });

    test('parses published image references and local image builds', async () => {
        const published = await createFixture({
            manifest: `${validManifest()}image: ghcr.io/example/workbench:0.1.0\n`,
        });
        const localBuild = await createFixture({
            manifest: `${validManifest()}image:\n  build: ./Dockerfile.workbench\n  context: ../..\n`,
        });

        expect(
            (await resolveWorkbench(published.packageDirectory)).manifest.image
        ).toBe('ghcr.io/example/workbench:0.1.0');
        expect(
            (await resolveWorkbench(localBuild.packageDirectory)).manifest.image
        ).toEqual({ build: './Dockerfile.workbench', context: '../..' });
    });

    test('parses only an explicit host engine binding on the Docker runtime', async () => {
        const valid = await createFixture({
            manifest: `${validManifest().replace('runtime: local', 'runtime: docker')}image: alpine:3.22\ndocker:\n  engine:\n    mode: host\n`,
        });
        expect(
            (await resolveWorkbench(valid.packageDirectory)).manifest.docker
        ).toEqual({ engine: { mode: 'host' } });

        const local = await createFixture({
            manifest: `${validManifest()}docker:\n  engine:\n    mode: host\n`,
        });
        await expect(resolveWorkbench(local.packageDirectory)).rejects.toThrow(
            'docker.engine requires runtime: docker'
        );

        const unsupported = await createFixture({
            manifest: `${validManifest().replace('runtime: local', 'runtime: docker')}docker:\n  engine:\n    mode: isolated\n`,
        });
        await expect(resolveWorkbench(unsupported.packageDirectory)).rejects.toThrow(
            'docker.engine.mode must be host'
        );
    });

    test('rejects incomplete and unknown local image build fields', async () => {
        const incomplete = await createFixture({
            manifest: `${validManifest()}image:\n  context: .\n`,
        });
        const unknown = await createFixture({
            manifest: `${validManifest()}image:\n  build: ./Dockerfile\n  platform: linux/amd64\n`,
        });

        await expect(resolveWorkbench(incomplete.packageDirectory)).rejects.toThrow(
            'image.build must be a non-empty string'
        );
        await expect(resolveWorkbench(unknown.packageDirectory)).rejects.toThrow(
            'Unknown image field: platform'
        );
    });

    test('keeps local image build inputs inside the repository', async () => {
        const absolute = await createFixture({
            manifest: `${validManifest()}image:\n  build: /tmp/Dockerfile\n`,
        });
        const escaped = await createFixture({
            manifest: `${validManifest()}image:\n  build: ../../../Dockerfile\n`,
        });

        await expect(resolveWorkbench(absolute.packageDirectory)).rejects.toThrow(
            'image.build must be a relative path'
        );
        await expect(resolveWorkbench(escaped.packageDirectory)).rejects.toThrow(
            'image.build must remain inside the repository'
        );
    });

    test('rejects a missing instructions file', async () => {
        const fixture = await createFixture({ writeInstructions: false });
        await expect(resolveWorkbench(fixture.packageDirectory)).rejects.toThrow(
            'Instructions file does not exist'
        );
    });

    test('rejects absolute instructions paths', async () => {
        const fixture = await createFixture({
            manifest: validManifest().replace(
                'instructions: ./instructions.md',
                'instructions: /tmp/instructions.md'
            ),
        });
        await expect(resolveWorkbench(fixture.packageDirectory)).rejects.toThrow(
            'instructions must be a relative path'
        );
    });

    test('requires packages to live beneath .workbenches', async () => {
        const repositoryDirectory = await mkdtemp(join(tmpdir(), 'workbench-invalid-'));
        temporaryDirectories.push(repositoryDirectory);
        await writeFile(join(repositoryDirectory, 'workbench.yml'), validManifest());
        await writeFile(
            join(repositoryDirectory, 'instructions.md'),
            '# Instructions\n'
        );

        await expect(resolveWorkbench(repositoryDirectory)).rejects.toThrow(
            'Workbench must live beneath a .workbenches directory'
        );
    });

    test('rejects invalid environment names', async () => {
        const fixture = await createFixture({
            manifest: validManifest().replace(
                'env: {}',
                'env:\n  lower_case:\n    required: true'
            ),
        });
        await expect(resolveWorkbench(fixture.packageDirectory)).rejects.toThrow(
            'Invalid environment variable name: lower_case'
        );
    });

    test('defaults an environment declaration to required', async () => {
        const fixture = await createFixture({
            manifest: validManifest().replace('env: {}', 'env:\n  TOKEN: {}'),
        });
        const resolved = await resolveWorkbench(fixture.packageDirectory);
        expect(resolved.manifest.env.TOKEN).toEqual({ required: true });
    });

    test('rejects unknown environment declaration fields', async () => {
        const fixture = await createFixture({
            manifest: validManifest().replace(
                'env: {}',
                'env:\n  TOKEN:\n    secret: true'
            ),
        });
        await expect(resolveWorkbench(fixture.packageDirectory)).rejects.toThrow(
            'Unknown env.TOKEN field: secret'
        );
    });

    test('parses named workspace requirements with safe defaults', async () => {
        const fixture = await createFixture({
            manifest: `${validManifest()}workspaces:\n  api:\n    access: read-write\n  schemas:\n    required: false\n`,
        });
        const resolved = await resolveWorkbench(fixture.packageDirectory);
        expect(resolved.manifest.workspaces).toEqual({
            api: { required: true, access: 'read-write' },
            schemas: { required: false, access: 'read-only' },
        });
    });

    test('rejects invalid workspace names, access, and fields', async () => {
        const invalidName = await createFixture({
            manifest: `${validManifest()}workspaces:\n  Bad_Name: {}\n`,
        });
        const reserved = await createFixture({
            manifest: `${validManifest()}workspaces:\n  primary: {}\n`,
        });
        const invalidAccess = await createFixture({
            manifest: `${validManifest()}workspaces:\n  api:\n    access: host\n`,
        });
        const unknown = await createFixture({
            manifest: `${validManifest()}workspaces:\n  api:\n    path: ../api\n`,
        });

        await expect(resolveWorkbench(invalidName.packageDirectory)).rejects.toThrow(
            'Invalid workspace name: Bad_Name'
        );
        await expect(resolveWorkbench(reserved.packageDirectory)).rejects.toThrow(
            'Invalid workspace name: primary'
        );
        await expect(resolveWorkbench(invalidAccess.packageDirectory)).rejects.toThrow(
            'workspaces.api.access must be read-only or read-write'
        );
        await expect(resolveWorkbench(unknown.packageDirectory)).rejects.toThrow(
            'Unknown workspaces.api field: path'
        );
    });

    test('validates MCP names, URLs, transports, and uniqueness', async () => {
        const invalidName = await createFixture({
            manifest: manifestWithMcp(
                '  - name: Bad Name\n    url: https://example.com/mcp'
            ),
        });
        const invalidUrl = await createFixture({
            manifest: manifestWithMcp('  - name: server\n    url: file:///tmp/mcp'),
        });
        const invalidTransport = await createFixture({
            manifest: manifestWithMcp(
                '  - name: server\n    transport: stdio\n    url: https://example.com/mcp'
            ),
        });
        const duplicate = await createFixture({
            manifest: manifestWithMcp(
                '  - name: server\n    url: https://example.com/one\n  - name: server\n    url: https://example.com/two'
            ),
        });

        await expect(resolveWorkbench(invalidName.packageDirectory)).rejects.toThrow(
            'Invalid MCP name'
        );
        await expect(resolveWorkbench(invalidUrl.packageDirectory)).rejects.toThrow(
            'must use http or https'
        );
        await expect(
            resolveWorkbench(invalidTransport.packageDirectory)
        ).rejects.toThrow('transport must be http');
        await expect(resolveWorkbench(duplicate.packageDirectory)).rejects.toThrow(
            'Duplicate MCP name: server'
        );
    });

    test('resolves a valid portable skill', async () => {
        const fixture = await createFixture({
            manifest: validManifest().replace(
                'skills: []',
                'skills:\n  - ./skills/migrations'
            ),
            skills: {
                migrations:
                    '---\nname: migrations\ndescription: Manage migrations safely.\n---\n\n# Migrations\n',
            },
        });
        const resolved = await resolveWorkbench(fixture.packageDirectory);
        expect(resolved.skills.map((skill) => skill.name)).toEqual(['migrations']);
    });

    test('requires skill frontmatter, description, and matching directory name', async () => {
        const noFrontmatter = await skillFixture('# Missing metadata\n');
        const noDescription = await skillFixture(
            '---\nname: migrations\n---\n\n# Missing description\n'
        );
        const mismatch = await skillFixture(
            '---\nname: other\ndescription: Wrong name.\n---\n'
        );

        await expect(resolveWorkbench(noFrontmatter.packageDirectory)).rejects.toThrow(
            'Skill must begin with YAML frontmatter'
        );
        await expect(resolveWorkbench(noDescription.packageDirectory)).rejects.toThrow(
            'description must be a non-empty string'
        );
        await expect(resolveWorkbench(mismatch.packageDirectory)).rejects.toThrow(
            'Skill name must match its directory: other'
        );
    });

    test('rejects duplicate resolved skills', async () => {
        const fixture = await createFixture({
            manifest: validManifest().replace(
                'skills: []',
                'skills:\n  - ./skills/migrations\n  - ./skills/migrations'
            ),
            skills: {
                migrations:
                    '---\nname: migrations\ndescription: Manage migrations safely.\n---\n',
            },
        });
        await expect(resolveWorkbench(fixture.packageDirectory)).rejects.toThrow(
            'Duplicate skill name: migrations'
        );
    });
});

interface FixtureOptions {
    manifest?: string;
    writeInstructions?: boolean;
    skills?: Record<string, string>;
}

async function createFixture(options: FixtureOptions = {}) {
    const repositoryDirectory = await mkdtemp(join(tmpdir(), 'workbench-manifest-'));
    temporaryDirectories.push(repositoryDirectory);
    const packageDirectory = join(repositoryDirectory, '.workbenches', 'core');
    await mkdir(packageDirectory, { recursive: true });
    const manifestPath = join(packageDirectory, 'workbench.yml');
    await writeFile(manifestPath, options.manifest ?? validManifest());
    if (options.writeInstructions !== false) {
        await writeFile(join(packageDirectory, 'instructions.md'), '# Instructions\n');
    }
    for (const [name, content] of Object.entries(options.skills ?? {})) {
        const directory = join(packageDirectory, 'skills', name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'SKILL.md'), content);
    }
    return { repositoryDirectory, packageDirectory, manifestPath };
}

function validManifest() {
    return [
        'spec: 0',
        'version: 0.1.0',
        'name: fixture-core',
        'runner: opencode',
        'model: openrouter/openai/gpt-5.6-terra',
        'instructions: ./instructions.md',
        'skills: []',
        'tools: []',
        'mcps: []',
        'env: {}',
        'runtime: local',
        '',
    ].join('\n');
}

function manifestWithMcp(mcp: string) {
    return validManifest().replace('mcps: []', `mcps:\n${mcp}`);
}

function skillFixture(content: string) {
    return createFixture({
        manifest: validManifest().replace(
            'skills: []',
            'skills:\n  - ./skills/migrations'
        ),
        skills: { migrations: content },
    });
}
