import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CatalogRegistryReference } from '../src/catalog/index.js';
import { RegistryCredentialFile } from '../src/registry/credentials.js';
import { RegistryTelemetry } from '../src/registry/index.js';

const temporaryDirectories: string[] = [];
const registryUrl = 'https://api.workbenches.dev';

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('anonymous registry counters', () => {
    test('reports the exact immutable version without execution content', async () => {
        const home = await temporaryHome();
        let request: Request | undefined;
        const telemetry = new RegistryTelemetry({
            home,
            environment: {},
            notices: { write: () => {} },
            fetch: async (input, init) => {
                request =
                    input instanceof Request
                        ? new Request(input, init)
                        : new Request(
                              input instanceof URL ? input.toString() : input,
                              init
                          );
                return Response.json({ accepted: true }, { status: 202 });
            },
        });
        const accepted = await telemetry.report({
            registry: reference(),
            kind: 'run',
            idempotencyKey: '78c4bf29-7b13-48bb-a2f8-95e933fd03dc',
        });

        expect(accepted).toBeTrue();
        expect(request?.url).toBe('https://api.workbenches.dev/v1/events');
        const body = await request?.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('Expected an event request body');
        }
        expect(body).toMatchObject({
            idempotency_key: '78c4bf29-7b13-48bb-a2f8-95e933fd03dc',
            version_id: '08f3e3ef-4c2c-4b1e-b0fd-b4ca2b6fda11',
            kind: 'run',
        });
        expect(Object.keys(body).sort()).toEqual([
            'cli_version',
            'idempotency_key',
            'kind',
            'occurred_at',
            'version_id',
        ]);
    });

    test('never turns a failed counter request into a CLI failure', async () => {
        const home = await temporaryHome();
        expect(
            await new RegistryTelemetry({
                home,
                environment: {},
                notices: { write: () => {} },
                fetch: async () => {
                    throw new Error('offline');
                },
            }).report({ registry: reference(), kind: 'save' })
        ).toBeFalse();
    });

    test('reports another organization and does not report an own organization', async () => {
        const home = await temporaryHome();
        await holdLogin(home, 'lux');
        const harness = new Harness(home);

        expect(await harness.report(reference({ publisher: 'lux' }))).toBeFalse();
        expect(harness.requests).toBe(0);
        expect(await harness.report(reference({ publisher: 'example' }))).toBeTrue();
        expect(harness.requests).toBe(1);
    });

    test('a login for a different registry does not make a publisher own', async () => {
        const home = await temporaryHome();
        await holdLogin(home, 'example', 'https://registry.example.test');
        const harness = new Harness(home);

        expect(await harness.report(reference({ publisher: 'example' }))).toBeTrue();
    });

    test('never reports a private version', async () => {
        const harness = new Harness(await temporaryHome());

        expect(await harness.report(reference({ visibility: 'private' }))).toBeFalse();
        expect(harness.requests).toBe(0);
        expect(harness.notices).toEqual([]);
        expect(await harness.report(reference({ visibility: 'public' }))).toBeTrue();
    });

    test('DO_NOT_TRACK suppresses every report and the notice', async () => {
        for (const value of ['1', 'true', 'yes']) {
            const harness = new Harness(await temporaryHome(), { DO_NOT_TRACK: value });
            expect(await harness.report(reference())).toBeFalse();
            expect(harness.requests).toBe(0);
            expect(harness.notices).toEqual([]);
        }
        for (const value of ['0', '', undefined]) {
            const harness = new Harness(await temporaryHome(), { DO_NOT_TRACK: value });
            expect(await harness.report(reference())).toBeTrue();
        }
    });

    test('shows the notice once, before the first report', async () => {
        const harness = new Harness(await temporaryHome());

        await harness.report(reference());
        await harness.report(reference());

        expect(harness.notices).toEqual([`${RegistryTelemetry.notice}\n`]);
        expect(RegistryTelemetry.notice).toBe(
            'Workbench reports anonymous save and run counts for registry Workbenches published by other organizations. Set DO_NOT_TRACK=1 to disable.'
        );
        expect(harness.order).toEqual(['notice', 'request', 'request']);
    });
});

describe('sources that are never reported', () => {
    test('only the registry branch of add can report', async () => {
        const source = await Bun.file(
            join(import.meta.dir, '../src/commands/add.ts')
        ).text();
        const reports = source.split('.report(').length - 1;
        const github = source.indexOf('/^https:\\/\\//.test(args.source)');
        expect(reports).toBe(1);
        expect(github).toBeGreaterThan(source.indexOf('.report('));
    });
});

class Harness {
    readonly order: string[] = [];
    readonly notices: string[] = [];
    private readonly telemetry: RegistryTelemetry;

    constructor(home: string, environment: Record<string, string | undefined> = {}) {
        this.telemetry = new RegistryTelemetry({
            home,
            environment,
            notices: {
                write: (text) => {
                    this.order.push('notice');
                    this.notices.push(text);
                },
            },
            fetch: async () => {
                this.order.push('request');
                return Response.json({ accepted: true }, { status: 202 });
            },
        });
    }

    get requests(): number {
        return this.order.filter((entry) => entry === 'request').length;
    }

    report(registry: CatalogRegistryReference): Promise<boolean> {
        return this.telemetry.report({ registry, kind: 'save' });
    }
}

function reference(
    overrides: Partial<CatalogRegistryReference> = {}
): CatalogRegistryReference {
    return {
        url: registryUrl,
        publisher: 'example',
        workbench: 'core',
        version_id: '08f3e3ef-4c2c-4b1e-b0fd-b4ca2b6fda11',
        ...overrides,
    };
}

async function holdLogin(
    home: string,
    slug: string,
    url: string = registryUrl
): Promise<void> {
    await new RegistryCredentialFile(home).write([
        {
            url,
            defaultSlug: slug,
            organizations: [
                {
                    organizationId: `org-${slug}`,
                    slug,
                    name: slug,
                    personal: false,
                    token: 'test-token',
                    keyId: 'key-id',
                    scopes: [],
                    expiresAt: '2999-01-01T00:00:00.000Z',
                },
            ],
        },
    ]);
}

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-telemetry-'));
    temporaryDirectories.push(directory);
    return directory;
}
