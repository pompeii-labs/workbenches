import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { WorkbenchPackage } from '../catalog/package.js';
import { CatalogSnapshots } from '../catalog/snapshots.js';
import {
    RegistryClient,
    type RegistryPackage,
    type RegistryReference,
} from '../registry/index.js';
import { SemanticVersion } from '../releases/index.js';
import { Workbench } from '../workbench/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/resolver.js';

const creatorReference: RegistryReference = {
    publisher: 'pompeii',
    workbench: 'creator',
};
const minimumCreatorVersion = '0.1.4';

interface OfficialWorkbenchPointer {
    version: 1;
    package_path: string;
    digest: string;
    workbench_version: string;
    registry: RegistryPackage;
    updated_at: string;
}

interface OfficialWorkbenchDependencies {
    registry?: Pick<RegistryClient, 'resolve' | 'fetchWorkbench'>;
    snapshots?: Pick<CatalogSnapshots, 'materialize'>;
}

export interface ResolvedOfficialWorkbench {
    resolved: ResolvedWorkbenchReference;
    digest: string;
    registry: RegistryPackage;
    cached: boolean;
}

export class OfficialWorkbenchResolver {
    readonly #registry: Pick<RegistryClient, 'resolve' | 'fetchWorkbench'>;
    readonly #snapshots: Pick<CatalogSnapshots, 'materialize'>;

    constructor(
        readonly home: string,
        dependencies: OfficialWorkbenchDependencies = {}
    ) {
        this.#registry = dependencies.registry ?? new RegistryClient();
        this.#snapshots =
            dependencies.snapshots ?? new CatalogSnapshots(join(home, 'official'));
    }

    async creator(workspaceDirectory: string): Promise<ResolvedOfficialWorkbench> {
        try {
            return await this.latest(workspaceDirectory);
        } catch (error) {
            const cached = await this.cached(workspaceDirectory);
            if (cached) return cached;
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
                `The official Workbench creator is unavailable and has not been cached: ${detail}`
            );
        }
    }

    private async latest(
        workspaceDirectory: string
    ): Promise<ResolvedOfficialWorkbench> {
        const registry = await this.#registry.resolve(creatorReference);
        if (!registry) {
            throw new Error('The registry does not publish pompeii/creator');
        }
        if (SemanticVersion.compare(registry.version, minimumCreatorVersion) < 0) {
            throw new Error(
                `Native authoring requires official creator ${minimumCreatorVersion} or newer; the registry publishes ${registry.version}`
            );
        }
        const remote = await this.#registry.fetchWorkbench(registry);
        if (
            remote.manifest.name !== 'workbench-creator' ||
            remote.manifest.version !== registry.version
        ) {
            throw new Error(
                'The official creator artifact does not match its registry record'
            );
        }
        const snapshot = await this.#snapshots.materialize(
            remote.selector,
            remote.files,
            registry.digest
        );
        const pointer: OfficialWorkbenchPointer = {
            version: 1,
            package_path: snapshot.packagePath,
            digest: snapshot.digest,
            workbench_version: remote.manifest.version,
            registry,
            updated_at: new Date().toISOString(),
        };
        await this.writePointer(pointer);
        return this.load(pointer, workspaceDirectory, false);
    }

    private async cached(
        workspaceDirectory: string
    ): Promise<ResolvedOfficialWorkbench | undefined> {
        const source = await readFile(this.pointerPath, 'utf8').catch(() => undefined);
        if (!source) return undefined;
        let value: unknown;
        try {
            value = JSON.parse(source);
        } catch {
            return undefined;
        }
        if (!this.isPointer(value)) return undefined;
        return this.load(value, workspaceDirectory, true).catch(() => undefined);
    }

    private async load(
        pointer: OfficialWorkbenchPointer,
        workspaceDirectory: string,
        cached: boolean
    ): Promise<ResolvedOfficialWorkbench> {
        const fromOfficialRoot = relative(
            resolve(this.officialRoot),
            resolve(pointer.package_path)
        );
        if (
            fromOfficialRoot === '' ||
            fromOfficialRoot.startsWith('..') ||
            isAbsolute(fromOfficialRoot)
        ) {
            throw new Error('The cached official creator path is invalid');
        }
        const workbench = await Workbench.load(pointer.package_path);
        if (
            workbench.manifest.name !== 'workbench-creator' ||
            workbench.manifest.version !== pointer.workbench_version ||
            SemanticVersion.compare(workbench.manifest.version, minimumCreatorVersion) <
                0
        ) {
            throw new Error('The cached official creator does not match its record');
        }
        const digest = WorkbenchPackage.digest(
            await new WorkbenchPackage(workbench).files()
        );
        if (digest !== pointer.digest || pointer.registry.digest !== pointer.digest) {
            throw new Error(
                'The cached official creator failed integrity verification'
            );
        }
        return {
            digest: pointer.digest,
            registry: pointer.registry,
            cached,
            resolved: {
                workbench,
                workspaceDirectory,
                cleanup: async () => {},
                source: 'system',
                registry: {
                    url: pointer.registry.registryUrl,
                    publisher: pointer.registry.reference.publisher,
                    workbench: pointer.registry.reference.workbench,
                    version_id: pointer.registry.versionId,
                },
            },
        };
    }

    private async writePointer(pointer: OfficialWorkbenchPointer): Promise<void> {
        await mkdir(this.officialRoot, { recursive: true, mode: 0o700 });
        const temporary = `${this.pointerPath}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, {
            mode: 0o600,
        });
        await rename(temporary, this.pointerPath);
    }

    private isPointer(value: unknown): value is OfficialWorkbenchPointer {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const registry = Reflect.get(value, 'registry');
        const reference =
            registry !== null && typeof registry === 'object'
                ? Reflect.get(registry, 'reference')
                : undefined;
        return (
            Reflect.get(value, 'version') === 1 &&
            typeof Reflect.get(value, 'package_path') === 'string' &&
            /^sha256:[0-9a-f]{64}$/.test(String(Reflect.get(value, 'digest'))) &&
            typeof Reflect.get(value, 'workbench_version') === 'string' &&
            registry !== null &&
            typeof registry === 'object' &&
            !Array.isArray(registry) &&
            typeof Reflect.get(registry, 'registryUrl') === 'string' &&
            typeof Reflect.get(registry, 'versionId') === 'string' &&
            typeof Reflect.get(registry, 'version') === 'string' &&
            /^sha256:[0-9a-f]{64}$/.test(String(Reflect.get(registry, 'digest'))) &&
            typeof Reflect.get(registry, 'source') === 'string' &&
            typeof Reflect.get(registry, 'selector') === 'string' &&
            typeof Reflect.get(registry, 'revision') === 'string' &&
            reference !== null &&
            typeof reference === 'object' &&
            !Array.isArray(reference) &&
            // Older releases cached the same official publisher under its previous slug.
            (Reflect.get(reference, 'publisher') === creatorReference.publisher ||
                Reflect.get(reference, 'publisher') === 'pompeii-labs') &&
            Reflect.get(reference, 'workbench') === creatorReference.workbench
        );
    }

    private get officialRoot(): string {
        return join(this.home, 'official');
    }

    private get pointerPath(): string {
        return join(this.officialRoot, 'creator.json');
    }
}
