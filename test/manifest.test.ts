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
