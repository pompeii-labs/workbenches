import { describe, expect, test } from 'bun:test';

import type { CatalogEntry } from '../src/catalog/index.js';
import { type RegistryPackage, RegistryWorkbenchSaver } from '../src/registry/index.js';

describe('Registry Workbench saving', () => {
    test('does not count an identical registry add as another save', async () => {
        const existing = catalogEntry('lux-auth', 'lux', 'auth');
        let reports = 0;
        let resolved = 0;
        const saver = new RegistryWorkbenchSaver('/tmp/workbench-registry-save', {
            catalog: { list: async () => [existing], addRemote: async () => existing },
            client: {
                resolve: async () => {
                    resolved++;
                    return registryPackage();
                },
                fetchWorkbench: async () => remoteWorkbench(),
            },
            telemetry: {
                report: async () => {
                    reports++;
                    return true;
                },
            },
        });
        expect(await saver.save({ publisher: 'lux', workbench: 'auth' })).toEqual(
            existing
        );
        expect(resolved).toBe(1);
        expect(reports).toBe(0);
    });

    test('saves an immutable registry package under its manifest name', async () => {
        const added: Array<Parameters<Catalog['addRemote']>[0]> = [];
        const reports: unknown[] = [];
        const catalog = new Catalog([]);
        catalog.added = added;
        const saver = new RegistryWorkbenchSaver('/tmp/workbench-registry-save', {
            catalog,
            client: {
                resolve: async () => registryPackage(),
                fetchWorkbench: async () => remoteWorkbench(),
            },
            github: {
                fetch: async () => {
                    throw new Error('GitHub should not be used for an artifact');
                },
            },
            telemetry: {
                report: async (event) => {
                    reports.push(event);
                    return true;
                },
            },
        });

        const entry = await saver.save({ publisher: 'lux', workbench: 'auth' });

        expect(entry.alias).toBe('lux-auth');
        expect(added[0]).toMatchObject({
            alias: 'lux-auth',
            expectedDigest: `sha256:${'b'.repeat(64)}`,
            registry: {
                publisher: 'lux',
                workbench: 'auth',
                version_id: 'version-id',
            },
        });
        expect(reports).toHaveLength(1);
    });

    test('checks current registry bytes instead of silently returning an old package', async () => {
        const existing = catalogEntry('auth', 'lux', 'auth');
        let resolved = 0;
        const saver = new RegistryWorkbenchSaver('/tmp/workbench-registry-save', {
            catalog: new Catalog([existing]),
            client: {
                resolve: async () => {
                    resolved += 1;
                    return registryPackage();
                },
                fetchWorkbench: async () => remoteWorkbench(),
            },
            telemetry: { report: async () => true },
        });

        expect(await saver.save({ publisher: 'lux', workbench: 'auth' })).toMatchObject(
            { alias: 'lux-auth' }
        );
        expect(resolved).toBe(1);
    });

    test('fetches the pinned source revision when the registry has no artifact', async () => {
        let githubRequest: unknown;
        const catalog = new Catalog([]);
        const saver = new RegistryWorkbenchSaver('/tmp/workbench-registry-save', {
            catalog,
            client: {
                resolve: async () => {
                    const { artifactUrl: _artifactUrl, ...registry } =
                        registryPackage();
                    return registry;
                },
                fetchWorkbench: async () => {
                    throw new Error('Registry artifact should not be fetched');
                },
            },
            github: {
                fetch: async (...request) => {
                    githubRequest = request;
                    return remoteWorkbench();
                },
            },
            telemetry: { report: async () => true },
        });

        await saver.save({ publisher: 'lux', workbench: 'auth' });

        expect(githubRequest).toEqual([
            'lux/auth',
            'auth',
            { revision: 'a'.repeat(40) },
        ]);
        expect(catalog.added).toHaveLength(1);
    });

    test('honors an explicit alias without inventing a collision suffix', async () => {
        const catalog = new Catalog([catalogEntry('auth'), catalogEntry('lux-auth')]);
        const saver = new RegistryWorkbenchSaver('/tmp/workbench-registry-save', {
            catalog,
            client: {
                resolve: async () => registryPackage(),
                fetchWorkbench: async () => remoteWorkbench(),
            },
            telemetry: { report: async () => true },
        });

        const entry = await saver.save(
            { publisher: 'lux', workbench: 'auth' },
            'chosen-alias'
        );

        expect(entry.alias).toBe('chosen-alias');
    });
});

class Catalog {
    added: Array<Parameters<Catalog['addRemote']>[0]> = [];

    constructor(private readonly entries: CatalogEntry[]) {}

    async list(): Promise<CatalogEntry[]> {
        return this.entries;
    }

    async addRemote(options: {
        alias: string;
        workbench: ReturnType<typeof remoteWorkbench>;
        expectedDigest?: string;
        registry?: NonNullable<CatalogEntry['registry']>;
    }): Promise<CatalogEntry> {
        this.added.push(options);
        return {
            alias: options.alias,
            name: options.workbench.manifest.name,
            version: options.workbench.manifest.version,
            source: options.workbench.source,
            selector: options.workbench.selector,
            digest: options.expectedDigest ?? `sha256:${'c'.repeat(64)}`,
            packagePath: `/tmp/${options.alias}`,
            addedAt: '2026-09-08T00:00:00.000Z',
            ...(options.registry ? { registry: options.registry } : {}),
        };
    }
}

function registryPackage(): RegistryPackage {
    return {
        reference: { publisher: 'lux', workbench: 'auth' },
        registryUrl: 'https://api.workbenches.dev',
        versionId: 'version-id',
        version: '0.1.0',
        digest: `sha256:${'b'.repeat(64)}`,
        source: 'lux/auth',
        selector: 'auth',
        revision: 'a'.repeat(40),
        artifactUrl: 'https://api.workbenches.dev/v1/artifacts/version-id',
    };
}

function remoteWorkbench() {
    return {
        selector: 'auth',
        source: 'lux/auth',
        revision: 'a'.repeat(40),
        files: [
            { path: 'workbench.yml', bytes: new Uint8Array(), executable: false },
            { path: 'instructions.md', bytes: new Uint8Array(), executable: false },
        ],
        manifest: {
            spec: 0 as const,
            version: '0.1.0',
            name: 'lux-auth',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local' as const,
        },
    };
}

function catalogEntry(
    alias: string,
    publisher?: string,
    workbench?: string
): CatalogEntry {
    return {
        alias,
        name: alias,
        version: '0.1.0',
        source: 'example/source',
        selector: alias,
        digest: `sha256:${'a'.repeat(64)}`,
        packagePath: `/tmp/${alias}`,
        addedAt: '2026-09-08T00:00:00.000Z',
        ...(publisher && workbench
            ? {
                  registry: {
                      url: 'https://api.workbenches.dev',
                      publisher,
                      workbench,
                      version_id: 'existing-version',
                  },
              }
            : {}),
    };
}
